/**
 * Red Proxy — server-side Scramjet
 * =================================
 * Runs scramjet's fetch + rewrite pipeline inside this Node process instead
 * of inside a browser service worker.
 *
 * Why this exists
 * ---------------
 * The service-worker design cannot run when Red Portal has been re-hosted as
 * a blob: URL by a launcher, and it cannot render without a nested browsing
 * context. Both were measured, not assumed: a blob: document cannot register
 * a worker (InvalidStateError) and is never controlled; about:blank popups,
 * <object> and <embed> are not worker clients either. Only a real http(s)
 * document can be one.
 *
 * Rewriting on the server sidesteps all of it. Every URL in the response is
 * rewritten to point back at this server before the browser ever sees it, so
 * there is nothing left to intercept -- no worker, and therefore no
 * restriction on what kind of document is doing the rendering. A blob tab
 * works, and so does a plain tab, with no iframe anywhere.
 *
 * What still runs in the browser
 * ------------------------------
 * Scramjet's client, injected into every page. That is not optional: the JS
 * rewriter emits calls like $scramjet$wrap(...), which only exist once the
 * client runtime is loaded. It also catches URLs that are built at runtime,
 * which static rewriting alone cannot see -- so keeping it is what preserves
 * compatibility on script-heavy sites. Its transport simply calls back into
 * this same endpoint.
 */

globalThis.self = globalThis; // the bundle is browser-targeted and expects it

import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
/* Node 20 on Render has no global WebSocket client, so use ws explicitly
   rather than relying on the runtime having one. */
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';

const SESSION_COOKIE = 'rp_sid';
/* Cookie jars are per visitor. A single shared jar would leak one person's
   logged-in sessions to everyone else using the proxy. */
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export async function createServerScramjet({ scramjetDist, prefixPath, origin, assetVersion }) {
  /* Injected script URLs carry a version so a deploy cannot leave browsers
     running an older client against a newer server. Cloudflare sits in
     front of this origin and honours the long max-age these scripts are
     served with, which already bit once: /rp-wasm.js kept returning a
     cached copy of the SPA fallback from before the route existed. */
  const v = assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : '';
  const sj = await import(new URL('scramjet.mjs', `file:///${scramjetDist}/`).href);
  sj.setWasm(new Uint8Array(readFileSync(`${scramjetDist}/scramjet.wasm`)));

  const codecEncode = (input) => (input ? encodeURIComponent(input) : input);
  const codecDecode = (input) => (input ? decodeURIComponent(input) : input);

  /** ProxyTransport over Node's own fetch. This server has direct internet
   *  access, so unlike the browser build there is no wisp relay in the path
   *  at all -- one less moving part and one less round trip. */
  const transport = {
    ready: true,
    async init() {},
    async request(remote, method, body, headers, signal) {
      const h = new Headers();
      for (const [k, v] of headers) {
        try { h.set(k, v); } catch { /* forbidden header name, skip it */ }
      }
      const res = await fetch(remote, {
        method,
        body: body ?? undefined,
        headers: h,
        redirect: 'manual', // scramjet rewrites Location itself
        signal,
      });
      const raw = [];
      res.headers.forEach((v, k) => raw.push([k, v]));
      return { body: res.body, headers: raw, status: res.status, statusText: res.statusText };
    },
    connect() {
      throw new Error('websocket transport is not wired up yet');
    },
  };

  const sessions = new Map();

  function reapSessions() {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
    }
    while (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
  }

  function sessionFor(id) {
    let s = sessions.get(id);
    if (!s) {
      s = { jar: new sj.CookieJar(), touched: Date.now() };
      sessions.set(id, s);
      reapSessions();
    }
    s.touched = Date.now();
    return s;
  }

  /** Scripts injected at the top of every rewritten document. Order is load
   *  bearing: the bundle defines $scramjet, the wasm blob feeds the JS
   *  rewriter, and only then can the client boot against them. */
  function getInjectScripts(meta, handler, htmlcontext, script) {
    return [
      script(`${origin}/scram/scramjet.js${v}`),
      script(`${origin}/rp-wasm.js${v}`),
      script(`${origin}/rp-client.js${v}`),
    ];
  }

  function contextFor(session) {
    return {
      config: sj.defaultConfig,
      prefix: new URL(prefixPath, origin),
      cookieJar: session.jar,
      interface: { codecEncode, codecDecode, getInjectScripts },
    };
  }

  function makeHandler(session) {
    return new sj.ScramjetFetchHandler({
      transport,
      context: contextFor(session),
      crossOriginIsolated: false,
      // The jar lives here rather than in the browser, so applying a
      // Set-Cookie is a local operation with nothing to synchronise.
      sendSetCookie: async (cookies) => {
        for (const { url, cookie } of cookies || []) {
          try { session.jar.setCookies([cookie], new URL(url)); } catch { /* malformed */ }
        }
      },
      fetchDataUrl: async (dataUrl) => fetch(dataUrl),
      fetchBlobUrl: async () => {
        // blob: URLs only exist inside the tab that made them; the browser
        // side client resolves those itself and never asks the server.
        throw new Error('blob: URLs cannot be resolved server-side');
      },
    });
  }

  function rawHeadersOf(scramjetHeaders) {
    const out = {};
    const src = scramjetHeaders && scramjetHeaders.headers ? scramjetHeaders.headers : {};
    for (const k in src) out[k] = src[k];
    return out;
  }

  function readCookie(req, name) {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return null;
  }

  async function handle(req, res, pathname) {
    let sid = readCookie(req, SESSION_COOKIE);
    const isNewSession = !sid || !sessions.has(sid);
    if (isNewSession) sid = randomUUID();
    const session = sessionFor(sid);

    const encoded = pathname.slice(prefixPath.length);
    if (!encoded) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('No target URL.');
    }

    const proxiedUrl = new URL(req.url, origin);
    const handler = makeHandler(session);

    const initial = [];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host' || k === 'cookie' || k.startsWith(':')) continue;
      initial.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
    }

    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (chunks.length) body = Buffer.concat(chunks);
    }

    const out = await handler.handleFetch({
      rawUrl: proxiedUrl,
      rawReferrer: req.headers.referer || null,
      rawDestination: guessDestination(req),
      mode: req.headers['sec-fetch-mode'] || 'navigate',
      referrer: req.headers.referer || '',
      method: req.method,
      body,
      cache: 'default',
      initialHeaders: sj.ScramjetHeaders.fromRawHeaders(initial),
      clientId: sid,
    });

    const headers = rawHeadersOf(out.headers);
    delete headers['content-length']; // rewriting changes the length
    delete headers['content-encoding']; // already decoded by fetch
    if (isNewSession) {
      headers['set-cookie'] = `${SESSION_COOKIE}=${sid}; Path=/; Max-Age=21600; SameSite=Lax`;
    }

    res.writeHead(out.status || 200, headers);
    const b = out.body;
    if (!b) return res.end();
    if (typeof b === 'string' || Buffer.isBuffer(b)) return res.end(b);
    if (typeof b.getReader === 'function') return Readable.fromWeb(b).pipe(res);
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return res.end(Buffer.from(b));
    return res.end();
  }

  function guessDestination(req) {
    /* An explicit override, and the reason it has to exist: Red Portal
       fetches a page with fetch() so it can hand the result to a blob:
       tab, and fetch() always reports Sec-Fetch-Dest: empty. Treated as a
       subresource, the page comes back without document rewriting and
       without the injected client -- it renders, but none of its scripts
       are proxied and $scramjet is never defined. */
    const override = req.headers['x-rp-dest'];
    if (override) return override;

    const d = req.headers['sec-fetch-dest'];
    if (d && d !== 'empty') return d;
    if (req.headers['sec-fetch-mode'] === 'navigate') return 'document';
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) return 'document';
    return 'empty';
  }

  /* ── WebSocket relay ────────────────────────────────────────────
     GeForce NOW (and anything else with a live connection) negotiates
     over a WebSocket, so the proxy has to carry one. The browser opens a
     socket to /rp-ws/?url=<target>; this opens the real socket outward
     and pipes the two together, binary and text both.

     Note what is NOT here: WebRTC. Scramjet does not touch it either --
     grepping its core and controller for RTCPeerConnection/ICE finds
     nothing -- which is exactly why GeForce NOW works under stock
     scramjet. The page, its scripts and this signalling socket are
     proxied; the video stream itself negotiates directly between the
     browser and NVIDIA and never passes through here. Keeping scramjet's
     client unchanged means that behaviour is identical to the official
     build. */
  const wss = new WebSocketServer({ noServer: true });

  function handleUpgrade(req, socket, head) {
    let target;
    try {
      const u = new URL(req.url, origin);
      const raw = u.searchParams.get('url');
      if (!raw) throw new Error('no target');
      target = new URL(codecDecode(raw));
      if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
        // Sites hand us http(s) origins for their sockets; map them over.
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      }
    } catch {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      const headers = {};
      // Most services reject a socket whose Origin does not look like their
      // own site, so present the target's origin rather than Red Portal's.
      headers['origin'] = target.origin.replace(/^ws/, 'http');
      if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];

      const protocols = (req.headers['sec-websocket-protocol'] || '')
        .split(',').map((s) => s.trim()).filter(Boolean);

      let upstream;
      try {
        upstream = new NodeWebSocket(target.href, protocols.length ? protocols : undefined, { headers });
      } catch (err) {
        try { client.close(1011, 'upstream failed'); } catch { /* already gone */ }
        return;
      }

      const pending = [];
      upstream.on('open', () => {
        for (const m of pending.splice(0)) {
          try { upstream.send(m); } catch { /* closed mid-flush */ }
        }
      });
      upstream.on('message', (data, isBinary) => {
        if (client.readyState === client.OPEN) client.send(data, { binary: isBinary });
      });
      upstream.on('close', (code, reason) => {
        try { client.close(code >= 1000 && code <= 4999 ? code : 1011, reason?.toString?.() || ''); } catch { /* gone */ }
      });
      upstream.on('error', () => {
        try { client.close(1011, 'upstream error'); } catch { /* gone */ }
      });

      client.on('message', (data, isBinary) => {
        if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary });
        else if (upstream.readyState === upstream.CONNECTING) pending.push(data);
      });
      client.on('close', () => {
        try { upstream.close(); } catch { /* gone */ }
      });
      client.on('error', () => {
        try { upstream.close(); } catch { /* gone */ }
      });
    });
  }

  return { handle, handleUpgrade, sessions };
}
