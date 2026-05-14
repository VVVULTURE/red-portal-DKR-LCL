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
const PORT      = parseInt(process.env.PORT || '3000', 10);
const STATIC    = __dirname;           // serve files from the same folder as server.js
const PROXY_MAX = 50 * 1024 * 1024;   // abort proxy responses larger than 50 MB

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

/* ── CORS + framing headers — applied to EVERY response ───────── */
function corsHeaders() {
  return {
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
  };
}

/* ── Proxy a request to a remote URL ──────────────────────────── */
function proxyRequest(clientReq, clientRes, targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (_) {
    clientRes.writeHead(400, { 'content-type': 'text/plain', ...corsHeaders() });
    return clientRes.end('Invalid target URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    clientRes.writeHead(400, { 'content-type': 'text/plain', ...corsHeaders() });
    return clientRes.end('Only http/https targets are supported');
  }

  const isHttps = parsed.protocol === 'https:';
  const lib     = isHttps ? https : http;

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (isHttps ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   clientReq.method === 'HEAD' ? 'HEAD' : clientReq.method,
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
          clientRes.writeHead(508, { 'content-type': 'text/plain', ...corsHeaders() });
          return clientRes.end('Too many redirects');
        }
        upstreamRes.resume();
        let newUrl;
        try { newUrl = new URL(upstreamRes.headers.location, targetUrl); }
        catch (_) {
          clientRes.writeHead(502, { 'content-type': 'text/plain', ...corsHeaders() });
          return clientRes.end('Bad redirect location');
        }
        const newLib  = newUrl.protocol === 'https:' ? https : http;
        const newOpts = {
          hostname: newUrl.hostname,
          port:     newUrl.port || (newUrl.protocol === 'https:' ? 443 : 80),
          path:     newUrl.pathname + newUrl.search,
          method:   [303].includes(status) ? 'GET' : opts.method,
          headers:  { ...opts.headers, referer: newUrl.origin + '/' },
        };
        return doRequest(newOpts, []);
      }

      const responseHeaders = { ...corsHeaders() };
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
        clientRes.writeHead(502, { 'content-type': 'text/plain', ...corsHeaders() });
      }
      clientRes.end('Upstream fetch failed: ' + err.message);
    });

    upstreamReq.setTimeout(20000, () => {
      upstreamReq.destroy();
      if (!clientRes.headersSent) {
        clientRes.writeHead(504, { 'content-type': 'text/plain', ...corsHeaders() });
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

/* ── Serve a static file ──────────────────────────────────────── */
function serveStatic(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Fall back to index.html for SPA-style navigation
      const index = path.join(STATIC, 'index.html');
      fs.readFile(index, (e, data) => {
        if (e) {
          res.writeHead(404, { 'content-type': 'text/plain', ...corsHeaders() });
          return res.end('Not found');
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...corsHeaders() });
        res.end(data);
      });
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, ...corsHeaders() });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ── Main request router ───────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  /* ── OPTIONS preflight (CORS) ── */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  /* ── /health — Koyeb / load-balancer health check ── */
  if (pathname === '/health' || pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders() });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  }

  /* ── /proxy?url=<encoded> — the local proxy endpoint ── */
  if (pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain', ...corsHeaders() });
      return res.end('Missing ?url= parameter');
    }
    return proxyRequest(req, res, target);
  }

  /* ── Static file serving ── */
  const safePath = path.normalize(pathname).replace(/^(\.\.[\\/])+/, '');
  const filePath = path.join(STATIC, safePath === '/' ? 'index.html' : safePath);

  // Never escape the STATIC directory
  if (!filePath.startsWith(STATIC)) {
    res.writeHead(403, { 'content-type': 'text/plain', ...corsHeaders() });
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
  console.log(`  🌐  Open:    http://localhost:${PORT}`);
  console.log(`  🔀  Proxy:   http://localhost:${PORT}/proxy?url=<encoded>`);
  console.log(`  💚  Health:  http://localhost:${PORT}/health`);
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
