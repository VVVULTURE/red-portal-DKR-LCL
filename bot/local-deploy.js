'use strict';

/**
 * Red Portal — deploy a crawled game to R2 (Node port of sync_to_r2.py)
 * =====================================================================
 * The Python sync walked a full local checkout and mirrored it to R2. In the
 * merged/Koyeb build there is no local library — only the one game folder the
 * pipeline just wrote into an ephemeral temp dir. So this does the minimal,
 * ADDITIVE thing:
 *
 *   1. Walk LOCAL_REPO_PATH (the temp work dir; holds only new Testing/<game>).
 *   2. PutObject every file to R2 at its relative key (path-based keys, exactly
 *      like sync_to_r2.py: the R2 key mirrors the relative path).
 *   3. Fetch the live manifest.json, merge the new keys in, put it back — so the
 *      new game shows up via the manifest fast-path immediately.
 *
 * It NEVER deletes or prunes, so it can't touch the 20k+ games already on R2.
 * Credentials are R2 WRITE keys (config R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY),
 * separate from the server's read-only R2_LIST_* keys.
 */

const fs   = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const {
  LOCAL_REPO_PATH,
  TESTING_DIR,
  GAMES_DIR,
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_DOMAIN,
} = require('./config');

/* ── unchanged helpers from the original local-deploy.js ─────────────────── */

function toLocalFolderName(name) {
  return String(name).trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-');
}

function gameFolderExists(gameName) {
  return fs.existsSync(path.join(TESTING_DIR, toLocalFolderName(gameName)));
}

function listLocalTestingFolders() {
  try {
    return fs.readdirSync(TESTING_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
}

function listLocalGamesFolders() {
  try {
    return fs.readdirSync(GAMES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
}

/** Live manifest.json → Games/Testing folder names, for duplicate checks. */
async function fetchRemoteManifestFolders() {
  const gamesFolders = new Set(), testingFolders = new Set();
  try {
    const res = await fetch(`https://${R2_PUBLIC_DOMAIN}/manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = await res.json();
    for (const relPath of Object.keys(manifest)) {
      const [top, folder] = relPath.split('/');
      if (!folder) continue;
      if (top === 'Games') gamesFolders.add(folder);
      else if (top === 'Testing') testingFolders.add(folder);
    }
  } catch (err) {
    console.warn('[deploy] Could not fetch remote manifest.json for dup check:', err.message);
  }
  return { gamesFolders: [...gamesFolders], testingFolders: [...testingFolders] };
}

function writeGameFilesLocally(gameName, files) {
  const folderName = toLocalFolderName(gameName);
  const destDir = path.join(TESTING_DIR, folderName);
  fs.mkdirSync(destDir, { recursive: true });
  for (const [relPath, data] of Object.entries(files)) {
    const safeRel = relPath.replace(/^\/+/, '').split('/').join(path.sep);
    const outPath = path.join(destDir, safeRel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data.bytes);
  }
  const fileCount = Object.keys(files).length;
  console.log(`[deploy] ✓ Wrote ${fileCount} file(s) → ${destDir}`);
  return { destDir, folderName, fileCount };
}

/* ── Node R2 sync (replaces spawning sync_to_r2.py) ──────────────────────── */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
function contentType(p) { return CONTENT_TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

let _s3 = null;
function s3() {
  if (_s3) return _s3;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 write credentials missing (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)');
  }
  _s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return _s3;
}

/** Recursively list every file under a dir as { abs, key } (key = forward-slash relative path). */
function walk(root) {
  const out = [];
  (function rec(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) rec(abs);
      else if (e.isFile()) out.push({ abs, key: path.relative(root, abs).split(path.sep).join('/') });
    }
  })(root);
  return out;
}

/** Upload everything currently in LOCAL_REPO_PATH to R2, then merge manifest.json. */
async function runR2Sync() {
  const client = s3();
  const files = walk(LOCAL_REPO_PATH);
  if (!files.length) { console.warn('[deploy] Nothing to sync (work dir empty).'); return; }
  console.log(`[deploy] Uploading ${files.length} file(s) to R2 bucket ${R2_BUCKET}…`);

  // Upload with small concurrency.
  const CONC = 5;
  let i = 0;
  async function worker() {
    while (i < files.length) {
      const { abs, key } = files[i++];
      await client.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: key, Body: fs.readFileSync(abs), ContentType: contentType(abs),
      }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, files.length) }, worker));
  console.log('[deploy] ✓ Files uploaded.');

  // Merge into the live manifest so the fast-path lists the new game.
  let manifest = {};
  try {
    const res = await fetch(`https://${R2_PUBLIC_DOMAIN}/manifest.json`, { cache: 'no-cache' });
    if (res.ok) manifest = await res.json();
  } catch (err) {
    console.warn('[deploy] Could not fetch manifest.json to merge (starting from just-uploaded keys):', err.message);
  }
  for (const { key } of files) manifest[key] = `https://${R2_PUBLIC_DOMAIN}/${key}`;
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: 'manifest.json',
    Body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
    ContentType: 'application/json; charset=utf-8',
  }));
  console.log(`[deploy] ✓ manifest.json updated (${Object.keys(manifest).length} entries).`);
}

module.exports = {
  toLocalFolderName, gameFolderExists,
  listLocalTestingFolders, listLocalGamesFolders,
  fetchRemoteManifestFolders, writeGameFilesLocally, runR2Sync,
};
