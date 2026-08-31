/**
 * Red Proxy — service worker (Scramjet Controller architecture)
 * ================================================================
 * Registered at root scope "/" (see controller-init.js's explicit
 * {scope:'/'} and the Service-Worker-Allowed header server.js sends for
 * this path) -- Scramjet's own codec rewrites proxied URLs to live under
 * its internal prefix at the site root, not under /redproxy/, so a
 * narrower scope would silently never intercept them.
 *
 * controller.sw.js's own shouldRoute(event) is what keeps this safe for
 * the rest of the site: it returns false for anything that isn't one of
 * this controller's own recognized (same-origin, scramjet-prefixed)
 * URLs, so nothing here ever touches -- or even calls respondWith() for
 * -- ordinary site traffic (Red Portal itself, Games/Testing/, R2-hosted
 * assets). That matters a lot here specifically: a service worker
 * inherits COEP/COOP from its OWN script response (this file is served
 * WITHOUT those headers, isolate:false in server.js), and this worker is
 * registered at root scope for the whole origin -- calling respondWith()
 * unconditionally for every request would risk exactly the sitewide
 * asset-breakage regression this project hit once already with the
 * previous (pre-Controller) service worker (see project memory, Bug #4).
 * controller.sw.js also wires its own install/activate handlers
 * (skipWaiting/clients.claim) -- nothing extra needed here for that.
 */
importScripts('/controller/controller.sw.js');

addEventListener('fetch', (event) => {
  if ($scramjetController.shouldRoute(event)) {
    event.respondWith(
      $scramjetController.route(event).catch((err) => {
        // route() can reject (e.g. for a nested iframe's own document
        // request under some edge cases) -- respondWith()'ing a rejected
        // promise with no catch surfaces only a generic, undiagnosable
        // "ServiceWorker intercepted the request and encountered an
        // unexpected error" to the page, with zero detail about WHAT
        // failed or why. Log the real error, then fall back to a plain
        // passthrough fetch rather than leaving the request hanging.
        console.error('[redproxy sw] route() failed for', event.request.url, err && err.stack || err);
        return fetch(event.request).catch((fetchErr) => {
          console.error('[redproxy sw] fallback fetch also failed for', event.request.url, fetchErr);
          return new Response('Red Proxy error: ' + (err && err.message || err), { status: 502 });
        });
      })
    );
  }
});
