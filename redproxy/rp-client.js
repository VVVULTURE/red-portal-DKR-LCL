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

  var sj = globalThis.$scramjet;
  if (!sj || !sj.ScramjetClient) {
    console.error('[redproxy] scramjet bundle missing; the page will not be proxied');
    return;
  }

  /* Read these before hooking. Once the client is installed it replaces
     location with a proxy that reports the TARGET site's URL, so asking
     afterwards would give the proxied site's origin instead of ours. */
  var ORIGIN = location.origin;
  var PREFIX = ORIGIN + '/rp/';

  function codecEncode(input) { return input ? encodeURIComponent(input) : input; }
  function codecDecode(input) { return input ? decodeURIComponent(input) : input; }

  function getInjectScripts(meta, handler, htmlcontext, script) {
    return [
      script(ORIGIN + '/scram/scramjet.js'),
      script(ORIGIN + '/rp-wasm.js'),
      script(ORIGIN + '/rp-client.js'),
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
      return fetch(PREFIX + codecEncode(String(remote)), {
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
    connect: function () {
      throw new Error('[redproxy] websockets are not wired up yet');
    },
  };

  function bootClient(scope) {
    var client = new sj.ScramjetClient(scope, {
      context: makeContext(),
      transport: transport,
      sendSetCookie: function () { return Promise.resolve(); },
      hookSubcontext: function (sub) { return bootClient(sub); },
      initHeaders: [],
      history: [],
    });
    client.hook();
    return client;
  }

  try {
    bootClient(globalThis);
  } catch (err) {
    console.error('[redproxy] client failed to hook', err);
  }
})();
