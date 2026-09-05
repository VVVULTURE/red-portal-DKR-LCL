/**
 * Red Proxy — service worker for the embedded proxy (frame.html)
 * ==============================================================
 * Registered at root scope "/" (see frame.js's explicit {scope:'/'} and
 * the Service-Worker-Allowed header server.js sends for this path).
 *
 * Not because the proxied URLs need it -- frame.js puts them under
 * "/redproxy/sj/", which this worker's own directory would cover -- but
 * because the Controller runs inside Red Portal's document at "/", and a
 * worker reaches its page through clients.matchAll(), which returns only
 * clients it CONTROLS. A narrower scope would leave index.html
 * uncontrolled and silently cut it off from the cookie-sync broadcasts
 * and from the revive message a restarted worker sends to recover its
 * prefixes.
 *
 * Root scope stays safe for the rest of the site because of the early
 * return below: for anything shouldRoute() does not claim, this worker
 * never calls respondWith(), so Red Portal, the games and the R2-hosted
 * assets behave exactly as if no worker were installed. The earlier
 * site-wide breakage was not caused by root scope itself but by the
 * worker script being served WITH COEP -- a worker inherits cross-origin
 * isolation from its own script response and then imposes it on every
 * request it touches. This file is deliberately served without it.
 *
 * controller.sw.js supplies $scramjetController and wires its own
 * install/activate handlers (skipWaiting + clients.claim) -- verified
 * directly in the built bundle -- so nothing else is needed here.
 */
importScripts('/controller/controller.sw.js');

addEventListener('fetch', (event) => {
  // shouldRoute() matches on the prefixes the Controller registered with
  // this worker over its message port. Anything else -- including
  // frame.html itself and the /scram//controller//libcurl/ bundles the
  // proxied document pulls in -- is left entirely alone, so it falls
  // through to the network exactly as if no worker existed.
  if (!$scramjetController.shouldRoute(event)) return;

  event.respondWith(
    $scramjetController.route(event).catch(async (err) => {
      // respondWith()ing a rejected promise surfaces only an opaque
      // "ServiceWorker intercepted the request and encountered an
      // unexpected error" with no indication of what actually failed.
      // Log the real cause, then fall back to a direct fetch so a single
      // failed subresource can't take the whole page down with it.
      console.error('[redproxy] route() failed for', event.request.url, (err && err.stack) || err);
      try {
        return await fetch(event.request);
      } catch (fetchErr) {
        console.error('[redproxy] fallback fetch failed for', event.request.url, fetchErr);
        return new Response('Red Proxy could not load this request: ' + ((err && err.message) || err), {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        });
      }
    })
  );
});
