/**
 * Red Portal — Local Proxy Server
 * ================================
 * Replaces the external Cloudflare Worker with a local Node.js server.
 *
 * Run:  node server.js          (default port 3000)
 *       PORT=8080 node server.js (custom port)
 *
 * The proxy endpoint is  GET/POST/HEAD  http://localhost:3000/proxy?url=<encoded-url>
 * The static files  (index.html, assets/)  are served from this same directory.
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
const PROXY_MAX  = 50 * 1024 * 1024;   // abort proxy responses larger than 50 MB
// URL of the bot's HTTP listener, e.g. http://192.168.1.50:3000/post-request
const BOT_URL    = process.env.BOT_URL    || 'https://boneless-parcel-reputable.ngrok-free.dev/post-request';
// Shared secret — must match BOT_SECRET in bot.js to prevent unauthorized posts
const BOT_SECRET = process.env.BOT_SECRET || '0fffaa699dd1422eac9cf419d1649f8ff9b346d9594450c51987ba8a61003ba3';

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

/* ── Proxy a request to a remote URL ──────────────────────────── */
function proxyRequest(clientReq, clientRes, targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (_) {
    clientRes.writeHead(400, { 'content-type': 'text/plain', ...CORS_HEADERS });
    return clientRes.end('Invalid target URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    clientRes.writeHead(400, { 'content-type': 'text/plain', ...CORS_HEADERS });
    return clientRes.end('Only http/https targets are supported');
  }

  const isHttps = parsed.protocol === 'https:';
  const lib     = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (isHttps ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   clientReq.method === 'HEAD' ? 'HEAD' : clientReq.method,
    agent:    isHttps ? httpsAgent : httpAgent,
    headers: {
      'user-agent':      clientReq.headers['user-agent'] ||
                         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                         '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept':          clientReq.headers['accept'] ||
                         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'referer':         parsed.origin + '/',
      ...(clientReq.headers['content-type']
          ? { 'content-type': clientReq.headers['content-type'] }
          : {}),
    },
  };

  let redirectsLeft = 10;

  function doRequest(opts, bodyChunks) {
    const upstreamReq = lib.request(opts, upstreamRes => {
      const status = upstreamRes.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && upstreamRes.headers.location) {
        if (--redirectsLeft <= 0) {
          clientRes.writeHead(508, { 'content-type': 'text/plain', ...CORS_HEADERS });
          return clientRes.end('Too many redirects');
        }
        upstreamRes.resume();
        let newUrl;
        try { newUrl = new URL(upstreamRes.headers.location, targetUrl); }
        catch (_) {
          clientRes.writeHead(502, { 'content-type': 'text/plain', ...CORS_HEADERS });
          return clientRes.end('Bad redirect location');
        }
        const newLib  = newUrl.protocol === 'https:' ? https : http;
        const newOpts = {
          hostname: newUrl.hostname,
          port:     newUrl.port || (newUrl.protocol === 'https:' ? 443 : 80),
          path:     newUrl.pathname + newUrl.search,
          method:   [303].includes(status) ? 'GET' : opts.method,
          agent:    newUrl.protocol === 'https:' ? httpsAgent : httpAgent,
          headers:  { ...opts.headers, referer: newUrl.origin + '/' },
        };
        return doRequest(newOpts, []);
      }

      const responseHeaders = { ...CORS_HEADERS };
      const ct = upstreamRes.headers['content-type'];
      if (ct) responseHeaders['content-type'] = ct;

      [
        'cache-control', 'etag', 'last-modified', 'expires',
        'content-encoding', 'transfer-encoding',
      ].forEach(h => {
        if (upstreamRes.headers[h]) responseHeaders[h] = upstreamRes.headers[h];
      });

      clientRes.writeHead(upstreamRes.statusCode || 200, responseHeaders);

      if (opts.method === 'HEAD') {
        return clientRes.end();
      }

      let received = 0;
      upstreamRes.on('data', chunk => {
        received += chunk.length;
        if (received > PROXY_MAX) {
          upstreamReq.destroy();
          clientRes.end();
          return;
        }
        clientRes.write(chunk);
      });
      upstreamRes.on('end',   () => clientRes.end());
      upstreamRes.on('error', () => clientRes.end());
    });

    upstreamReq.on('error', err => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'content-type': 'text/plain', ...CORS_HEADERS });
      }
      clientRes.end('Upstream fetch failed: ' + err.message);
    });

    upstreamReq.setTimeout(20000, () => {
      upstreamReq.destroy();
      if (!clientRes.headersSent) {
        clientRes.writeHead(504, { 'content-type': 'text/plain', ...CORS_HEADERS });
        clientRes.end('Upstream request timed out');
      }
    });

    if (bodyChunks && bodyChunks.length) {
      for (const chunk of bodyChunks) upstreamReq.write(chunk);
    }
    upstreamReq.end();
  }

  const bodyChunks = [];
  clientReq.on('data', chunk => bodyChunks.push(chunk));
  clientReq.on('end',  () => doRequest(options, bodyChunks));
  clientReq.on('error', () => {});
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
        'x-bot-secret':   BOT_SECRET,
        'ngrok-skip-browser-warning': 'true' // <-- Add this line!
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

function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fall back to index.html for SPA-style navigation
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
    res.writeHead(200, {
      'content-type':  mime,
      'cache-control': cacheControl,
      ...CORS_HEADERS,
    });
    fs.createReadStream(filePath).pipe(res);
  });
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

  /* ── /proxy?url=<encoded> — the local proxy endpoint ── */
  if (pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain', ...CORS_HEADERS });
      return res.end('Missing ?url= parameter');
    }
    return proxyRequest(req, res, target);
  }

  /* ── /api/request — game/service request → Discord webhook ── */
  if (pathname === '/api/request') {
    return handleGameRequest(req, res);
  }

  /* ── Static file serving ── */
  const safePath = path.normalize(pathname).replace(/^(\.\.[\\/])+/, '');
  const filePath = path.join(STATIC, safePath === '/' ? 'index.html' : safePath);

  // Never escape the STATIC directory
  if (!filePath.startsWith(STATIC)) {
    res.writeHead(403, { 'content-type': 'text/plain', ...CORS_HEADERS });
    return res.end('Forbidden');
  }

  serveStatic(req, res, filePath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║         Red Portal — Local Server        ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  🌐  Open:     http://localhost:${PORT}`);
  console.log(`  🔀  Proxy:    http://localhost:${PORT}/proxy?url=<encoded>`);
  console.log(`  📨  Requests: http://localhost:${PORT}/api/request`);
  console.log(`  💚  Health:   http://localhost:${PORT}/health`);
  console.log('');
  if (BOT_URL) {
    console.log(`  ✓   Bot endpoint: ${BOT_URL}`);
  } else {
    console.log('  ⚠   BOT_URL not set — requests will return 503.');
    console.log('      Set it in your environment or docker-compose.yml.');
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
