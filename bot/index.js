'use strict';

/**
 * Red Portal bot — integration entry for the merged server build.
 * ================================================================
 * server.js calls into this instead of running a separate bot process.
 * Everything is GATED on config: if the bot env vars aren't set, these are
 * safe no-ops and the website is completely unaffected. Nothing here can
 * crash the HTTP server — the gateway start and the pipeline are isolated.
 */

const config = require('./config');

let gatewayStarted = false;

/** Start the Discord gateway (the /request slash command). Non-fatal. */
async function startGateway() {
  if (!config.GATEWAY_READY) {
    console.log('[bot] Discord gateway disabled — set BOT_TOKEN, GUILD_ID, REQUEST_CHANNEL_ID to enable.');
    return false;
  }
  try {
    await require('./discord-bot').start();
    gatewayStarted = true;
    return true;
  } catch (err) {
    console.error('[bot] Discord gateway failed to start (site unaffected):', err.message);
    return false;
  }
}

/**
 * Handle a game request from the website form (server.js /api/request).
 * Fire-and-forget: the pipeline logs + notifies Discord as it goes.
 * @returns {{ ok: boolean, reason?: string }}
 */
function handleRequest(request) {
  if (!config.PIPELINE_READY) {
    return { ok: false, reason: 'bot-not-configured' };
  }
  const { runPipeline } = require('./pipeline');
  const { notifyInfo }  = require('./discord');
  setImmediate(async () => {
    try {
      await runPipeline(request);
    } catch (err) {
      console.error(`[bot] Unhandled pipeline error for "${request && request.name}":`, err);
      try { await notifyInfo(`❌ Unhandled pipeline error for **${request && request.name}**: ${err.message}`); } catch (_) {}
    }
  });
  return { ok: true };
}

/**
 * Handle a bug report from the website (server.js /api/report).
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function handleReport(report) {
  if (!config.DISCORD_WEBHOOK) return { ok: false, reason: 'bot-not-configured' };
  const { notifyReport } = require('./discord');
  await notifyReport(report);
  return { ok: true };
}

module.exports = {
  startGateway,
  handleRequest,
  handleReport,
  get pipelineReady() { return config.PIPELINE_READY; },
  get reportReady()   { return !!config.DISCORD_WEBHOOK; },
  get gatewayReady()  { return config.GATEWAY_READY; },
  get gatewayStarted() { return gatewayStarted; },
};
