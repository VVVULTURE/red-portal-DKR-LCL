/**
 * Red Proxy — service worker for the embedded proxy (frame.html)
 * ==============================================================
 * Scope is "/redproxy/", NOT the site root.
 *
 * The Controller's proxied-URL prefix is configurable (`config.prefix`,
 * default "/~/sj/"), and frame.js sets it to "/redproxy/sj/" precisely so
 * this worker's natural max scope -- the directory its own script is
 * served from -- already covers every URL it will ever need to intercept.
 * That removes the need for a Service-Worker-Allowed header, and, far more
 * importantly, means this worker can never see a single request belonging
 * to the rest of Red Portal: not index.html, not a game under Games/, not
 * an icon on assets.redportal.dpdns.org. The previous implementation
 * registered at root scope "/" and relied on shouldRoute() alone to stay
 * out of the way of the other 99% of the site; this one cannot reach that
 * traffic in the first place, which is a structural guarantee rather than
 * a behavioral one.
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
