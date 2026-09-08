/**
 * Red Proxy — client runtime for the server-side proxy
 * =====================================================
 * Injected into every page the server rewrites (see getInjectScripts in
 * ssr.mjs). It is not optional: the JS rewriter emits calls like
 * $scramjet$wrap(...) and $scramjet$prop(...), and those only exist once
 * this has run. It also catches URLs that pages build at runtime, which
 * static rewriting on its own cannot see.
 *
 * The difference from the service-worker build is only where requests go.
 * There is no worker here; this client's transport calls straight back into
 * the same /rp/ endpoint that served the page, and the server does the
 * fetching and rewriting. That is what lets a proxied page live in a blob
 * tab, or anywhere else a worker could never reach.
 */
(function () {
  'use strict';

  if (globalThis.__rpClientBooted) return;
  globalThis.__rpClientBooted = true;

  /* Keep a short record of anything that blows up in a proxied page.
   *
   * Worth carrying permanently. A proxied page is frequently a blob:
   * document, and a blob document cannot be opened in devtools or attached
   * to by an extension -- so when one comes up blank there is otherwise no
   * way at all to find out why. The page that opened it is same-origin
   * with it, so it can read this back out. Capped, and never anything but
   * strings. */
  var RP_ERROR_LIMIT = 25;
  globalThis.__rpErrors = [];
  function rpRecord(kind, message, extra) {
    try {
      if (globalThis.__rpErrors.length >= RP_ERROR_LIMIT) return;
      globalThis.__rpErrors.push(
        kind + ': ' + String(message) + (extra ? ' @ ' + String(extra) : '')
      );
    } catch (e) { /* never let diagnostics break the page */ }
  }
  addEventListener('error', function (ev) {
    if (ev && ev.target && ev.target !== globalThis && ev.target.src) {
      rpRecord('resource', 'failed to load', ev.target.src);
      return;
    }
    rpRecord('error', (ev && ev.message) || 'unknown', ev && ev.filename);
  }, true);
  addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    rpRecord('rejection', (r && (r.message || r)) || 'unknown');
  });
  /* Frameworks usually report a failed bootstrap through console.error
     rather than by throwing, so a page can come up blank with nothing on
     the error events at all. Mirror those too -- the original console is
     left intact and still called. */
  (function () {
    var original = console.error;
    console.error = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length && i < 4; i++) {
          var a = arguments[i];
          parts.push(a && a.message ? a.message : String(a));
        }
        rpRecord('console', parts.join(' ').slice(0, 300));
      } catch (e) { /* diagnostics must never break the page */ }
      return original.apply(console, arguments);
    };
  })();

  var sj = globalThis.$scramjet;
  if (!sj || !sj.ScramjetClient) {
    console.error('[redproxy] scramjet bundle missing; the page will not be proxied');
    return;
  }

  /* Red Portal's origin, taken from this script's own absolute src rather
     than from location.

     Two reasons it cannot be location.origin. A proxied page may be opened
     as a blob: document so its address stays cloaked, and a blob inherits
     the origin of whoever created it -- which is not Red Portal when the
     portal was itself launched by a foreign blob launcher. And once the
     client below is installed it replaces location with a proxy reporting
     the TARGET site's URL, so asking afterwards gives the wrong answer
     entirely. The script tag the server injects is always absolute, so
     this is correct in every one of those cases. */
  var ORIGIN = (function () {
    try {
      var src = document.currentScript && document.currentScript.src;
      if (src) return new URL(src).origin;
    } catch (e) { /* fall through */ }
    return location.origin;
  })();
  var PREFIX = ORIGIN + '/rp/';

  /* Must stay identical to the codec in ssr.mjs -- the two sides encode
     and decode the same URLs. Path-preserving on purpose: a single-segment
     encoding makes relative URLs resolve by replacing that segment, so
     "./x.js" from a proxied page lands on /rp/x.js with no target in it at
     all. Only ?, # and % are escaped; see the long note in ssr.mjs. */
  function codecEncode(input) {
    return input ? input.replace(/%/g, '%25').replace(/\?/g, '%3F').replace(/#/g, '%23') : input;
  }
  function codecDecode(input) {
    if (!input) return input;
    var decoded = input.replace(/%23/gi, '#').replace(/%3F/gi, '?').replace(/%25/gi, '%');
    // Also accept the older fully percent-encoded form; see ssr.mjs.
    if (/^https?%3A/i.test(decoded)) {
      try { return decodeURIComponent(decoded); } catch (e) { return decoded; }
    }
    return decoded;
  }

  /* Carry our own ?v= through to anything we inject, so a page rewritten
     on the client asks for exactly the runtime this document is running
     rather than whatever a CDN still has cached. */
  var VERSION = (function () {
    try {
      var src = document.currentScript && document.currentScript.src;
      if (src) {
        var q = new URL(src).searchParams.get('v');
        if (q) return '?v=' + encodeURIComponent(q);
      }
    } catch (e) { /* fall through */ }
    return '';
  })();

  function getInjectScripts(meta, handler, htmlcontext, script) {
    return [
      script(ORIGIN + '/scram/scramjet.js' + VERSION),
      script(ORIGIN + '/rp-wasm.js' + VERSION),
      script(ORIGIN + '/rp-client.js' + VERSION),
    ];
  }

  function makeContext() {
    return {
      config: sj.defaultConfig,
      prefix: new URL(PREFIX),
      cookieJar: new sj.CookieJar(),
      interface: {
        codecEncode: codecEncode,
        codecDecode: codecDecode,
        getInjectScripts: getInjectScripts,
      },
    };
  }

  /* Everything this client wants fetched goes back through our own server,
     which performs the real request and rewrites the answer. Credentials
     are included so the session cookie rides along and the server can pick
     the right cookie jar for this visitor. */
  var transport = {
    ready: true,
    init: function () { return Promise.resolve(); },
    request: function (remote, method, body, headers, signal) {
      var h = new Headers();
      (headers || []).forEach(function (pair) {
        try { h.set(pair[0], pair[1]); } catch (e) { /* forbidden header */ }
      });
      /* nativeFetch, NOT the global fetch. Scramjet replaces window.fetch
         when it hooks, and that replacement rewrites whatever URL it is
         given -- so calling it here would rewrite a URL that is already
         proxied, producing /rp/<our own origin>/rp/<target>, which trips
         scramjet's own same-origin guard and fails. */
      return nativeFetch(PREFIX + codecEncode(String(remote)), {
        method: method,
        body: body == null ? undefined : body,
        headers: h,
        signal: signal,
        credentials: 'include',
        redirect: 'manual',
      }).then(function (res) {
        var raw = [];
        res.headers.forEach(function (v, k) { raw.push([k, v]); });
        return { body: res.body, headers: raw, status: res.status, statusText: res.statusText };
      });
    },
    /* Live connections (GeForce NOW's signalling, and anything else that
       holds a socket open) go to our own /rp-ws/ endpoint, which opens the
       real socket outward and pipes both directions.

       Returns [send, close] because that is the contract scramjet's
       ProxyTransport expects -- it hands us the four callbacks and takes
       back the two functions it will drive the socket with. */
    connect: function (url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
      var wsBase = ORIGIN.replace(/^http/, 'ws') + '/rp-ws/?url=' + codecEncode(String(url));
      var sock;
      try {
        sock = protocols && protocols.length
          ? new WebSocket(wsBase, protocols)
          : new WebSocket(wsBase);
      } catch (err) {
        onerror(String(err && err.message || err));
        return [function () {}, function () {}];
      }

      // Binary frames must arrive as ArrayBuffer; the default (Blob) would
      // make scramjet's consumers do async reads they do not expect.
      sock.binaryType = 'arraybuffer';

      sock.onopen = function () { onopen(sock.protocol || '', ''); };
      sock.onmessage = function (ev) { onmessage(ev.data); };
      sock.onclose = function (ev) { onclose(ev.code, ev.reason); };
      sock.onerror = function () { onerror('websocket error'); };

      return [
        function send(data) {
          try { sock.send(data); } catch (err) { onerror(String(err && err.message || err)); }
        },
        function close(code, reason) {
          try { sock.close(code, reason); } catch (err) { /* already closed */ }
        },
      ];
    },
  };

  /* Natives captured before the client hooks anything. After hooking,
     these globals are scramjet's proxies, which report the PROXIED site's
     view of the world -- useful to the page, useless to us. */
  var NativeURL = URL;
  var nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  var NativeBlob = Blob;
  var nativeFetch = globalThis.fetch.bind(globalThis);
  var nativeReplace = location.replace.bind(location);

  var IS_BLOB = location.protocol === 'blob:';
  var TARGET = typeof globalThis.__rpTarget === 'string' ? globalThis.__rpTarget : '';

  /* Give the page a URL identity of its own.
   * ----------------------------------------
   * Scramjet decides which site a page is by decoding the document's own
   * URL back through the proxy prefix. In a blob: tab there is nothing to
   * decode -- the address is a UUID -- so the page concludes it lives at
   * the blob, and anything that routes on its own URL renders an empty
   * body. That is precisely why GeForce NOW came up blank in a blob tab
   * while static pages were fine.
   *
   * The server states the real target in an injected constant, so replace
   * the one getter everything else flows from with a virtual URL seeded
   * from it. client.url feeds meta.origin and meta.base, so every URL the
   * page resolves, every request it makes and everything scramjet rewrites
   * follows from this. The document stays a blob; the page believes it is
   * where it should be.
   *
   * Installed BEFORE hook(), because hooking reads client.url. */
  function installVirtualIdentity(client, target) {
    var virtual = new NativeURL(target);

    Object.defineProperty(client, 'url', {
      configurable: true,
      get: function () { return new NativeURL(virtual.href); },
      set: function (value) {
        var next;
        try { next = new NativeURL(String(value), virtual.href); }
        catch (e) { return; }
        virtual = next;
        // A real navigation would leave the blob and expose the address,
        // so fetch the destination and hand the tab another blob instead.
        navigateCloaked(next.href);
      },
    });

    // Let the history patch below move the virtual URL as the app routes.
    client.__rpSetVirtual = function (href) {
      try { virtual = new NativeURL(String(href), virtual.href); } catch (e) { /* ignore */ }
    };
    client.__rpGetVirtual = function () { return virtual.href; };
    return client;
  }

  /** Navigate the tab to another proxied page without leaving blob:. */
  function navigateCloaked(targetHref) {
    nativeFetch(PREFIX + codecEncode(targetHref), {
      credentials: 'include',
      headers: { 'X-RP-Dest': 'document' },
    })
      .then(function (res) { return res.text(); })
      .then(function (html) {
        nativeReplace(nativeCreateObjectURL(new NativeBlob([html], { type: 'text/html' })));
      })
      .catch(function (err) {
        console.error('[redproxy] cloaked navigation failed', err);
      });
  }

  /* Make client-side routing survive inside a blob: document.
   *
   * A blob: URL cannot change, so history.pushState and replaceState throw
   * SecurityError there -- for a path and even for a bare hash. Any app
   * that routes client-side hits that during boot and stops dead, which is
   * why a static page proxies happily into a blob tab while a single-page
   * app comes up blank.
   *
   * Scramjet keeps its own view of the proxied URL regardless, so the real
   * call has nothing useful to do here anyway; it only needs to stop
   * throwing. Patched on History.prototype BEFORE the client hooks, so the
   * "native" it captures is already this safe version rather than the one
   * that throws. Only in blob: documents -- everywhere else the real
   * implementation is left completely alone. */
  var activeClient = null;

  function makeHistorySafeForBlob() {
    if (!IS_BLOB) return;
    var proto = History.prototype;
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = proto[name];
      if (typeof original !== 'function') return;
      proto[name] = function (state, title, url) {
        /* Routing still has to MOVE the page's identity, or an app would
           push a route and then still believe it was on the first one.
           The real call cannot record it here, so record it ourselves. */
        if (url != null && activeClient && activeClient.__rpSetVirtual) {
          activeClient.__rpSetVirtual(url);
        }
        try {
          return original.call(this, state, title, url);
        } catch (err) {
          // Expected in a blob: document, where the URL cannot change.
          // The app's router carries on against the virtual URL above.
          return undefined;
        }
      };
    });
  }

  function bootClient(scope) {
    var client = new sj.ScramjetClient(scope, {
      context: makeContext(),
      transport: transport,
      sendSetCookie: function () { return Promise.resolve(); },
      hookSubcontext: function (sub) { return bootClient(sub); },
      initHeaders: [],
      history: [],
    });

    /* Only in a blob: tab, and only when the server told us the target.
       Everywhere else the document URL already carries it and scramjet's
       own derivation is correct, so leave it completely alone. */
    if (IS_BLOB && TARGET) {
      installVirtualIdentity(client, TARGET);
      if (!activeClient) activeClient = client;
    }

    client.hook();
    return client;
  }

  /* Why there is deliberately NO <base> injected here.
   *
   * A blob: document has no path for relative URLs to resolve against, so
   * injecting a <base> pointing at this page's proxied URL looks like the
   * obvious fix. It is not: scramjet's meta.base getter READS the <base>
   * element, so relative URLs then resolved to an already-proxied URL and
   * scramjet rewrote them a second time. Requests came out as
   * /rp/<our origin>/rp/<target>, which trips scramjet's own same-origin
   * guard -- GeForce NOW could not read its config.json and refused to
   * boot, with an empty body and no thrown error.
   *
   * With no base, meta.base falls back to client.url, which
   * installVirtualIdentity has already set to the real target, and the
   * server's HTML rewriter has made the markup URLs absolute anyway. Both
   * consumers then agree. Removing the base is what made GeForce NOW
   * render in a blob tab: 1363 characters and 30 images, up from nothing.
   */

  try {
    makeHistorySafeForBlob();   // must run before the client captures natives
    bootClient(globalThis);
  } catch (err) {
    rpRecord('boot', (err && err.message) || String(err));
    console.error('[redproxy] client failed to hook', err);
  }
})();
