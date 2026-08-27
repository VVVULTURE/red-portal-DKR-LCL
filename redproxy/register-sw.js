'use strict';
/**
 * Registers the Red Proxy service worker.
 *
 * MUST be scope "/" (root), not "/redproxy/" -- Scramjet's own codec
 * rewrites proxied URLs to live under its own internal prefix at the site
 * root (e.g. /scramjet/<encoded>), not under whatever folder happened to
 * register it. A narrower scope silently never intercepts those
 * navigations at all, and the site's own SPA-fallback then serves Red
 * Portal's homepage in their place instead (confirmed by hand -- this is
 * exactly what happened before this was widened to "/").
 *
 * Root scope is still safe for the rest of the site: sw.js's fetch handler
 * only touches requests scramjet's own router recognizes as its rewritten
 * paths; everything else (Red Portal itself, Games/, Testing/, assets/)
 * falls through to a plain `fetch(event.request)` passthrough, identical
 * to there being no service worker at all -- verified nothing else on the
 * site changes behavior with this registered.
 */
const REDPROXY_SW_PATH  = '/redproxy/sw.js';
const REDPROXY_SW_SCOPE = '/';

// Service workers require a secure context — https, or localhost/127.0.0.1
// for local dev.
const SW_ALLOWED_HTTP_HOSTNAMES = ['localhost', '127.0.0.1'];

async function registerRedProxySW() {
  if (!navigator.serviceWorker) {
    if (location.protocol !== 'https:' && !SW_ALLOWED_HTTP_HOSTNAMES.includes(location.hostname)) {
      throw new Error('Red Proxy needs HTTPS to run (service workers require a secure context).');
    }
    throw new Error("This browser doesn't support service workers.");
  }
  // NOTE: deliberately not awaiting navigator.serviceWorker.ready here --
  // it resolves unreliably slowly (or not within a useful window) on a
  // page's very first-ever registration in some browsers/environments,
  // and register() having resolved is already enough: the registration is
  // active by the time this returns, which is all the next navigation needs.
  await navigator.serviceWorker.register(REDPROXY_SW_PATH, { scope: REDPROXY_SW_SCOPE });
}
