'use strict';

/**
 * Red Portal bot — configuration (merged-into-server build)
 * =========================================================
 * PUBLIC REPO: this file contains NO secret values. Every secret is read
 * from an environment variable with no fallback, so nothing sensitive is
 * ever committed. Set the values as env vars on the host (Koyeb):
 *
 *   BOT_TOKEN              Discord bot token           (required for the /request slash command)
 *   BOT_SECRET            shared secret with the site  (required; must match server.js)
 *   DISCORD_WEBHOOK       channel webhook URL          (required for notifications)
 *   REQUEST_CHANNEL_ID    channel id for /request      (required for the slash command)
 *   GUILD_ID              Discord server id            (required for the slash command)
 *   GITHUB_TOKEN          GitHub PAT                   (optional — only raises search rate limit)
 *   R2_ACCOUNT_ID         Cloudflare account id        (required to upload games)
 *   R2_ACCESS_KEY_ID      R2 WRITE access key          (required to upload games)
 *   R2_SECRET_ACCESS_KEY  R2 WRITE secret              (required to upload games)
 *
 * Non-secret settings keep public defaults. Local dev can use a .env file
 * (dotenv is loaded if present); on Koyeb the platform injects the vars.
 */

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const path = require('path');
const os   = require('os');

module.exports = {
  // ── Secrets: env-only, NO fallback ────────────────────────────────────────
  BOT_SECRET:         process.env.BOT_SECRET,
  BOT_TOKEN:          process.env.BOT_TOKEN,
  REQUEST_CHANNEL_ID: process.env.REQUEST_CHANNEL_ID,
  GUILD_ID:           process.env.GUILD_ID,
  GITHUB_TOKEN:       process.env.GITHUB_TOKEN || '',        // optional; empty = unauthenticated search
  DISCORD_WEBHOOK:    process.env.DISCORD_WEBHOOK,
  R2_ACCOUNT_ID:        process.env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID:     process.env.R2_ACCESS_KEY_ID,        // R2 WRITE key (distinct from server's R2_LIST_* read key)
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,

  // ── Non-secret config: public defaults are fine ───────────────────────────
  GITHUB_USERNAME:    process.env.GITHUB_USERNAME || 'VVVULTURE',
  RED_PORTAL_OWNER:   process.env.RED_PORTAL_OWNER || 'VVVULTURE',
  RED_PORTAL_REPO:    process.env.RED_PORTAL_REPO  || 'red-portal-DKR-LCL',
  RED_PORTAL_BRANCH:  process.env.RED_PORTAL_BRANCH || 'main',
  PROXY_URL:          process.env.PROXY_URL || 'https://redportal.dpdns.org/rp/',
  R2_BUCKET:          process.env.R2_BUCKET        || 'red-portal-assets',
  R2_PUBLIC_DOMAIN:   process.env.R2_PUBLIC_DOMAIN || 'assets.redportal.dpdns.org',

  MAX_DEPLOY_RETRIES: 3,
  DEPLOY_POLL_MS:     5000,
  DEPLOY_TIMEOUT_MS:  120000,

  // ── Work dir: ephemeral scratch space. Games are written here, uploaded to
  //    R2, and the container filesystem is disposable — nothing persists here.
  LOCAL_REPO_PATH:    process.env.LOCAL_REPO_PATH || path.join(os.tmpdir(), 'rp-bot-work'),
  get TESTING_DIR() { return path.join(this.LOCAL_REPO_PATH, 'Testing'); },
  get GAMES_DIR()   { return path.join(this.LOCAL_REPO_PATH, 'Games'); },

  /** True when the bot has enough config to notify Discord + upload games. */
  get PIPELINE_READY() {
    return !!(this.DISCORD_WEBHOOK && this.R2_ACCOUNT_ID && this.R2_ACCESS_KEY_ID && this.R2_SECRET_ACCESS_KEY);
  },
  /** True when the Discord gateway (slash command) can start. */
  get GATEWAY_READY() {
    return !!(this.BOT_TOKEN && this.REQUEST_CHANNEL_ID && this.GUILD_ID);
  },
};
