/**
 * Red Proxy — service worker
 * ===========================
 * Registered at root scope "/" (see register-sw.js — has to be, since
 * Scramjet's own codec rewrites proxied URLs to live under its internal
 * prefix at the site root, not under /redproxy/). It only actually acts on
 * requests that fall under that internal proxy prefix; everything else
 * (Red Portal itself, Games/, Testing/, assets/) is meant to pass straight
 * through via a plain fetch(), unchanged from having no service worker at
 * all -- see the same-origin bypass below for why that's now guaranteed
 * rather than just intended.
 *
 * REGRESSION FIXED HERE: the previous version always called
 * scramjet.loadConfig()/route() first, for every single request on the
 * ENTIRE origin (root scope), before ever falling back to a plain fetch.
 * Once this worker got installed (which happens the first time anyone
 * opens the Red Proxy tab), it stayed registered and kept intercepting
 * every future page load site-wide -- and a cross-origin request (e.g. a
 * game icon on assets.redportal.dpdns.org) made scramjet.route()/fetch()
 * reject instead of ever reaching the fallback, which the browser then
 * reported as the resource failing to load outright. That's why icons,
 * the logo, and other R2-hosted assets could vanish sitewide after
 * someone merely tried the proxy once -- confirmed by reproducing it
 * locally: reload the main page after using the proxy once, and every
 * cross-origin asset request comes back net::ERR_FAILED.
 *
 * Fix: bail out to a plain fetch() immediately -- before touching
 * Scramjet at all -- for anything that isn't even on this origin.
 * Scramjet's own rewritten proxy URLs always live under THIS origin (the
 * /scramjet/<encoded> prefix), so this can never intercept a real proxy
 * target; it only guarantees ordinary site traffic never touches Scramjet.
 * The try/catch around the same-origin path is defense in depth, in case
 * loadConfig()/route()/fetch() ever throws for some other reason.
 */
importScripts('/scram/scramjet.all.js');

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
  let url;
  try { url = new URL(event.request.url); } catch { return fetch(event.request); }

  // Fast, synchronous bypass -- never let cross-origin site traffic (game
  // icons, tutorial videos, anything on assets.redportal.dpdns.org, etc.)
  // anywhere near Scramjet's async config/routing logic.
  if (url.origin !== self.location.origin) {
    return fetch(event.request);
  }

  try {
    await scramjet.loadConfig();
    if (scramjet.route(event)) {
      return await fetchScramjetWithRetry(event);
    }
  } catch (err) {
    console.error('[redproxy sw] scramjet error, falling back to plain fetch:', err);
  }
  return fetch(event.request);
}

/**
 * scramjet.fetch() ultimately calls into bare-mux's SharedWorker, which
 * lazily constructs+inits the libcurl-transport BareTransport on the
 * FIRST fetch/websocket message it ever processes (see bare-mux's
 * worker.js: `s.ready || await s.init()`). That's a real, confirmed
 * upstream ordering bug in @mercuryworkshop/libcurl-transport's own
 * LibcurlClient.init(): it constructs `new libcurl.HTTPSession(...)`
 * BEFORE checking whether the underlying WASM runtime has finished
 * loading, and HTTPSession's constructor synchronously throws
 * "wasm not loaded yet, please call libcurl.load_wasm first" if it
 * hasn't -- instead of waiting first, the way the rest of that same
 * init() function does. So the very first proxied request in this
 * worker's lifetime can throw that error even though the WASM finishes
 * loading correctly moments later (confirmed: it's a one-time,
 * worker-lifetime `wasm_ready` flag internal to that module -- every
 * request after the first successful one is unaffected).
 *
 * Rather than patch the vendored dependency directly (fragile across
 * package updates), retry the SAME request a few times with a short
 * delay -- by the second or third attempt the WASM has always finished
 * loading in every test run. Only this specific, known-transient error
 * is retried; anything else fails immediately.
 */
async function fetchScramjetWithRetry(event) {
  const MAX_ATTEMPTS = 6;
  const RETRY_DELAY_MS = 350;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await scramjet.fetch(event);
    } catch (err) {
      const isWasmRace = err && typeof err.message === 'string' && err.message.includes('wasm not loaded yet');
      if (!isWasmRace || attempt === MAX_ATTEMPTS) throw err;
      console.warn(`[redproxy sw] libcurl WASM not ready yet, retrying (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});

// Take over immediately on install/activate instead of waiting for every
// tab running the OLD (buggy) worker to close first -- so once the fix
// above is deployed, it actually reaches people who already have the
// broken worker registered from before, on their very next visit.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
