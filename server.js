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

/* ── Red Proxy (Scramjet Controller, in-process) ──────────────────
   Everything the proxy needs runs inside THIS same process/server --
   no separate deployment, no third-party proxy or wisp service. Built on
   MercuryWorkshop's current reference architecture (github.com/
   MercuryWorkshop/scramjet -- @mercuryworkshop/scramjet-controller +
   @mercuryworkshop/scramjet-utils + @mercuryworkshop/proxy-transports'
   direct-client transport, replacing the older @mercuryworkshop/scramjet
   v1.1.0 + bare-mux SharedWorker design this project used previously).
   See the /redproxy router branch and the 'upgrade' handler further down.

   scramjetPath still has a real Node-side "./path" export (unlike
   libcurl-transport below). scramjetControllerPath/scramjetUtilsPath
   don't have one -- both are pure-ESM packages with no CJS "node"
   export condition -- but require.resolve() only RESOLVES a path, it
   never loads/executes the module, so it works for locating their dist/
   directories regardless. */
const { scramjetPath } = require('@mercuryworkshop/scramjet/path');
const scramjetControllerPath = path.dirname(require.resolve('@mercuryworkshop/scramjet-controller'));
const scramjetUtilsPath      = path.dirname(require.resolve('@mercuryworkshop/scramjet-utils'));
// libcurl-transport 2.x (unlike 1.x, which shipped a dedicated
// lib/index.cjs Node entry exporting `libcurlPath` directly) dropped its
// separate Node-side build entirely -- require()'ing the package's main
// entry runs the BROWSER bundle's own top-level "environment detection"
// code, which throws outside a browser/worker context. This project only
// ever needs the on-disk dist/ directory anyway (to serve it as a static
// file at /libcurl/ -- server.js never executes this library itself), so
// require.resolve() gets that path without ever loading the module.
const libcurlPath = path.dirname(require.resolve('@mercuryworkshop/libcurl-transport'));
const { server: wispServer, logging: wispLogging } = require('@mercuryworkshop/wisp-js/server');

wispLogging.set_level(wispLogging.NONE);
Object.assign(wispServer.options, {
  allow_udp_streams: false,
  dns_servers: ['1.1.1.3', '1.0.0.3'], // Cloudflare's malware-blocking resolver
});

/* ── Config ────────────────────────────────────────────────────── */
const PORT       = parseInt(process.env.PORT || '3001', 10);
const STATIC     = __dirname;           // serve files from the same folder as server.js
// URL of the bot's HTTP listener, e.g. http://192.168.1.50:3000/post-request
const BOT_URL    = process.env.BOT_URL    || 'https://boneless-parcel-reputable.ngrok-free.dev/post-request';
// Shared secret — must match BOT_SECRET in bot.js to prevent unauthorized posts
const BOT_SECRET = process.env.BOT_SECRET || '0fffaa699dd1422eac9cf419d1649f8ff9b346d9594450c51987ba8a61003ba3';

/* ── R2-backed folders ──────────────────────────────────────────
   Games/, Testing/ and Apps/ now live in Cloudflare R2, not on this
   server's disk (see .dockerignore — they're excluded from the Docker build
   entirely). Any request whose path starts with one of these prefixes
   gets a 302 redirect straight to R2, using the exact same relative
   path the sync script uploaded objects under. Once the browser lands
   on the R2 URL, every relative asset the game itself requests (JS,
   images, audio, WASM) resolves against R2 automatically — no paths
   in index.html or inside any individual game's files need to change.

   If R2_PUBLIC_DOMAIN is left unset, this feature is a no-op and the
   server falls back to serving Games/Testing/Apps from local disk exactly
   like before — safe default for local dev without R2 configured.   */
// Self-ping — keeps the Render free-tier instance from spinning down due to
// inactivity. Every SELF_PING_INTERVAL_MS, the server requests its own
// /health endpoint over HTTPS. Purely operational; no effect on the site's
// look or behavior. Set SELF_PING_ENABLED=false to disable.
const SELF_PING_ENABLED       = (process.env.SELF_PING_ENABLED || 'true').toLowerCase() !== 'false';
const SELF_PING_URL           = process.env.SELF_PING_URL || 'https://redportal.dpdns.org/health';
const SELF_PING_INTERVAL_MS   = parseInt(process.env.SELF_PING_INTERVAL_MS || String(10 * 60 * 1000), 10); // 10 minutes

const R2_PUBLIC_DOMAIN   = process.env.R2_PUBLIC_DOMAIN || '';
const R2_BACKED_PREFIXES = (process.env.R2_BACKED_PREFIXES || 'Games,Testing,Apps,Movies,Emulation')
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

/* ── Locate each game's real index.html and build the auto-populated
   grid data ──────────────────────────────────────────────────────
   THREE layers, fastest first:

     0. manifest.json fast path -- sync_to_r2.py writes a relative-path ->
        public-URL manifest on every sync and uploads it to R2 alongside
        the games themselves. Fetching that ONE file over plain HTTPS
        through Cloudflare's CDN and building the listing from its keys
        in memory is what actually made this fast -- every R2 List API
        call from this deployment was measured taking multiple seconds
        round-trip (see /api/r2-status), so ANY approach needing more
        than a couple of List calls per request ends up taking tens of
        seconds, whether that's one full recursive scan or several
        smaller per-folder ones (layer 2 below). Falls through to layer
        2 if the manifest is missing, unreadable, or has nothing under
        this prefix -- so this can never make things worse, only faster
        once a manifest is available (next sync after this ships).

     1. Two-phase live R2 listing (listR2GameFoldersViaS3) -- Phase 1 is
        ONE cheap delimited listing (CommonPrefixes) to get just the
        top-level folder names, bounded by folder COUNT not file count;
        Phase 2 is a small per-folder scoped listing (with limited
        concurrency) to find each one's index.html, bounded by that one
        game's own file count. Still correct without a manifest, just
        slower.

   Some game folders have index.html right at their root; others have it
   nested (e.g. a build output subfolder), and a few vendor an entire
   "related games" widget several levels deep, meaning MULTIPLE unrelated
   games' index.html files can exist under one folder. Per folder, the
   SHALLOWEST index.html found is picked as that game's entry point --
   correct for a simple nested build folder, and normally correct for the
   "multiple vendored games" case too. A folder with more than one
   index.html at the same shallowest depth is genuinely ambiguous; it
   still picks a deterministic result (alphabetical) and logs a warning
   so you can pin the correct one via game-overrides.json if it guessed
   wrong.

   Display name defaults to the folder name with dashes turned into
   spaces (e.g. "there-is-no-game" -> "there is no game"), unless
   overridden.                                                          */

/* Phase 1 — top-level folder names directly under a prefix, via S3's
   delimiter trick (CommonPrefixes). One or two pages even when the
   prefix holds hundreds of thousands of files, since this never
   descends past the first "/".                                       */
async function listTopLevelFolders(topPrefix) {
  const client = getS3Client();
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

  const folders = [];
  let continuationToken;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: topPrefix,
      Delimiter: '/',
      ContinuationToken: continuationToken,
    });
    const resp = await client.send(cmd);
    for (const cp of resp.CommonPrefixes || []) {
      const folder = cp.Prefix.slice(topPrefix.length).replace(/\/$/, '');
      if (folder) folders.push(folder);
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  return folders;
}

/* Phase 2 — shallowest index.html within ONE folder's own prefix. */
async function findShallowestIndexHtml(topPrefix, folder) {
  const client = getS3Client();
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const folderPrefix = `${topPrefix}${folder}/`;

  const candidates = [];
  let continuationToken;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: folderPrefix,          // scoped to this one game's own files
      ContinuationToken: continuationToken,
    });
    const resp = await client.send(cmd);
    for (const obj of resp.Contents || []) {
      const subPath = obj.Key.slice(folderPrefix.length);
      if (!subPath || !/index\.html?$/i.test(subPath)) continue;
      candidates.push({ subPath, depth: subPath.split('/').length });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.depth - b.depth || a.subPath.localeCompare(b.subPath));
  const chosen = candidates[0];

  if (candidates.length > 1 && candidates[1].depth === chosen.depth) {
    console.warn(
      `  ⚠  Ambiguous index.html under ${folderPrefix} -- picked "${chosen.subPath}" ` +
      `out of ${candidates.length} candidates at the shallowest depth. ` +
      `Add an entry to game-overrides.json if this picked the wrong one.`
    );
  }
  return chosen.subPath;
}

async function listR2GameFoldersViaS3(topPrefix) {
  const client = getS3Client();
  if (!client) return [];

  const folders = await listTopLevelFolders(topPrefix);
  const overrides = getGameOverrides();

  const entries = await mapWithConcurrency(folders, 8, async folder => {
    const override = overrides[folder] || {};
    const relPath = override.path || await findShallowestIndexHtml(topPrefix, folder);
    if (!relPath) return null; // no index.html found anywhere in this folder -- skip it

    const name = override.name || folder.replace(/-/g, ' ');
    return { folder, name, href: `${topPrefix}${folder}/${relPath}` };
  });

  const results = entries.filter(Boolean);
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/* Layer 0 — manifest.json fast path. */
let manifestCache = null; // { data, expires }
const MANIFEST_CACHE_TTL_MS = parseInt(process.env.MANIFEST_CACHE_TTL_MS || String(30 * 1000), 10);

function fetchManifest() {
  return new Promise((resolve, reject) => {
    if (!R2_PUBLIC_DOMAIN) return reject(new Error('R2_PUBLIC_DOMAIN not set'));
    const req = https.get(
      {
        hostname: R2_PUBLIC_DOMAIN,
        path: '/manifest.json',
        agent: httpsAgent,
        headers: { 'user-agent': 'red-portal-server' },
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`manifest.json returned HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch (e) {
            reject(new Error(`manifest.json is not valid JSON: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('manifest.json fetch timed out'));
    });
  });
}

async function getManifest() {
  const now = Date.now();
  if (manifestCache && manifestCache.expires > now) return manifestCache.data;
  const data = await fetchManifest();
  manifestCache = { data, expires: now + MANIFEST_CACHE_TTL_MS };
  return data;
}

/* Same { folder, name, href }[] shape as listR2GameFoldersViaS3, but
   computed purely from the already-fetched manifest keys in memory --
   no network calls at all. */
function buildGameListFromManifest(topPrefix, manifest) {
  const byFolder = new Map(); // folder -> [{ subPath, depth }, ...]

  for (const relPath of Object.keys(manifest)) {
    if (!relPath.startsWith(topPrefix)) continue;
    const rest = relPath.slice(topPrefix.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) continue; // stray file directly under the prefix
    const folder  = rest.slice(0, slashIdx);
    const subPath = rest.slice(slashIdx + 1);
    if (!/index\.html?$/i.test(subPath)) continue;
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push({ subPath, depth: subPath.split('/').length });
  }

  const overrides = getGameOverrides();
  const results = [];
  for (const [folder, candidates] of byFolder.entries()) {
    candidates.sort((a, b) => a.depth - b.depth || a.subPath.localeCompare(b.subPath));
    const chosen = candidates[0];
    const override = overrides[folder] || {};
    const name = override.name || folder.replace(/-/g, ' ');
    const relPath = override.path || chosen.subPath;
    results.push({ folder, name, href: `${topPrefix}${folder}/${relPath}` });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

async function listR2GameFolders(topPrefix) {
  // Fast path: manifest.json (see comment above)
  try {
    const manifest = await getManifest();
    const results = buildGameListFromManifest(topPrefix, manifest);
    if (results.length) return results;
    console.warn(`  ⚠  manifest.json had no entries under ${topPrefix} -- falling back to live R2 listing.`);
  } catch (e) {
    console.warn(`  ⚠  manifest.json fast path unavailable (${e.message}) -- falling back to live R2 listing.`);
  }
  // Slow-but-authoritative fallback: live two-phase R2 listing.
  return listR2GameFoldersViaS3(topPrefix);
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

/* List ROM entries under Emulation/. Two ways to place a ROM:
     - Emulation/<Console>/<file>  -- explicit: <Console> must exactly match
       a key in cores.json, and that's the console used, no detection needed.
     - Emulation/<file>            -- flat: console is auto-detected from the
       file's own extension (or, for a .zip, from the extension of the file
       INSIDE the archive -- see detectConsoleForZip below), via
       extensions.json. This is the normal drop-it-in-and-go path.
   A console/extension that can't be resolved either way still lists the ROM
   (so nothing silently disappears), just with core: null -- the player page
   shows a "couldn't determine the console" placeholder for those instead of
   erroring.                                                                */
let _emulatorCores = null;
function getEmulatorCores() {
  if (_emulatorCores) return _emulatorCores;
  try {
    const raw = fs.readFileSync(path.join(STATIC, 'assets/emulator/cores.json'), 'utf8');
    _emulatorCores = JSON.parse(raw);
  } catch {
    _emulatorCores = {};
  }
  return _emulatorCores;
}

let _emulatorExtensions = null;
function getEmulatorExtensions() {
  if (_emulatorExtensions) return _emulatorExtensions;
  try {
    const raw = fs.readFileSync(path.join(STATIC, 'assets/emulator/extensions.json'), 'utf8');
    _emulatorExtensions = JSON.parse(raw);
  } catch {
    _emulatorExtensions = {};
  }
  return _emulatorExtensions;
}

function fileExtension(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/* Same "spaces -> dashes, strip illegal chars" convention as
   local-deploy.js's toLocalFolderName -- used to turn an Emulation entry's
   display name into the same kind of key Games/Testing folder names
   already are, so assets/icons/<key>.png works the same way everywhere. */
function toIconSlug(name) {
  return String(name).trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-');
}

// Junk that can legitimately sit alongside a ROM inside its .zip -- never
// the actual game file, so skipped when picking which entry to detect from.
const ZIP_JUNK_EXTENSIONS = new Set([
  'txt', 'nfo', 'diz', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'ico',
  'url', 'md', 'pdf', 'doc', 'docx', 'ini', 'db', 'ds_store',
]);

/* Minimal, dependency-free ZIP central-directory reader -- just enough to
   list filenames, never decompresses/reads actual file content. Reads the
   END of the object via an S3 suffix-range request (no need to know the
   file's size up front), finds the End Of Central Directory record (EOCD,
   signature 0x06054b50), then walks the Central Directory File Headers
   (signature 0x02014b50) it points to. If the central directory turns out
   to start before the tail window this first fetch covered (rare -- would
   need many entries in one zip, not the norm for a single-ROM archive), a
   second targeted range request fetches exactly that span. Zip64 (>4GB
   archives or >65535 entries -- never the case for a ROM zip) isn't
   supported; detection just gracefully gives up (returns null) rather than
   misreading it. */
const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const ZIP_TAIL_BYTES = 2 * 1024 * 1024; // comfortably covers EOCD + central directory for a handful of entries

async function fetchR2Range(key, rangeHeader) {
  const client = getS3Client();
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const resp = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: rangeHeader }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return { buf: Buffer.concat(chunks), contentRange: resp.ContentRange || '' };
}

function findEocd(buf) {
  // Scan backward -- EOCD can be followed by a variable-length comment, so
  // it isn't necessarily the very last 22 bytes.
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/* @returns {string|null} the extension of the first non-junk, non-directory
   file found inside the zip, or null if it can't be determined. */
async function detectConsoleForZip(key) {
  try {
    const tail = await fetchR2Range(key, `bytes=-${ZIP_TAIL_BYTES}`);
    let buf = tail.buf;
    // "bytes N-M/TOTAL" -- how far into the real file this tail chunk starts.
    const totalMatch = /\/(\d+)$/.exec(tail.contentRange);
    const fileSize = totalMatch ? parseInt(totalMatch[1], 10) : buf.length;
    const tailStartInFile = fileSize - buf.length;

    const eocdIdx = findEocd(buf);
    if (eocdIdx === -1) return null; // not a normal zip, or comment > 65535 bytes -- give up cleanly

    const totalEntries    = buf.readUInt16LE(eocdIdx + 10);
    const cdSize           = buf.readUInt32LE(eocdIdx + 12);
    const cdOffsetInFile    = buf.readUInt32LE(eocdIdx + 16);
    if (totalEntries === 0 || cdOffsetInFile === 0xffffffff || cdSize === 0xffffffff) return null; // zip64 sentinel or empty archive

    let cdBuf;
    if (cdOffsetInFile >= tailStartInFile) {
      // Central directory is already inside the tail chunk we fetched.
      cdBuf = buf.subarray(cdOffsetInFile - tailStartInFile, cdOffsetInFile - tailStartInFile + cdSize);
    } else {
      // Rare: more entries than our tail window covers. One more targeted fetch.
      const extra = await fetchR2Range(key, `bytes=${cdOffsetInFile}-${cdOffsetInFile + cdSize - 1}`);
      cdBuf = extra.buf;
    }

    let offset = 0;
    for (let n = 0; n < totalEntries && offset + 46 <= cdBuf.length; n++) {
      if (cdBuf.readUInt32LE(offset) !== CDFH_SIG) break; // corrupt/unexpected -- stop rather than misread
      const nameLen  = cdBuf.readUInt16LE(offset + 28);
      const extraLen = cdBuf.readUInt16LE(offset + 30);
      const commentLen = cdBuf.readUInt16LE(offset + 32);
      const externalAttrs = cdBuf.readUInt32LE(offset + 38);
      const name = cdBuf.toString('utf8', offset + 46, offset + 46 + nameLen);

      const isDir = name.endsWith('/') || ((externalAttrs >>> 16) & 0o40000) !== 0;
      const ext = fileExtension(name);
      if (!isDir && ext && !ZIP_JUNK_EXTENSIONS.has(ext)) return ext;

      offset += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch (e) {
    console.warn(`  ⚠  Couldn't inspect zip "${key}" for console detection:`, e.message);
    return null;
  }
}

/* .7z and .rar console detection -- NOT full structural parsers like the
   ZIP one above. 7z's own metadata block can itself be LZMA-compressed
   (kEncodedHeader) before it even gets to listing filenames, and correctly
   walking the rest of the format (PackInfo/UnpackInfo/SubStreamsInfo, each
   with their own nested property-ID encoding) to reach the names when it
   ISN'T compressed is a big enough chunk of the spec that a hand-rolled
   version risks subtly MISreading it -- worse than not detecting at all,
   since a wrong console guess sends EmulatorJS off to load a ROM with the
   wrong core. RAR's block format is proprietary and versioned (RAR4 vs
   RAR5 differ). Full parsers for either aren't worth the risk for what
   this is actually for: a best-effort console hint.

   Instead: fetch a bounded, honest window of raw bytes and scan for a
   recognizable ROM filename in either encoding these formats actually use --
   plain ASCII/UTF-8 (RAR, and 7z when NOT header-compressed), or UTF-16LE
   (7z's kName property, which is literally "each char followed by a 0x00
   byte" for anything in the ASCII range). Stripping 0x00 bytes from the
   buffer collapses UTF-16LE ASCII text back to plain text, so ONE scan
   pattern works for both encodings without decoding either archive format.
   Requires a several-character run of plausible filename characters before
   a recognized extension -- specific enough that a coincidental match in
   random compressed binary data is very unlikely. Finds nothing (header
   IS compressed, or genuinely can't find a match) -> returns null, same
   clean give-up as the ZIP path above.                                    */
const FILENAME_SCAN_RE = /[a-z0-9][a-z0-9 _.,()!\[\]&'-]{2,80}\.([a-z0-9]{1,6})(?:\x00|[^a-z0-9]|$)/gi;

function scanBufferForRomExtension(buf, knownExtensions) {
  const denulled = Buffer.from([...buf].filter(b => b !== 0)).toString('latin1');
  FILENAME_SCAN_RE.lastIndex = 0;
  let m;
  while ((m = FILENAME_SCAN_RE.exec(denulled)) !== null) {
    const ext = m[1].toLowerCase();
    if (knownExtensions.has(ext)) return ext;
  }
  return null;
}

const SEVENZIP_SIG = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const SEVENZIP_MAX_HEADER_BYTES = 8 * 1024 * 1024; // sanity cap -- a legitimate ROM archive's metadata is nowhere near this

async function detectConsoleForSevenZip(key, knownExtensions) {
  try {
    const sig = await fetchR2Range(key, 'bytes=0-31'); // fixed 32-byte signature header
    if (sig.buf.length < 32 || !sig.buf.subarray(0, 6).equals(SEVENZIP_SIG)) return null;

    const nextHeaderOffset = Number(sig.buf.readBigUInt64LE(12));
    const nextHeaderSize   = Number(sig.buf.readBigUInt64LE(20));
    if (!Number.isFinite(nextHeaderOffset) || !Number.isFinite(nextHeaderSize)) return null;
    if (nextHeaderSize <= 0 || nextHeaderSize > SEVENZIP_MAX_HEADER_BYTES) return null;

    const headerStart = 32 + nextHeaderOffset;
    const header = await fetchR2Range(key, `bytes=${headerStart}-${headerStart + nextHeaderSize - 1}`);
    return scanBufferForRomExtension(header.buf, knownExtensions);
  } catch (e) {
    console.warn(`  ⚠  Couldn't inspect 7z "${key}" for console detection:`, e.message);
    return null;
  }
}

const RAR_SCAN_WINDOW_BYTES = 256 * 1024; // filenames sit in header blocks near the start for a simple, few-file ROM archive

async function detectConsoleForRar(key, knownExtensions) {
  try {
    const head = await fetchR2Range(key, `bytes=0-${RAR_SCAN_WINDOW_BYTES - 1}`);
    return scanBufferForRomExtension(head.buf, knownExtensions);
  } catch (e) {
    console.warn(`  ⚠  Couldn't inspect rar "${key}" for console detection:`, e.message);
    return null;
  }
}

/* Run `fn` over `items` with at most `limit` in flight at once -- caps how
   many concurrent round trips a large ROM collection fires
   at R2 during one listing. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function listR2EmulationEntries() {
  const client = getS3Client();
  if (!client) return [];
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const topPrefix = 'Emulation/';
  const cores = getEmulatorCores();
  const extensions = getEmulatorExtensions();
  const knownExtensions = new Set(Object.keys(extensions));

  const raw = []; // { key, folder|null, file }
  let continuationToken;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: topPrefix,
      ContinuationToken: continuationToken,
    });
    const resp = await client.send(cmd);
    for (const obj of resp.Contents || []) {
      const rest = obj.Key.slice(topPrefix.length); // "Some Game.zip" or "NES/Some Game.zip"
      if (!rest || rest.endsWith('/')) continue; // the prefix "directory marker" object itself, if any
      const slashIdx = rest.indexOf('/');
      if (slashIdx === -1) {
        raw.push({ key: obj.Key, folder: null, file: rest }); // flat -- auto-detect
      } else {
        const folder = rest.slice(0, slashIdx);
        const file = rest.slice(slashIdx + 1);
        if (!file || file.includes('/')) continue; // only one level deep supported
        raw.push({ key: obj.Key, folder, file });
      }
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  const entries = await mapWithConcurrency(raw, 6, async item => {
    let consoleName;
    if (item.folder && cores[item.folder]) {
      consoleName = item.folder; // explicit override -- trusted as-is, no detection
    } else {
      const ext = fileExtension(item.file);
      let detectedExt;
      if (ext === 'zip') detectedExt = await detectConsoleForZip(item.key);
      else if (ext === '7z') detectedExt = await detectConsoleForSevenZip(item.key, knownExtensions);
      else if (ext === 'rar') detectedExt = await detectConsoleForRar(item.key, knownExtensions);
      else detectedExt = ext;
      consoleName = detectedExt ? (extensions[detectedExt] || (cores[detectedExt] ? detectedExt : null)) : null;
      // Fall back to a literal folder name even if it's not a recognized
      // console (a typo'd folder still beats silently dropping the ROM).
      if (!consoleName && item.folder) consoleName = item.folder;
    }

    return {
      console: consoleName || 'Unsorted',
      file: item.file,
      // Collapse whitespace AFTER swapping -/_ for spaces -- a raw ROM
      // filename like "007 - GoldenEye.zip" already has a space on each
      // side of its dash, so swapping the dash alone first would leave
      // "007   GoldenEye" (three spaces) as the display name.
      name: item.file.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim(),
      core: (consoleName && cores[consoleName]) || null,
      romPath: item.key,
    };
  });

  entries.sort((a, b) => a.console.localeCompare(b.console) || a.name.localeCompare(b.name));
  return entries;
}

/* Simple in-memory cache so every page load doesn't hit R2's API --
   a new game folder or movie shows up within CACHE_TTL_MS of the next
   request after it's uploaded. Short TTLs here + the client-side
   auto-refresh polling in index.html (see renderGameGrid) together mean
   a freshly-synced game shows up in the browser within seconds, with no
   manual page reload needed -- not just "next time the site boots up".
   Affordable to keep this short now that the manifest.json fast path
   (see listR2GameFolders) makes a cache miss cheap -- one plain HTTPS
   GET through Cloudflare's CDN, not a slow authenticated R2 API call. */
const CACHE_TTL_MS_GAMES     = parseInt(process.env.GAMES_CACHE_TTL_MS     || String(15 * 1000), 10); // 15s
const CACHE_TTL_MS_MOVIES    = parseInt(process.env.MOVIES_CACHE_TTL_MS    || String(15 * 1000), 10); // 15s
const CACHE_TTL_MS_EMULATION = parseInt(process.env.EMULATION_CACHE_TTL_MS || String(15 * 1000), 10); // 15s -- ROMs aren't manifest-backed, but the underlying listing is still just one R2 call plus small per-zip range reads
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

/* ── Red Proxy headers ─────────────────────────────────────────────
   Cross-Origin-Embedder-Policy:require-corp is what lets Scramjet's WASM
   transport reach full (cross-origin-isolated) speed -- but applying it
   SITE-WIDE would break loading images/audio/video from the R2 asset
   domain (assets.redportal.dpdns.org doesn't send a matching CORP header),
   which is exactly the CORS_HEADERS above are permissive on purpose for.
   So this header set is scoped ONLY to /scram/, /controller/, /libcurl/,
   and /redproxy/ -- everything else on the site keeps CORS_HEADERS
   untouched. */
const SCRAMJET_HEADERS = Object.freeze({
  'cross-origin-opener-policy':   'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
});

/* Serve one static file from an arbitrary root dir (not necessarily
   STATIC) with SCRAMJET_HEADERS applied -- used for scramjet/controller/
   libcurl's own bundled files and the /redproxy/ page itself.

   `isolate` defaults to true (apply SCRAMJET_HEADERS) but MUST be passed
   as false for sw.js specifically -- see the caller in the router for why:
   a service worker's global scope inherits COEP/COOP from its OWN script
   response, and since this one is registered at root scope ("/"), that
   would make cross-origin-isolation apply to every request on the entire
   site for as long as the worker stays registered, not just to whatever
   page loaded it. */
function serveScramjetAsset(req, res, rootDir, relPath, extraHeaders, isolate = true) {
  const decoded = (() => { try { return decodeURIComponent(relPath); } catch { return relPath; } })();
  const safeRel = path.normalize(decoded).replace(/^(\.\.[\\/])+/, '');
  const filePath = path.join(rootDir, safeRel);
  const isolationHeaders = isolate ? SCRAMJET_HEADERS : {};

  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403, { 'content-type': 'text/plain', ...isolationHeaders });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain', ...isolationHeaders });
      return res.end('Not found');
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type':   mime,
      'content-length': stat.size,
      'cache-control':  ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      ...isolationHeaders,
      ...extraHeaders,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

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
   Every href handed back by /api/games, /api/testing, /api/apps, /api/movies,
   and /api/emulation is a complete absolute URL (https://redportal.dpdns.org/Games/...), never
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
async function handleMovies(req, res, fresh) {
  try {
    const origin = getRequestOrigin(req);
    const files = fresh
      ? await listR2Files('Movies/', VIDEO_RE)
      : await cachedList('movies', CACHE_TTL_MS_MOVIES, () => listR2Files('Movies/', VIDEO_RE));
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

/* ── GET /api/games, /api/testing and /api/apps — auto-populate the
   grids straight from what's actually in the R2 bucket. Dropping a new
   folder into Games/, Testing/ or Apps/ and reloading Red Portal is all
   it takes -- no index.html edits, no redeploy. See listR2GameFolders()
   for how the entry-point index.html is located inside each folder.  */
async function handleGameList(req, res, topPrefix, fresh) {
  try {
    const origin = getRequestOrigin(req);
    const games = fresh
      ? await listR2GameFolders(topPrefix)
      : await cachedList(topPrefix, CACHE_TTL_MS_GAMES, () => listR2GameFolders(topPrefix));
    // icon: the folder name IS the stable per-game key already (exact match
    // to assets/icons/<folder>.png) -- see the icon-loading comment in
    // index.html for how a missing file degrades gracefully.
    const absolute = games.map(g => ({ ...g, icon: g.folder, href: `${origin}/${g.href}` })); // relative -> absolute
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(absolute));
  } catch (e) {
    console.error(`  ✗  /api listing error for ${topPrefix}:`, e.message);
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end('[]');
  }
}

/* ── GET /api/emulation — auto-populate the Emulation grid from ROM files
   sitting under Emulation/<Console>/ on R2. Each entry's href points at the
   generic EmulatorJS player (assets/emulator/player.html) with the ROM's
   own R2 URL, looked-up core, and display name passed as query params --
   see listR2EmulationEntries() and assets/emulator/cores.json.            */
async function handleEmulationList(req, res) {
  try {
    const origin = getRequestOrigin(req);
    const entries = await cachedList('emulation', CACHE_TTL_MS_EMULATION, listR2EmulationEntries);
    const withHref = entries.map(e => {
      const romUrl = `${origin}/${e.romPath}`;
      const params = new url.URLSearchParams({ rom: romUrl, name: e.name });
      if (e.core) params.set('core', e.core);
      return {
        console: e.console,
        name: e.name,
        core: e.core,
        // No folder name to key off of here (a ROM is one file, not a
        // folder) -- slug the display name the same way Games/Testing
        // folder names are derived, so assets/icons/<slug>.png also just
        // works for a ROM whose display name happens to match a browser
        // version of the same game elsewhere on the site.
        icon: toIconSlug(e.name),
        href: `${origin}/assets/emulator/player.html?${params.toString()}`,
      };
    });
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(withHref));
  } catch (e) {
    console.error('  ✗  /api/emulation R2 listing error:', e.message);
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end('[]'); // fail soft -- an empty Emulation tab beats a broken page
  }
}

/* ── GET /api/r2-status — diagnostic for the R2 auto-discovery feature.
   Hit this directly in the browser to see, at a glance:
     - which of the 5 required env vars are actually set on this
       deployment (booleans only -- never the secret value itself)
     - whether the manifest.json fast path works, how long it took, and
       how many entries it found under Games/ and Testing/ -- this is
       what /api/games and /api/testing actually use day-to-day, so
       it's reported first/separately since it's what matters for "why
       is the grid slow/empty"
     - only if the manifest fast path failed: whether a real S3 client
       could be constructed, and whether a live two-phase R2 listing
       against Games/, Testing/, and Movies/ succeeds, how long it
       took, and (on failure) the exact error message
   This makes the "why is nothing showing up" question answerable
   without needing to dig through Render's server logs.                */
async function handleR2Status(req, res) {
  const configured = {
    R2_ACCOUNT_ID:             !!R2_ACCOUNT_ID,
    R2_LIST_ACCESS_KEY_ID:     !!R2_LIST_ACCESS_KEY_ID,
    R2_LIST_SECRET_ACCESS_KEY: !!R2_LIST_SECRET_ACCESS_KEY,
    R2_BUCKET:                 !!R2_BUCKET,
    R2_PUBLIC_DOMAIN:          !!R2_PUBLIC_DOMAIN,
  };

  const result = { configured, clientCreated: false };

  const manifestStarted = Date.now();
  try {
    const manifest = await fetchManifest(); // bypass cache -- always a fresh check here
    const keys = Object.keys(manifest);
    result['manifest.json'] = {
      ok: true,
      ms: Date.now() - manifestStarted,
      totalEntries: keys.length,
      gamesEntries: keys.filter(k => k.startsWith('Games/')).length,
      testingEntries: keys.filter(k => k.startsWith('Testing/')).length,
      appsEntries: keys.filter(k => k.startsWith('Apps/')).length,
      emulationEntries: keys.filter(k => k.startsWith('Emulation/')).length,
    };
  } catch (e) {
    result['manifest.json'] = { ok: false, error: e.message, ms: Date.now() - manifestStarted };
  }

  let client;
  try {
    client = getS3Client();
    result.clientCreated = !!client;
  } catch (e) {
    result.clientCreationError = e.message; // e.g. @aws-sdk/client-s3 not installed
  }

  if (client && !result['manifest.json'].ok) {
    for (const prefix of ['Games/', 'Testing/', 'Apps/']) {
      const started = Date.now();
      try {
        const folders = await listTopLevelFolders(prefix);
        result[prefix] = { ok: true, folderCount: folders.length, ms: Date.now() - started, sample: folders.slice(0, 8), note: 'live S3 listing (manifest fast path failed)' };
      } catch (e) {
        result[prefix] = { ok: false, error: e.message, ms: Date.now() - started };
      }
    }
    const started = Date.now();
    try {
      const movies = await listR2Files('Movies/', VIDEO_RE);
      result['Movies/'] = { ok: true, fileCount: movies.length, ms: Date.now() - started };
    } catch (e) {
      result['Movies/'] = { ok: false, error: e.message, ms: Date.now() - started };
    }
  }

  res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(result, null, 2));
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

  /* ── /health — Render / load-balancer health check ── */
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
    return handleMovies(req, res, parsed.query.fresh === '1');
  }

  /* ── /api/r2-status — diagnostic: are the R2 listing env vars set,
     and does a real listing call (manifest.json fast path, or live R2
     as a fallback) actually succeed? ── */
  if (pathname === '/api/r2-status') {
    return handleR2Status(req, res);
  }

  /* ── /api/games, /api/testing, /api/apps — auto-populated grid data ──
     ?fresh=1 bypasses the in-memory cache for this one request. ── */
  if (pathname === '/api/games') {
    return handleGameList(req, res, 'Games/', parsed.query.fresh === '1');
  }
  if (pathname === '/api/testing') {
    return handleGameList(req, res, 'Testing/', parsed.query.fresh === '1');
  }
  if (pathname === '/api/apps') {
    return handleGameList(req, res, 'Apps/', parsed.query.fresh === '1');
  }

  /* ── /api/emulation — auto-populated Emulation grid data ── */
  if (pathname === '/api/emulation') {
    return handleEmulationList(req, res);
  }

  /* ── Red Proxy — Scramjet Controller's own bundled files + the
     /redproxy/ page ── All served from this same process (see requires +
     SCRAMJET_HEADERS above). Checked before the R2 redirect/static
     blocks below so it can never collide with a real Games/Testing/asset
     path. ── */
  if (pathname === '/scram/scramjet-utils.js') {
    // scramjet-utils lives in a SEPARATE npm package/directory from the
    // core scramjet bundle below, but the client (controller-init.js,
    // matching MercuryWorkshop's own reference bootstrap's path layout)
    // expects it under the same /scram/ prefix -- special-cased ahead of
    // the generic /scram/ handler for that one file.
    return serveScramjetAsset(req, res, scramjetUtilsPath, 'scramjet-utils.js');
  }
  if (pathname.startsWith('/scram/')) {
    return serveScramjetAsset(req, res, scramjetPath, pathname.slice('/scram/'.length));
  }
  if (pathname.startsWith('/controller/')) {
    return serveScramjetAsset(req, res, scramjetControllerPath, pathname.slice('/controller/'.length));
  }
  if (pathname.startsWith('/libcurl/')) {
    return serveScramjetAsset(req, res, libcurlPath, pathname.slice('/libcurl/'.length));
  }
  /* ── Scramjet Controller's internal proxy prefix, reaching this SERVER
     directly ── "/~/sj/" (config.prefix's real, stable default -- confirmed
     by reading controller.api.js's dist) is where every actual proxied
     request is SUPPOSED to be intercepted and answered by the Red Proxy
     service worker in the browser, never by hitting this raw HTTP server
     at all. It reaching here at all means some request escaped SW control
     entirely -- a genuine, known browser-platform limitation: Service
     Workers don't control documents created via document.write() into an
     about:blank iframe (a pattern some ad/game-loader scripts still use),
     so THEIR resource requests go out as real, uncontrolled network
     requests instead of being routed through the proxy. There's no way to
     make those actually work from here (that would need server-side
     rewriting, a fundamentally different proxy architecture) -- but
     without this check they'd fall through to the generic SPA-fallback
     below and get back Red Portal's own homepage HTML with a 200 status,
     which is actively worse: a <script> tag expecting JS gets "expected
     expression, got '<'" and a <link rel=stylesheet> gets rejected for
     the wrong MIME type, both confusingly EVENTUALLY-successful-looking
     failures instead of a normal, recognizable network error. Answering
     with a real 404 here at least fails the way page code actually
     expects failures to look (onerror handlers, catch blocks). */
  if (pathname.startsWith('/~/sj/')) {
    res.writeHead(404, { 'content-type': 'text/plain', ...CORS_HEADERS });
    return res.end('This request needed to go through the Red Proxy service worker, but reached the server directly instead (the service worker doesn\'t control this browsing context) -- not proxyable from here.');
  }
  /* ── Same idea as /~/sj/ above, for the EMBEDDED proxy ──
     frame.js overrides config.prefix to "/redproxy/sj/" so that its
     service worker's natural max scope ("/redproxy/", the directory its
     own script is served from) already covers every proxied URL, without
     needing root scope or a Service-Worker-Allowed header. A request
     arriving here under that prefix means the same thing the /~/sj/ case
     means: it escaped service worker control, and cannot be answered from
     the raw HTTP server. Must be checked BEFORE the generic /redproxy/
     static branch below, which would otherwise try to read it off disk
     and answer with a bare, unexplained "Not found". */
  if (pathname.startsWith('/redproxy/sj/')) {
    /* There is one recoverable way to end up here, and it is common enough
       to be worth healing rather than reporting. The service worker keeps
       the list of prefixes it should intercept in memory, so a browser
       terminating it for being idle empties that list; the next proxied
       navigation starts the worker again, but shouldRoute() runs before
       the worker has been handed the prefixes back, so that one request
       escapes to the network and arrives here. By the time this response
       is parsed, the worker is running again and has been re-primed --
       simply asking for the same URL a second time succeeds.

       frame.js keeps the worker warm precisely so this stays rare, but a
       worker can still be reclaimed under memory pressure or across a
       sleep/resume, so retry a bounded number of times before giving up.
       The counter lives in the fragment, which never reaches this server
       and so cannot disturb the proxied URL's own query string.

       Only for NAVIGATIONS. A subresource that escaped (the classic case
       being a document.write()n about:blank iframe, which no service
       worker can ever control) must keep getting the plain-text 404: a
       <script> or stylesheet handed an HTML retry page would fail in a
       far more confusing way than a clean network error. */
    const dest = req.headers['sec-fetch-dest'];
    const isNavigation = dest === 'document' || dest === 'iframe' ||
                         (!dest && req.headers['sec-fetch-mode'] === 'navigate');

    if (!isNavigation) {
      res.writeHead(404, { 'content-type': 'text/plain', ...CORS_HEADERS });
      return res.end('This request needed to go through the Red Proxy service worker, but reached the server directly instead (the service worker doesn\'t control this browsing context) -- not proxyable from here.');
    }

    res.writeHead(503, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    });
    return res.end(`<!doctype html>
<meta charset="utf-8">
<title>Reconnecting…</title>
<style>
  html,body{height:100%;margin:0;background:#0a0a0a;color:#ffdddd;
    font-family:'Rajdhani','Segoe UI',system-ui,sans-serif}
  div{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    text-align:center;padding:2rem;font-size:.95rem;line-height:1.5}
  b{color:#ff6060;font-weight:600}
</style>
<div id="m">Reconnecting to the Red Proxy&hellip;</div>
<script>
(function () {
  var MAX = 2;
  var m = /^#rp-retry-(\\d+)$/.exec(location.hash);
  var n = m ? parseInt(m[1], 10) : 0;
  if (n < MAX) {
    setTimeout(function () {
      location.hash = 'rp-retry-' + (n + 1);
      location.reload();
    }, 700);
    return;
  }
  document.getElementById('m').innerHTML =
    '<span><b>The Red Proxy service worker did not pick this up.</b><br><br>' +
    'This page was requested straight from the server instead of going through the ' +
    'proxy, which cannot work. Reload the Red Proxy tab to start it again.</span>';
})();
</script>`);
  }
  if (pathname === '/redproxy' || pathname === '/redproxy/' || pathname.startsWith('/redproxy/')) {
    const rel = (pathname === '/redproxy' || pathname === '/redproxy/')
      ? 'index.html'
      : pathname.slice('/redproxy/'.length) || 'index.html';
    const isSw = rel === 'sw.js';
    // sw.js needs to control the WHOLE site (scope "/"), not just its own
    // "/redproxy/" directory -- Scramjet's codec rewrites proxied URLs to
    // live at the site root, not under this folder. A script's own
    // directory is the max scope a browser allows by default, so this
    // header is required to explicitly widen it. See controller-init.js.
    //
    // frame-sw.js needs the same widening, for a different reason than
    // sw.js does. Its proxied URLs sit under "/redproxy/sj/" and would fit
    // its own directory's default scope perfectly well -- but the
    // Controller now runs inside Red Portal's own document at "/", and the
    // worker reaches its page via clients.matchAll(), which returns ONLY
    // clients the worker CONTROLS. Without root scope, index.html would be
    // an uncontrolled client and would silently miss both the cookie-sync
    // broadcasts (breaking logins on proxied sites) and the revive message
    // a restarted worker sends to get its prefixes back. See the SW_SCOPE
    // comment in frame.js.
    //
    // Crucially this is NOT a return of the old site-wide hazard:
    // frame-sw.js is listed in NON_ISOLATED below, so it carries no
    // COEP/COOP for the worker to inherit and impose on the whole origin,
    // and its fetch handler returns without ever calling respondWith() for
    // anything shouldRoute() does not claim.
    // frame.js must revalidate on every load. It is served from the same
    // directory as the engine bundles, so it would otherwise inherit their
    // "public, max-age=3600" -- and it is not a cacheable third-party
    // bundle, it is the client half of a contract with this server (the
    // service worker path, its scope, and config.prefix all have to agree).
    // Letting a browser run an hour-old copy against a freshly deployed
    // server is a real failure mode, not a theoretical one: it is what made
    // the first deploy of the staged boot reporting appear to do nothing.
    // frame-sw.js needs no equivalent -- register() passes
    // updateViaCache:'none', which bypasses the HTTP cache for the worker
    // script -- and frame.html already gets no-cache for being .html.
    const isFrameSw = rel === 'frame-sw.js';
    const extra = (isSw || isFrameSw)
      ? { 'service-worker-allowed': '/' }
      : (rel === 'frame.js' ? { 'cache-control': 'no-cache' } : undefined);
    // sw.js must NOT get SCRAMJET_HEADERS (isolate: false) -- a service
    // worker inherits COEP/COOP from its own script response, and at root
    // scope that would cross-origin-isolate the ENTIRE SITE for as long as
    // the worker stays registered. That in turn requires every resource
    // the worker's own fetch() touches (including a plain passthrough
    // fetch for, say, a game icon on assets.redportal.dpdns.org) to send a
    // matching Cross-Origin-Resource-Policy header -- which R2 doesn't --
    // so the browser blocks it. This is what was breaking every game icon
    // and other R2-hosted asset site-wide after merely opening the Red
    // Proxy tab once: confirmed by reproducing it locally (bisecting the
    // proxy's init sequence step by step, isolating it to the moment the
    // service worker registers) and by curling the header this file used
    // to be served with.
    //
    // The frame.* trio is excluded from SCRAMJET_HEADERS for a different
    // reason. frame.html is embedded by Red Portal's Red Proxy tab, which
    // may itself be a blob: document belonging to a foreign origin. Cross-
    // origin isolation is inherited from the top-level document, so it can
    // never be achieved there no matter what this server sends -- and it
    // buys nothing anyway (the Controller only consults crossOriginIsolated
    // to decide whether to copy COEP/COOP onto proxied responses, and
    // defaults it to false). Sending require-corp would therefore add real
    // constraints on every subresource for zero benefit. frame-sw.js is
    // excluded for the ordinary service-worker reason above.
    const NON_ISOLATED = ['sw.js', 'frame-sw.js', 'frame.html', 'frame.js'];
    return serveScramjetAsset(req, res, path.join(STATIC, 'redproxy'), rel, extra, !NON_ISOLATED.includes(rel));
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

/* ── Red Proxy — wisp WebSocket endpoint ─────────────────────────
   No 'upgrade' handler existed here before this -- Node's default
   behavior for an unhandled upgrade request is to just close the
   connection (see the Node http docs), which is exactly what the
   else-branch below still does for anything other than /wisp/, so this
   is purely additive and can't regress any existing behavior. ── */
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/wisp/' || req.url.startsWith('/wisp/')) {
    return wispServer.routeRequest(req, socket, head);
  }
  socket.destroy();
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
  console.log(`  🕵  Red Proxy:   http://localhost:${PORT}/redproxy  (wisp on this same server, /wisp/)`);
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
