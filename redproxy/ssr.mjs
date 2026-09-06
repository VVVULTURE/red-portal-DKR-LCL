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

const SESSION_COOKIE = 'rp_sid';
/* Cookie jars are per visitor. A single shared jar would leak one person's
   logged-in sessions to everyone else using the proxy. */
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export async function createServerScramjet({ scramjetDist, prefixPath, origin }) {
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
      script(`${origin}/scram/scramjet.js`),
      script(`${origin}/rp-wasm.js`),
      script(`${origin}/rp-client.js`),
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
    const d = req.headers['sec-fetch-dest'];
    if (d && d !== 'empty') return d;
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) return 'document';
    return 'empty';
  }

  return { handle, sessions };
}
