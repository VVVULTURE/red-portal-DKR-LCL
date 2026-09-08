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

/* Which origin this server is reachable at, worked out per request.
   Deliberately NOT captured once at startup: the value ends up inside the
   proxy prefix, and every proxied URL is decoded by checking it against
   that prefix. Pinning it to whichever request happened to initialise the
   module first meant that if that request arrived with a different Host --
   a platform health check, or the onrender.com hostname rather than the
   custom domain -- every subsequent request failed to decode and returned
   "Invalid URL". That produced exactly the symptom seen in production:
   intermittent failures that never reproduced from curl, because it
   depended on who spoke to the process first after a restart. */
function originOf(req, fallbackOrigin) {
  const proto = req.headers['x-forwarded-proto'] ||
    (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return fallbackOrigin;
  return `${String(proto).split(',')[0].trim()}://${host}`;
}

export async function createServerScramjet({ scramjetDist, prefixPath, origin: fallbackOrigin, assetVersion }) {
  /* Injected script URLs carry a version so a deploy cannot leave browsers
     running an older client against a newer server. Cloudflare sits in
     front of this origin and honours the long max-age these scripts are
     served with, which already bit once: /rp-wasm.js kept returning a
     cached copy of the SPA fallback from before the route existed. */
  const v = assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : '';
  const sj = await import(new URL('scramjet.mjs', `file:///${scramjetDist}/`).href);
  sj.setWasm(new Uint8Array(readFileSync(`${scramjetDist}/scramjet.wasm`)));

  /* Path-preserving codec.
     ----------------------
     encodeURIComponent turns the whole target into ONE path segment, and
     relative URLs then resolve by replacing that segment. A page asking
     for "./handle-gdn-util.js" from
     /rp/https%3A%2F%2Fplay.geforcenow.com%2Fmall%2F lands on
     /rp/handle-gdn-util.js, which carries no target at all and answers
     502 "unable to parse rewritten url" -- verified against production.
     Scramjet leaves relative URLs alone precisely because they are
     supposed to resolve correctly against the proxied document, and with
     a single-segment encoding they cannot.

     Keeping the target's slashes fixes that: the same request becomes
     /rp/https://play.geforcenow.com/mall/handle-gdn-util.js, which
     decodes exactly as intended. Only the three characters that genuinely
     cannot survive in a path are escaped:

       ?  rewriteUrl appends scramjet's own "?params" AFTER the encoded
          segment and unrewriteUrl does realUrl.search = "" before
          decoding, so a literal ? would merge with those and be dropped,
          silently losing the site's query string.
       #  a literal fragment would end the path early; scramjet carries
          the real hash separately.
       %  escaped first, or decoding could not tell an escape this codec
          produced from one already in the URL.

     Both functions are serialized with toString() and re-evaluated inside
     every proxied page, so they must stay self-contained. */
  const codecEncode = (input) =>
    input ? input.replace(/%/g, '%25').replace(/\?/g, '%3F').replace(/#/g, '%23') : input;
  const codecDecode = (input) => {
    if (!input) return input;
    const decoded = input.replace(/%23/gi, '#').replace(/%3F/gi, '?').replace(/%25/gi, '%');
    /* Also accept the older fully percent-encoded form. A browser holding a
       cached copy of Red Portal keeps sending /rp/https%3A%2F%2Fsite%2F
       after a deploy, and rejecting it answers "unable to parse rewritten
       url" on every page -- which is exactly what happened when the codec
       changed and one of the three copies was missed. Cheap to accept. */
    if (/^https?%3A/i.test(decoded)) {
      try { return decodeURIComponent(decoded); } catch (e) { return decoded; }
    }
    return decoded;
  };

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
  function makeGetInjectScripts(origin) {
    return function getInjectScripts(meta, handler, htmlcontext, script) {
    /* Tell the page which site it is, explicitly.

       Scramjet normally works this out by decoding the document's own URL,
       which is why it cannot survive in a blob: tab -- a blob URL has
       nowhere to carry the target, so the page ends up believing it lives
       at a UUID and anything that routes on its own URL renders nothing.
       The server knows the answer on every request, so state it rather
       than making the client infer it. rp-client.js uses this to give the
       page a URL identity independent of where the document actually
       sits, which is what lets a cloaked tab behave like a real one. */
    /* meta.origin, NOT meta.base -- they are different things and the
       difference is the whole GeForce NOW sign-in.

       meta.origin is the URL of the document being rewritten. meta.base is
       whatever the page's own <base> element says, which exists to resolve
       relative URLs and is routinely just "/". NVIDIA's login page is an
       Angular app and ships <base href="/">, so preferring base handed the
       page an identity of "https://login.nvgs.nvidia.com/" with the path
       and query -- including the single-use "key" the sign-in is carried
       by -- thrown away. The app booted, found no route and no key, and
       rendered its own "This Page Isn't Available" 404, which looks
       exactly like the server having refused the request. It had not:
       NVIDIA returned 200 to every one of those requests. */
    let targetHref = '';
    try {
      targetHref = String((meta && (meta.origin || meta.base)) || '');
    } catch { /* fall back to letting the client infer */ }

    const declareTarget =
      'data:text/javascript;charset=utf-8;base64,' +
      Buffer.from(`globalThis.__rpTarget=${JSON.stringify(targetHref)};`, 'utf8')
        .toString('base64');

      return [
        script(`${origin}/scram/scramjet.js${v}`),
        script(`${origin}/rp-wasm.js${v}`),
        script(declareTarget),
        script(`${origin}/rp-client.js${v}`),
      ];
    };
  }

  function contextFor(session, origin) {
    return {
      config: sj.defaultConfig,
      prefix: new URL(prefixPath, origin),
      cookieJar: session.jar,
      interface: {
        codecEncode,
        codecDecode,
        getInjectScripts: makeGetInjectScripts(origin),
      },
    };
  }

  function makeHandler(session, origin) {
    return new sj.ScramjetFetchHandler({
      transport,
      context: contextFor(session, origin),
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
    const origin = originOf(req, fallbackOrigin);
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
    const handler = makeHandler(session, origin);

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

    /* Only forward a referrer that is itself a proxied URL. Scramjet
       decodes the referrer back through the prefix to work out which page
       a request came from, and a referrer pointing at Red Portal's own UI
       is not encoded that way -- decoding it produces nonsense and the URL
       constructor throws, surfacing as "Invalid URL" on every request.

       This only bit navigations, which is what made it confusing: the same
       URL returned 200 from curl (no Referer sent) and 502 from a browser
       tab, and subresource requests were unaffected because they take a
       different path through the parser. */
    const prefixHref = new URL(prefixPath, origin).href;
    const referer = req.headers.referer || '';
    const proxiedReferer = referer.startsWith(prefixHref) ? referer : null;

    const out = await handler.handleFetch({
      rawUrl: proxiedUrl,
      rawReferrer: proxiedReferer,
      rawDestination: guessDestination(req),
      mode: req.headers['sec-fetch-mode'] || 'navigate',
      referrer: proxiedReferer || '',
      method: req.method,
      body,
      cache: 'default',
      initialHeaders: sj.ScramjetHeaders.fromRawHeaders(initial),
      clientId: sid,
    });

    const headers = rawHeadersOf(out.headers);
    delete headers['content-length']; // rewriting changes the length
    delete headers['content-encoding']; // already decoded by fetch

    /* Proxied responses must never be stored by a shared cache.
       ---------------------------------------------------------
       Two reasons, and the first is the serious one.

       These responses are per visitor. They are fetched with that
       visitor's cookie jar, so a logged-in page cached by a CDN could be
       handed to somebody else entirely. Forwarding the origin's own
       caching headers -- which is what happened -- invites exactly that.

       And it silently breaks correctness across deploys. Cloudflare sits
       in front of this origin and was caching /rp/ responses, so after the
       URL format changed the browser kept receiving HTML rewritten by the
       previous build: script tags still relative, every asset requested
       straight from the origin site instead of through the proxy, and
       GeForce NOW rendering nothing. It looked for a long time like a
       production-only bug in the rewriter, because curl (a cache miss)
       always got the correct page while the browser got the stale one.
       Measured on the live site: 12 of 16 resources went directly to
       NVIDIA, and the DOM still held "./handle-gdn-util.js".

       Stripping the validators too, so nothing revalidates into a stored
       copy. */
    delete headers['etag'];
    delete headers['last-modified'];
    delete headers['expires'];
    delete headers['age'];
    headers['cache-control'] = 'private, no-store, no-cache, must-revalidate';
    headers['cdn-cache-control'] = 'no-store';
    if (isNewSession) {
      headers['set-cookie'] = `${SESSION_COOKIE}=${sid}; Path=/; Max-Age=21600; SameSite=Lax`;
    }

    /* Cloak a navigation the browser performed by itself.
       ----------------------------------------------------
       rp-client tries to keep every navigation inside the blob tab by
       fetching the destination and handing the tab a new blob, but it can
       only intercept the mechanisms it knows about. Anything it misses --
       a form submitted through form.submit(), a meta refresh, a redirect
       chain, a window.open from a script -- is performed by the BROWSER,
       which lands here with the proxied URL in the address bar.

       The client used to notice that afterwards and re-fetch the page to
       rebuild the blob. That works for an ordinary page and fails badly
       for a URL that may only be requested once: signing in to GeForce
       NOW navigates to a login URL carrying a single-use "key" token, and
       the second request for it answered NVIDIA's own 404 page. The tab
       recovered its blob and lost the sign-in.

       So cloak it here instead, where the origin has been asked exactly
       once. Return the page as a string inside a stub that swaps the tab
       into a blob built from it. Same result, no second request, and it
       covers navigation mechanisms nobody has enumerated -- POSTs
       included, since the browser has already delivered the body.

       Only bare top-level HTML gets this treatment: rp-client's own
       fetches announce themselves with X-RP-Dest, subresources are not
       documents, and a 3xx has to stay a 3xx so the browser follows it. */
    if (isBareNavigation(req, out.status || 200, headers)) {
      const html = await bodyText(out.body);
      delete headers['content-security-policy'];
      delete headers['content-security-policy-report-only'];
      delete headers['x-frame-options'];
      headers['content-type'] = 'text/html; charset=utf-8';
      const stub = cloakStub(html);
      headers['content-length'] = String(Buffer.byteLength(stub));
      res.writeHead(200, headers);
      return res.end(stub);
    }

    res.writeHead(out.status || 200, headers);
    const b = out.body;
    if (!b) return res.end();
    if (typeof b === 'string' || Buffer.isBuffer(b)) return res.end(b);
    if (typeof b.getReader === 'function') return Readable.fromWeb(b).pipe(res);
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return res.end(Buffer.from(b));
    return res.end();
  }

  /** A top-level HTML document the browser navigated to on its own --
   *  i.e. one that would otherwise be displayed at the proxied URL. */
  function isBareNavigation(req, status, headers) {
    if (req.headers['x-rp-dest']) return false;       // rp-client's own fetch
    if (status >= 300 && status < 400) return false;  // let the browser follow
    const dest = req.headers['sec-fetch-dest'];
    const mode = req.headers['sec-fetch-mode'];
    if (dest ? dest !== 'document' : mode !== 'navigate') return false;
    return String(headers['content-type'] || '').toLowerCase().includes('text/html');
  }

  async function bodyText(b) {
    if (b == null) return '';
    if (typeof b === 'string') return b;
    if (Buffer.isBuffer(b)) return b.toString('utf8');
    if (ArrayBuffer.isView(b)) return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('utf8');
    if (b instanceof ArrayBuffer) return Buffer.from(b).toString('utf8');
    if (typeof b.getReader === 'function') {
      const chunks = [];
      for await (const c of Readable.fromWeb(b)) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    }
    return String(b);
  }

  /** Hand the page back inside a stub that immediately becomes a blob.
   *  If that fails the page is still written out rather than lost -- an
   *  exposed URL is a broken rule, a blank tab is a broken proxy. */
  function cloakStub(html) {
    /* base64, not a quoted string. The payload is arbitrary HTML: it will
       contain </script>, and it may contain any escape sequence or line
       separator there is. Getting that quoting subtly wrong would break
       every proxied page at once, and base64 has none of those characters
       in it. */
    const b64 = Buffer.from(html, 'utf8').toString('base64');
    return '<!doctype html><meta charset="utf-8"><title></title>'
      + '<script>(function(){var s=atob("' + b64 + '"),n=s.length,a=new Uint8Array(n);'
      + 'for(var i=0;i<n;i++)a[i]=s.charCodeAt(i);'
      + 'try{location.replace(URL.createObjectURL(new Blob([a],{type:"text/html;charset=utf-8"})))}'
      + 'catch(e){document.open();document.write(new TextDecoder().decode(a));document.close()}'
      + '})()<' + '/script>';
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
    const origin = originOf(req, fallbackOrigin);
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
