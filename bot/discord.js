'use strict';

const { DISCORD_WEBHOOK } = require('./config');

/**
 * Send a message to the Red Portal Discord via webhook.
 * @param {string} content   Plain text or markdown message.
 * @param {object[]} [embeds] Optional Discord embeds array.
 */
async function sendDiscord(content, embeds) {
  if (!DISCORD_WEBHOOK) {
    console.warn('[discord] DISCORD_WEBHOOK not set — skipping notification.');
    return;
  }

  const body = JSON.stringify(embeds ? { content, embeds } : { content });

  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[discord] Webhook returned ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error('[discord] Failed to send webhook:', err.message);
  }
}

/** Notify that a request couldn't be added automatically and needs a person to handle it. */
async function notifyNeedsHuman(gameName, reason) {
  await sendDiscord(
    `🤖 **Couldn't Add Automatically**\n` +
    `> **Game/service:** ${gameName}\n` +
    `> **Why:** ${reason}\n\n` +
    `This needs a person to find and add it by hand.`
  );
}

/** Notify that a game was successfully crawled, written locally, and synced to R2. */
async function notifyAdded(gameName, folderName) {
  await sendDiscord(
    `✅ **Added to Testing**\n` +
    `> **Game:** ${gameName}\n` +
    `> **Folder:** Testing/${folderName}\n\n` +
    `Files are written and synced to R2 — it'll show up in the 🧪 Testing tab within a few seconds, no reload needed.`
  );
}

/**
 * A bug report from the site. Deliberately NOT part of the pipeline:
 * a request asks for something to be added and has work to do, a report
 * says something is already broken and only needs a person to see it.
 * Straight to Discord, nothing queued.
 */
async function notifyReport(report) {
  const lines = [
    `🐞 **Bug Report** — ${report.kind}`,
    `> **What:** ${report.summary}`,
  ];
  if (report.where)     lines.push(`> **Game / page:** ${report.where}`);
  if (report.reporter)  lines.push(`> **From:** ${report.reporter}`);
  if (report.pageUrl)   lines.push(`> **Reported from:** <${report.pageUrl}>`);
  if (report.userAgent) lines.push(`> **Browser:** \`${report.userAgent}\``);
  await sendDiscord(lines.join('\n'));
}

/** General info message. */
async function notifyInfo(message) {
  await sendDiscord(`ℹ️ ${message}`);
}

/**
 * Notify that a request is a console/ROM game -- distinct from
 * notifyNeedsHuman: this isn't "search failed", it's "don't search at all,
 * this needs a real ROM you'll have to source yourself and drop into
 * Emulation/<Console>/ on R2".
 */
async function notifyNeedsRom(gameName, guessedConsole) {
  await sendDiscord(
    `🕹️ **Needs a ROM — Can't Auto-Add**\n` +
    `> **Game:** ${gameName}\n` +
    `> **Console:** ${guessedConsole || 'not specified'}\n\n` +
    `This is a console game, not a browser game, so there's nothing to search for or crawl. ` +
    `Drop a legitimate ROM into \`Emulation/${guessedConsole || '<Console>'}/\` (or flat into ` +
    `\`Emulation/\` to auto-detect the console) and it'll show up on the next sync.`
  );
}

module.exports = { sendDiscord, notifyNeedsHuman, notifyAdded, notifyInfo, notifyNeedsRom, notifyReport };
