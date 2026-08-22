/**
 * Red Portal — Local Static Server
 * =================================
 * Serves Red Portal and all bundled games as static files. Games live under
 * Games/ and Testing/ and load via relative paths — nothing is proxied or
 * fetched from an external origin at runtime.
 *
 * Run:  node server.js          (default port 3001)
 *       PORT=8080 node server.js (custom port)
 *
 * The static files (index.html, assets/, Games/, Testing/) are served from
 * this same directory.
 */

'use strict';

const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
const url   = require('url');

/* ── Config ────────────────────────────────────────────────────── */
const PORT       = parseInt(process.env.PORT || '3001', 10);
const STATIC     = __dirname;           // serve files from the same folder as server.js
// URL of the bot's HTTP listener, e.g. http://192.168.1.50:3000/post-request
const BOT_URL    = process.env.BOT_URL    || 'https://boneless-parcel-reputable.ngrok-free.dev/post-request';
// Shared secret — must match BOT_SECRET in bot.js to prevent unauthorized posts
const BOT_SECRET = process.env.BOT_SECRET || '0fffaa699dd1422eac9cf419d1649f8ff9b346d9594450c51987ba8a61003ba3';

/* ── R2-backed folders ──────────────────────────────────────────
   Games/ and Testing/ now live in Cloudflare R2, not on this server's
   disk (see .dockerignore — they're excluded from the Docker build
   entirely). Any request whose path starts with one of these prefixes
   gets a 302 redirect straight to R2, using the exact same relative
   path the sync script uploaded objects under. Once the browser lands
   on the R2 URL, every relative asset the game itself requests (JS,
   images, audio, WASM) resolves against R2 automatically — no paths
   in index.html or inside any individual game's files need to change.

   If R2_PUBLIC_DOMAIN is left unset, this feature is a no-op and the
   server falls back to serving Games/Testing from local disk exactly
   like before — safe default for local dev without R2 configured.   */
// Self-ping — keeps the Render free-tier instance from spinning down due to
// inactivity. Every SELF_PING_INTERVAL_MS, the server requests its own
// /health endpoint over HTTPS. Purely operational; no effect on the site's
// look or behavior. Set SELF_PING_ENABLED=false to disable.
const SELF_PING_ENABLED       = (process.env.SELF_PING_ENABLED || 'true').toLowerCase() !== 'false';
const SELF_PING_URL           = process.env.SELF_PING_URL || 'https://redportal.dpdns.org/health';
const SELF_PING_INTERVAL_MS   = parseInt(process.env.SELF_PING_INTERVAL_MS || String(10 * 60 * 1000), 10); // 10 minutes

const R2_PUBLIC_DOMAIN   = process.env.R2_PUBLIC_DOMAIN || '';
const R2_BACKED_PREFIXES = (process.env.R2_BACKED_PREFIXES || 'Games,Testing,Movies')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function r2BackedPrefix(pathname) {
  // pathname from url.parse always starts with '/'
  for (const prefix of R2_BACKED_PREFIXES) {
    if (pathname === '/' + prefix || pathname.startsWith('/' + prefix + '/')) {
      return prefix;
    }
  }
  return null;
}

/* ── R2 bucket listing (auto-discovery) ────────────────────────────
   Separate, READ-ONLY credentials from the ones sync_to_r2.py uses to
   write -- this API token should be scoped to "Object Read" only in
   the Cloudflare dashboard. Used to auto-populate the Games/Testing
   grids and the Movies tab straight from whatever's actually in the
   bucket, so adding a folder or uploading a video needs zero code or
   index.html changes -- just refresh the page.

   If these aren't set, the corresponding /api/* endpoints return an
   empty list rather than erroring, so the site still works (just
   without auto-discovery) if this step hasn't been configured yet.  */
const R2_ACCOUNT_ID          = process.env.R2_ACCOUNT_ID || '';
const R2_LIST_ACCESS_KEY_ID  = process.env.R2_LIST_ACCESS_KEY_ID || '';
const R2_LIST_SECRET_ACCESS_KEY = process.env.R2_LIST_SECRET_ACCESS_KEY || '';
const R2_BUCKET               = process.env.R2_BUCKET || '';

let s3Client = null;
function getS3Client() {
  if (s3Client) return s3Client;
  if (!R2_ACCOUNT_ID || !R2_LIST_ACCESS_KEY_ID || !R2_LIST_SECRET_ACCESS_KEY || !R2_BUCKET) {
    return null;
  }
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_LIST_ACCESS_KEY_ID,
      secretAccessKey: R2_LIST_SECRET_ACCESS_KEY,
    },
  });
  return s3Client;
}

/* List "folders" directly under a prefix, e.g. listR2Folders('Games/')
   returns ['Baldis-Basics-Plus', 'Balatro', ...] using S3's delimiter
   trick (CommonPrefixes) rather than fetching every object.           */
/* ── Locate each game's real index.html and build the auto-populated
   grid data ──────────────────────────────────────────────────────
   Some game folders have index.html right at their root; others have
   it nested (e.g. a build output subfolder), and a few vendor an
   entire "related games" widget several levels deep, meaning MULTIPLE
   unrelated games' index.html files can exist under one folder.

   This does ONE full recursive listing of everything under Games/ or
   Testing/ (no delimiter), groups every index.html found by its
   top-level folder, and picks the SHALLOWEST one per folder as that
   game's entry point -- correct for a simple nested build folder, and
   normally correct for the "multiple vendored games" case too, since
   the intended target is typically the shallowest index.html. A
   folder with more than one index.html at the same shallowest depth
   is genuinely ambiguous; it still picks a deterministic result
   (alphabetical) and logs a warning so you can pin the correct one
   via game-overrides.json if it guessed wrong.

   Display name defaults to the folder name with dashes turned into
   spaces (e.g. "there-is-no-game" -> "there is no game"), unless
   overridden.                                                        */
async function listR2GameFolders(topPrefix) {
  const client = getS3Client();
  if (!client) return [];
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

  const byFolder = new Map(); // folder -> [{ subPath, depth }, ...]

  let continuationToken;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: topPrefix,             // e.g. "Games/" -- deliberately NO Delimiter,
      ContinuationToken: continuationToken,  // we need every nested object to find index.html
    });
    const resp = await client.send(cmd);
    for (const obj of resp.Contents || []) {
      const rest = obj.Key.slice(topPrefix.length); // "Baldis-Basics-Plus/_cdn/.../index.html"
      const slashIdx = rest.indexOf('/');
      if (slashIdx === -1) continue; // stray file directly under the prefix, not inside a folder
      const folder  = rest.slice(0, slashIdx);
      const subPath = rest.slice(slashIdx + 1);
      if (!/index\.html?$/i.test(subPath)) continue; // only care about index.html candidates
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push({
        subPath,
        depth: subPath.split('/').length, // 1 = directly in the folder root
      });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  const overrides = getGameOverrides();
  const results = [];

  for (const [folder, candidates] of byFolder.entries()) {
    candidates.sort((a, b) => a.depth - b.depth || a.subPath.localeCompare(b.subPath));
    const chosen = candidates[0];

    if (candidates.length > 1 && candidates[1].depth === chosen.depth) {
      console.warn(
        `  ⚠  Ambiguous index.html under ${topPrefix}${folder}/ -- picked "${chosen.subPath}" ` +
        `out of ${candidates.length} candidates at the shallowest depth. ` +
        `Add an entry to game-overrides.json if this picked the wrong one.`
      );
    }

    const override = overrides[folder] || {};
    const name = override.name || folder.replace(/-/g, ' ');
    const relPath = override.path || chosen.subPath;

    results.push({
      folder,
      name,
      href: `${topPrefix}${folder}/${relPath}`,
    });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/* List files directly under a prefix (no delimiter -- flat listing),
   used for Movies/. Filters to video extensions and skips anything in
   a subfolder.                                                        */
async function listR2Files(prefix, extRegex) {
  const client = getS3Client();
  if (!client) return [];
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

  const files = [];
  let continuationToken;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      Delimiter: '/',   // still use delimiter so subfolders don't leak in as files
      ContinuationToken: continuationToken,
    });
    const resp = await client.send(cmd);
    for (const obj of resp.Contents || []) {
      const name = obj.Key.slice(prefix.length);
      if (name && extRegex.test(name)) files.push(name);
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  return files;
}

/* Simple in-memory cache so every page load doesn't hit R2's API --
   a new game folder or movie shows up within CACHE_TTL_MS of the next
   request after it's uploaded. Short TTLs here + the client-side
   auto-refresh polling in index.html (see renderGameGrid) together mean
   a freshly-synced game shows up in the browser within seconds, with no
   manual page reload needed — not just "next time the site boots up".  */
const CACHE_TTL_MS_GAMES  = parseInt(process.env.GAMES_CACHE_TTL_MS  || String(15 * 1000), 10);  // 15s
const CACHE_TTL_MS_MOVIES = parseInt(process.env.MOVIES_CACHE_TTL_MS || String(15 * 1000), 10);  // 15s
const listCache = new Map(); // key -> { data, expires }

async function cachedList(key, ttlMs, fetcher) {
  const now = Date.now();
  const hit = listCache.get(key);
  if (hit && hit.expires > now) return hit.data;
  const data = await fetcher();
  listCache.set(key, { data, expires: now + ttlMs });
  return data;
}

/* ── Optional overrides ────────────────────────────────────────────
   game-overrides.json (repo root, optional) can override either the
   display name, the exact index.html path, or both, per folder:
     { "Baldis-Basics-Plus": { "name": "Baldi's Basics Plus",
                                "path": "_cdn/abc123/baldi-plus/index.html" } }
   Anything not listed is fully automatic (dash->space name, shallowest
   index.html found). This file is tiny and stays in git.              */
let _gameOverrides = null;
function getGameOverrides() {
  if (_gameOverrides) return _gameOverrides;
  try {
    const raw = fs.readFileSync(path.join(STATIC, 'game-overrides.json'), 'utf8');
    _gameOverrides = JSON.parse(raw);
  } catch {
    _gameOverrides = {};
  }
  return _gameOverrides;
}

/* ── Keep-alive agents — reuse TCP connections to upstream targets ─
   Without these, every proxied request opens a fresh TCP connection
   (+ TLS handshake for HTTPS), adding ~100-300 ms of latency.         */
const httpAgent  = new http.Agent ({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

/* ── MIME map for static files ─────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.mov':  'video/quicktime',
  '.ogv':  'video/ogg',
  '.mkv':  'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml',
  '.wasm': 'application/wasm',
};

/* ── Cache-Control values per extension ────────────────────────── */
const CACHE_CONTROL = {
  '.html': 'no-cache',                         // always revalidate HTML
  '.htm':  'no-cache',
  '.js':   'public, max-age=3600',             // 1 h — JS may change between deploys
  '.css':  'public, max-age=3600',
  '.json': 'no-cache',
  '.gif':  'public, max-age=604800',           // 7 days — large assets (intro, themes)
  '.png':  'public, max-age=604800',
  '.jpg':  'public, max-age=604800',
  '.jpeg': 'public, max-age=604800',
  '.webp': 'public, max-age=604800',
  '.mp3':  'public, max-age=604800',
  '.mp4':  'public, max-age=604800',
  '.webm': 'public, max-age=604800',
  '.svg':  'public, max-age=86400',
  '.ico':  'public, max-age=86400',
  '.woff': 'public, max-age=31536000',         // 1 year — fonts never change
  '.woff2':'public, max-age=31536000',
  '.ttf':  'public, max-age=31536000',
  '.otf':  'public, max-age=31536000',
};

/* ── CORS + framing headers ─────────────────────────────────────── *
   Frozen constant instead of a function-per-request. Previously a new
   object was allocated and GC'd on every request. Spread it with
   { ...CORS_HEADERS } when you need to add extra keys.               */
const CORS_HEADERS = Object.freeze({
  'access-control-allow-origin':   '*',
  'access-control-allow-methods':  'GET, POST, OPTIONS, HEAD, PUT, PATCH, DELETE',
  'access-control-allow-headers':  '*',
  'access-control-expose-headers': '*',
  'access-control-max-age':        '86400',
  'cross-origin-resource-policy':  'cross-origin',
  'cross-origin-embedder-policy':  'unsafe-none',
  'cross-origin-opener-policy':    'unsafe-none',
  'x-frame-options':               'ALLOWALL',
  'content-security-policy':       '',
  'vary':                          'Origin',
});

/* ── Parse a JSON request body ─────────────────────────────────── */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => {
      try   { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/* ── Forward a request payload to the local bot ────────────────── */
function forwardToBot(payload) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const parsed  = new URL(BOT_URL);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      agent:    isHttps ? httpsAgent : httpAgent,
      headers:  {
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(body),
        // Shared secret so the bot rejects requests from anything else
        'x-bot-secret':   BOT_SECRET,
      },
    };

    const req = lib.request(options, res => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error('Bot returned HTTP ' + res.statusCode));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Bot request timed out — is it running?'));
    });
    req.end(body);
  });
}

/* ── Handle POST /api/request ──────────────────────────────────── */
async function handleGameRequest(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', ...CORS_HEADERS });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  // Validate content-type
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    res.writeHead(415, { 'content-type': 'application/json', ...CORS_HEADERS });
    return res.end(JSON.stringify({ error: 'Expected application/json' }));
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json', ...CORS_HEADERS });
    return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }

  const name = (body.name || '').toString().trim().slice(0, 120);
  if (!name) {
    res.writeHead(400, { 'content-type': 'application/json', ...CORS_HEADERS });
    return res.end(JSON.stringify({ error: 'name is required' }));
  }

  if (!BOT_URL) {
    console.error('  ✗  BOT_URL is not set — request dropped.');
    res.writeHead(503, { 'content-type': 'application/json', ...CORS_HEADERS });
    return res.end(JSON.stringify({ error: 'Bot not configured on server' }));
  }

  const payload = {
    name,
    type:      ['Game', 'Service', 'Other'].includes(body.type) ? body.type : 'Game',
    notes:     body.notes      ? body.notes.toString().trim().slice(0, 500)  : null,
    submitter: body.submitter  ? body.submitter.toString().trim().slice(0, 80) : null,
  };

  try {
    await forwardToBot(payload);
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error('  ✗  Bot forward error:', err.message);
    res.writeHead(502, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'Failed to reach bot — try again later.' }));
  }
}


/* ── In-memory cache for index.html (the SPA shell) ────────────── *
   index.html is read from disk once and kept in memory.  Every SPA
   fallback (404 → index.html) was previously a full fs.readFile call;
   now it's a Buffer copy — orders of magnitude faster under load.    */
let _indexCache = null;
function getIndex(cb) {
  if (_indexCache) return cb(null, _indexCache);
  fs.readFile(path.join(STATIC, 'index.html'), (err, data) => {
    if (!err) _indexCache = data;
    cb(err, data);
  });
}

function serveStatic(req, res, filePath, isR2Backed) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Games/Testing paths must 404 for real when the file isn't found --
      // NEVER silently substitute the portal's own homepage here. Doing so
      // used to break openGame()'s blob-loading feature in index.html:
      // fetch() would get a 200 OK containing Red Portal's own HTML instead
      // of a real 404, so it had no way to know the game was missing and
      // ended up opening a blob of the homepage instead of the game.
      if (isR2Backed) {
        res.writeHead(404, { 'content-type': 'text/plain', ...CORS_HEADERS });
        return res.end('Game file not found');
      }
      // Everything else (portal routes) still gets the SPA fallback.
      getIndex((e, data) => {
        if (e) {
          res.writeHead(404, { 'content-type': 'text/plain', ...CORS_HEADERS });
          return res.end('Not found');
        }
        res.writeHead(200, {
          'content-type':  'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          ...CORS_HEADERS,
        });
        res.end(data);
      });
      return;
    }
    const ext          = path.extname(filePath).toLowerCase();
    const mime         = MIME[ext] || 'application/octet-stream';
    const cacheControl = CACHE_CONTROL[ext] || 'public, max-age=3600';

    // Range requests — required for smooth <video> seeking (movies/tutorials).
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end   = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= stat.size) end = stat.size - 1;
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'content-range': `bytes */${stat.size}`, ...CORS_HEADERS });
          return res.end();
        }
        res.writeHead(206, {
          'content-type':   mime,
          'content-range':  `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges':  'bytes',
          'content-length': end - start + 1,
          'cache-control':  cacheControl,
          ...CORS_HEADERS,
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }

    res.writeHead(200, {
      'content-type':   mime,
      'content-length': stat.size,
      'accept-ranges':  'bytes',
      'cache-control':  cacheControl,
      ...CORS_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ── Build a fully-qualified absolute origin from the incoming request ──
   Every href handed back by /api/games, /api/testing, and /api/movies is
   a complete absolute URL (https://redportal.dpdns.org/Games/...), never
   a bare relative path -- relative paths were breaking asset loading in
   some games once opened as a blob: URL with an injected <base> tag,
   since root-relative asset references (src="/assets/x.png") resolve
   against the origin's root rather than the game's own folder regardless
   of <base>. Built from the request's actual Host header rather than a
   hardcoded string so this is still correct in local dev (localhost)
   as well as production, without needing a separate config value.       */
function getRequestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host  = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

/* ── GET /api/movies — list playable video files from the Movies/ prefix on R2 ──
   Dropping a video straight into the bucket's Movies/ folder and reloading the
   page is all it takes to add a movie -- no redeploy needed. Falls back to an
   empty list (not an error) if R2 listing credentials aren't configured.      */
const VIDEO_RE = /\.(mp4|m4v|webm|ogg|ogv|mov|mkv)$/i;
async function handleMovies(req, res) {
  try {
    const origin = getRequestOrigin(req);
    const files = await cachedList('movies', CACHE_TTL_MS_MOVIES, () => listR2Files('Movies/', VIDEO_RE));
    const movies = files
      .sort((a, b) => a.localeCompare(b))
      .map(f => ({
        file: f,
        name: f.replace(/\.[^.]+$/, ''),
        url: `${origin}/Movies/${encodeURIComponent(f)}`, // absolute -- was a bare relative path before
      }));
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(movies));
  } catch (e) {
    console.error('  ✗  /api/movies R2 listing error:', e.message);
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end('[]'); // fail soft -- an empty Movies tab beats a broken page
  }
}

/* ── GET /api/games and /api/testing — auto-populate the game grids
   straight from what's actually in the R2 bucket. Dropping a new game
   folder into Games/ or Testing/ and reloading Red Portal is all it
   takes -- no index.html edits, no redeploy. See listR2GameFolders()
   for how the entry-point index.html is located inside each folder.  */
async function handleGameList(req, res, topPrefix) {
  try {
    const origin = getRequestOrigin(req);
    const games = await cachedList(topPrefix, CACHE_TTL_MS_GAMES, () => listR2GameFolders(topPrefix));
    const absolute = games.map(g => ({ ...g, href: `${origin}/${g.href}` })); // relative -> absolute
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(absolute));
  } catch (e) {
    console.error(`  ✗  /api listing error for ${topPrefix}:`, e.message);
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end('[]');
  }
}



/* ── Main request router ───────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  /* ── OPTIONS preflight (CORS) ── */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  /* ── /health — Koyeb / load-balancer health check ── */
  if (pathname === '/health' || pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  /* ── /api/request — game/service request → Discord webhook ── */
  if (pathname === '/api/request') {
    return handleGameRequest(req, res);
  }

  /* ── /api/movies — list videos in the Movies/ folder ── */
  if (pathname === '/api/movies') {
    return handleMovies(req, res);
  }

  /* ── /api/games, /api/testing — auto-populated game grid data ── */
  if (pathname === '/api/games') {
    return handleGameList(req, res, 'Games/');
  }
  if (pathname === '/api/testing') {
    return handleGameList(req, res, 'Testing/');
  }

  /* ── Games/Testing → redirect straight to R2 ──
     Placed before static file serving so it takes priority regardless
     of whether a local copy still happens to exist on disk. Query
     strings are preserved; pathname is passed through already
     percent-encoded exactly as the browser sent it, matching how the
     objects were uploaded (R2/Cloudflare decodes it the same way any
     standard HTTP server would). ── */
  if (R2_PUBLIC_DOMAIN && r2BackedPrefix(pathname)) {
    const location = `https://${R2_PUBLIC_DOMAIN}${pathname}${parsed.search || ''}`;
    res.writeHead(302, { location, ...CORS_HEADERS });
    return res.end();
  }

  /* ── Static file serving ── */
  // Decode %-escapes so paths with spaces/unicode (e.g. movie filenames like
  // "Movies/My Movie.mp4") resolve to the real file instead of 404-ing.
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); }
  catch (_) { decodedPath = pathname; }
  const safePath = path.normalize(decodedPath).replace(/^(\.\.[\\/])+/, '');
  const filePath = path.join(STATIC, safePath === '/' ? 'index.html' : safePath);

  // Never escape the STATIC directory
  if (!filePath.startsWith(STATIC)) {
    res.writeHead(403, { 'content-type': 'text/plain', ...CORS_HEADERS });
    return res.end('Forbidden');
  }

  serveStatic(req, res, filePath, !!r2BackedPrefix(pathname));
});

/* ── Self-ping ── keeps the Render deployment awake ──────────────
   Fires a HEAD (falling back to GET) request at SELF_PING_URL on an
   interval. Failures are logged but never crash the process. ── */
function selfPing() {
  try {
    const target = new url.URL(SELF_PING_URL);
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request(target, { method: 'HEAD', timeout: 15000 }, res => {
      console.log(`  🔁  Self-ping ${SELF_PING_URL} → ${res.statusCode}`);
      res.resume();
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => {
      console.warn(`  ⚠   Self-ping failed: ${err.message}`);
    });
    req.end();
  } catch (err) {
    console.warn(`  ⚠   Self-ping error: ${err.message}`);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║         Red Portal — Local Server        ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  🌐  Open:     http://localhost:${PORT}`);
  console.log(`  📨  Requests: http://localhost:${PORT}/api/request`);
  console.log(`  💚  Health:   http://localhost:${PORT}/health`);
  console.log('');
  if (BOT_URL) {
    console.log(`  ✓   Bot endpoint: ${BOT_URL}`);
  } else {
    console.log('  ⚠   BOT_URL not set — requests will return 503.');
    console.log('      Set it in your environment or docker-compose.yml.');
  }
  if (R2_PUBLIC_DOMAIN) {
    console.log(`  ✓   R2 redirect:  ${R2_BACKED_PREFIXES.join(', ')} → https://${R2_PUBLIC_DOMAIN}`);
  } else {
    console.log('  ⚠   R2_PUBLIC_DOMAIN not set — Games/Testing will be served from local disk.');
  }
  if (SELF_PING_ENABLED) {
    console.log(`  🔁  Self-ping: ${SELF_PING_URL} every ${Math.round(SELF_PING_INTERVAL_MS / 60000)} min`);
    setInterval(selfPing, SELF_PING_INTERVAL_MS);
  } else {
    console.log('  ⚠   Self-ping disabled (SELF_PING_ENABLED=false).');
  }
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗  Port ${PORT} is already in use. Try: PORT=3001 node server.js\n`);
  } else {
    console.error('\n  ✗  Server error:', err.message, '\n');
  }
  process.exit(1);
});
