'use strict';
/**
 * Red Proxy — embedded proxy runtime
 * ===================================
 * This file runs inside frame.html, which Red Portal's "Red Proxy" tab
 * embeds as an <iframe> pointing at an ABSOLUTE https://<portal>/ URL.
 *
 * Why an iframe, and why this file is self-contained
 * --------------------------------------------------
 * Red Portal is frequently opened through an external launcher that
 * fetches its HTML and re-hosts it as a blob: URL. A blob: URL carries the
 * origin of the page that CREATED it, so in that situation Red Portal's
 * own document is running on the launcher's origin -- not the portal's.
 * navigator.serviceWorker.register() rejects with SecurityError whenever
 * the requested scope's origin differs from the calling document's origin,
 * and no header, config value or <base> tag changes that: it is a flat
 * same-origin rule. So the proxy can never boot from Red Portal's own
 * document in the blob case.
 *
 * Putting the entire stack behind an absolute-URL iframe sidesteps that
 * completely. THIS document is always served from the portal's real
 * origin over https, whatever the parent happens to be, so registration
 * here is an ordinary same-origin registration. The parent page does not
 * participate at all -- it owns no proxy state, holds no controller, and
 * needs no postMessage bridge, which is also why the toolbar lives in here
 * rather than up in index.html. One code path serves both the normal tab
 * and the blob tab; there is no second mode to keep working.
 *
 * Cross-origin isolation is deliberately not required. crossOriginIsolated
 * can never be true when the top-level document belongs to someone else,
 * and it is optional here regardless: the Controller only consults it to
 * decide whether to copy COEP/COOP headers onto proxied responses, and it
 * defaults to false. libcurl-transport carries no SharedArrayBuffer
 * dependency (verified against the shipped bundle).
 */

/* ── Paths. All absolute: this document is always at a real https origin,
   and every one of these is served by Red Portal's own server.js. ── */
const SW_PATH   = '/redproxy/frame-sw.js';
const SW_SCOPE  = '/redproxy/';
const SJ_PREFIX = '/redproxy/sj/';   // must stay under SW_SCOPE

const SCRAMJET_BUNDLE   = '/scram/scramjet.js';
const SCRAMJET_WASM     = '/scram/scramjet.wasm';
const SCRAMJET_UTILS    = '/scram/scramjet-utils.js';
const CONTROLLER_API    = '/controller/controller.api.js';
const CONTROLLER_INJECT = '/controller/controller.inject.js';
const LIBCURL_CLIENT    = '/libcurl/index.js';

const SEARCH_TEMPLATE = 'https://www.google.com/search?q=%s';

/* The previous implementation registered its worker at root scope "/".
   A stale one may still be installed in a returning visitor's browser,
   where it would keep intercepting site-wide traffic forever. Clean up
   that exact script only -- never any other registration. */
const LEGACY_SW_SCRIPT = '/redproxy/sw.js';

const $address = document.getElementById('rp-address');
const $form    = document.getElementById('rp-form');
const $go      = document.getElementById('rp-go');
const $back    = document.getElementById('rp-back');
const $forward = document.getElementById('rp-forward');
const $reload  = document.getElementById('rp-reload');
const $status  = document.getElementById('rp-status');
const $frameEl = document.getElementById('rp-frame');
const $splash  = document.getElementById('rp-splash');

let controller = null;
let frame = null;
let bootPromise = null;

function setStatus(message, isError) {
  $status.textContent = message || '';
  $status.classList.toggle('err', !!isError);
}

/* How long any single boot step may take before it is treated as hung.
   Generous: the engine bundles total a couple of megabytes, and when Red
   Portal is embedded by a launcher the browser partitions storage by the
   top-level site, so none of it can be served from a cache another site
   already warmed. */
const STEP_TIMEOUT_MS = 30000;

/* Keeping the service worker alive
   --------------------------------
   The worker holds the set of proxied URL prefixes it should intercept in
   a plain module-level array, built up from the $controller$init message
   each Controller sends it. That array is ordinary in-memory state, so a
   browser terminating the worker for being idle (Chrome does this after
   roughly 30 seconds) silently empties it.

   When the worker is next started -- by, say, the very navigation we
   wanted proxied -- its shouldRoute() finds no matching prefix, declines
   to intercept, and the request goes out to the real network. It then
   lands on this server's /redproxy/sj/ guard instead of the proxied site.
   Scramjet recovers from this by having the restarted worker ask every
   client to re-send its message port, but that only happens 100ms after
   startup (see the "the only way to know if a service worker has suddenly
   died" comment in the controller's sw.ts), which is far too late for the
   request that did the waking.

   So don't let it go idle in the first place: delivering a message event
   resets the worker's idle timer, and this page is only ever open while
   someone is actually using the proxy. The interval is well inside
   Chrome's window, and unrecognized messages are ignored by the worker's
   own handler, so this costs nothing but the wakeup.

   This is not specific to being blob-embedded. It would strand anyone who
   left the Red Proxy tab open for half a minute before typing a URL. */
const HEARTBEAT_MS = 10000;

/* If the worker did die anyway (memory pressure, a laptop resuming from
   sleep), the Controller re-registers its prefix when the worker asks it
   to. Navigating during that window would race it, so a navigation waits
   this long after a revive before going ahead. */
const REVIVE_SETTLE_MS = 400;

let reviveSettled = Promise.resolve();

function watchForServiceWorkerRevival() {
  if (!navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (!event.data || !event.data.$controller$swrevive) return;
    // The Controller answers this same event by re-sending its port. Hold
    // navigations briefly so one cannot overtake that handshake.
    reviveSettled = new Promise((resolve) => setTimeout(resolve, REVIVE_SETTLE_MS));
  });
}

function startServiceWorkerHeartbeat(serviceworker) {
  /* Deliberately re-resolves the active worker on every beat rather than
     holding the one captured at boot. That original object goes redundant
     the moment an update takes over -- which is exactly what a deploy of
     frame-sw.js does to a tab that is already open -- and posting to a
     redundant worker throws. Caught, that would leave the heartbeat
     silently dead and hand back the very bug this exists to prevent. */
  const ping = async () => {
    let target = serviceworker;
    try {
      const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
      if (registration && registration.active) target = registration.active;
    } catch (_) { /* fall back to the worker we booted with */ }
    try {
      if (target) target.postMessage({ $redproxy$keepalive: Date.now() });
    } catch (_) { /* gone entirely; the revive path re-establishes it */ }
  };
  ping();
  setInterval(ping, HEARTBEAT_MS);
  // Coming back to a backgrounded tab is exactly when the worker is most
  // likely to have been reclaimed, and throttled timers may have stopped.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ping();
  });
}

/** Runs one boot step, showing which step is in flight and failing loudly
 *  if it never settles.
 *
 *  Both halves matter. Naming the step turns "it just says Starting Red
 *  Proxy forever" into something diagnosable by whoever is looking at the
 *  screen. The timeout exists because the steps below are not all
 *  guaranteed to reject on their own -- a service worker handshake that
 *  never gets an answer simply waits, so without this the UI would sit on
 *  a spinner indefinitely rather than reporting a failure. */
function step(label, promise) {
  setBusy('Starting Red Proxy… (' + label + ')');
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('timed out after ' + (STEP_TIMEOUT_MS / 1000) + 's while ' + label)),
      STEP_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Progress goes in the status line AND the centre-of-frame splash: the
 *  splash is what is actually readable at a glance, especially when this
 *  page is embedded in Red Portal's tab. */
function setBusy(message) {
  setStatus(message);
  const p = $splash.querySelector('p');
  if (p) p.textContent = message;
}

/** Turn whatever was typed into a URL: a real URL, a bare hostname, or a
 *  search query. A single-label host with no dot is treated as a search,
 *  so "red portal" does not become a bogus navigation. */
function toTargetUrl(input) {
  try {
    return new URL(input).toString();
  } catch (_) { /* not a full URL */ }

  try {
    const url = new URL('https://' + input);
    if (url.hostname.includes('.')) return url.toString();
  } catch (_) { /* not a hostname either */ }

  return SEARCH_TEMPLATE.replace('%s', encodeURIComponent(input));
}

/** Load scripts in strict document order. Dynamically-created <script>
 *  elements default to async=true and can otherwise execute in
 *  fetch-completion order, which breaks this chain: controller.api.js
 *  reads globalThis.$scramjet the moment it runs, so scramjet.js must
 *  have finished first. async=false restores in-order execution while
 *  still allowing parallel fetching. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(el);
  });
}

async function removeLegacyRootWorker() {
  if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return;

  let registrations;
  try {
    registrations = await navigator.serviceWorker.getRegistrations();
  } catch (_) {
    return; // not fatal -- never let cleanup block the boot
  }

  await Promise.all(registrations.map(async (registration) => {
    const worker = registration.active || registration.waiting || registration.installing;
    if (!worker) return;

    let scriptPath;
    try {
      scriptPath = new URL(worker.scriptURL).pathname;
    } catch (_) {
      return;
    }
    if (scriptPath !== LEGACY_SW_SCRIPT) return;

    try {
      await registration.unregister();
      console.info('[redproxy] removed stale root-scope service worker', worker.scriptURL);
    } catch (_) { /* best effort */ }
  }));
}

async function registerWorker() {
  if (!navigator.serviceWorker) {
    // Service workers need a secure context. Being framed by a blob: page
    // does not remove one -- this document is still https -- so if the API
    // is missing at all, it is the browser or an http origin, not the
    // embedding, that is responsible.
    throw new Error(
      location.protocol === 'https:'
        ? 'This browser does not support service workers, which Red Proxy requires.'
        : 'Red Proxy needs to be served over HTTPS (service workers require a secure context).'
    );
  }

  const registration = await navigator.serviceWorker.register(SW_PATH, {
    scope: SW_SCOPE,
    type: 'classic',
    updateViaCache: 'none',
  });

  if (registration.active) return registration.active;

  const pending = registration.installing || registration.waiting;
  if (!pending) {
    await navigator.serviceWorker.ready;
    if (registration.active) return registration.active;
    throw new Error('The Red Proxy service worker registered but never activated.');
  }

  await new Promise((resolve, reject) => {
    pending.addEventListener('statechange', function onChange() {
      if (pending.state === 'activated') {
        pending.removeEventListener('statechange', onChange);
        resolve();
      } else if (pending.state === 'redundant') {
        pending.removeEventListener('statechange', onChange);
        reject(new Error('The Red Proxy service worker was discarded before it could activate.'));
      }
    });
  });

  return registration.active;
}

/** Registers the worker, loads the bundles, and builds a ready Controller
 *  attached to the already-in-the-DOM #rp-frame iframe. Runs exactly once
 *  however many times it is called; a failure clears the memo so a retry
 *  is possible after, say, a transient network error. */
function boot() {
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    setBusy('Starting Red Proxy…');

    await step('clearing out old workers', removeLegacyRootWorker());

    const serviceworker = await step('registering the service worker', registerWorker());

    await step('loading the proxy engine', (async () => {
      await loadScript(SCRAMJET_BUNDLE);
      await loadScript(CONTROLLER_API);
      await loadScript(SCRAMJET_UTILS);
      await loadScript(LIBCURL_CLIENT);
    })());

    const wispUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/wisp/';
    const transport = new window.LibcurlTransport.LibcurlClient({ wisp: wispUrl });

    const { Controller, config } = window.$scramjetController;
    // Set before constructing: the Controller reads config.prefix in its
    // constructor to compute the prefix it registers with the worker.
    config.prefix       = SJ_PREFIX;
    config.scramjetPath = SCRAMJET_BUNDLE;
    config.wasmPath     = SCRAMJET_WASM;
    config.injectPath   = CONTROLLER_INJECT;

    controller = new Controller({ serviceworker, transport });
    // Waits on a round trip to the service worker plus the WASM load. This
    // is the step with no failure mode of its own, so the timeout above is
    // what stops a lost handshake from hanging the UI forever.
    await step('connecting to the service worker', controller.wait());

    const urlWatcher = new window.$scramjetUtils.UrlWatcherPlugin((url) => {
      $address.value = url;
      $back.disabled = false;
      $forward.disabled = false;
      $reload.disabled = false;
      $splash.hidden = true;
    });

    frame = controller.createFrame($frameEl, { plugins: [urlWatcher] });

    // Only now that a Controller exists (and has registered its prefix
    // with the worker) is there anything worth keeping alive.
    watchForServiceWorkerRevival();
    startServiceWorkerHeartbeat(serviceworker);

    $address.disabled = false;
    $go.disabled = false;
    setStatus('');
    const idle = $splash.querySelector('p');
    if (idle) idle.textContent = 'Type a URL or search above to get started.';
  })().catch((err) => {
    bootPromise = null;
    console.error('[redproxy]', err);
    const message = 'Red Proxy failed to start: ' + err.message;
    setStatus(message, true);
    const p = $splash.querySelector('p');
    if (p) p.textContent = message;
    throw err;
  });

  return bootPromise;
}

async function navigate(input) {
  const value = (input || '').trim();
  if (!value) return;

  try {
    await boot();
  } catch (_) {
    return; // boot() already surfaced the failure in the status line
  }

  try {
    setStatus('');
    // No-op unless the worker was revived a moment ago, in which case this
    // waits for it to have our prefix back before we navigate into it.
    await reviveSettled;
    await frame.go(toTargetUrl(value));
  } catch (err) {
    console.error('[redproxy] navigation failed', err);
    setStatus('Could not load that page: ' + err.message, true);
  }
}

$form.addEventListener('submit', (event) => {
  event.preventDefault();
  navigate($address.value);
});

$back.addEventListener('click', () => frame && frame.back());
$forward.addEventListener('click', () => frame && frame.forward());
$reload.addEventListener('click', () => frame && frame.reload());

/* Boot as soon as this document loads rather than waiting for the first
   submit: the tab only ever embeds this page when the user has actually
   opened Red Proxy, and the WASM/transport setup is the slow part. The
   address bar unlocks when it finishes. */
boot().catch(() => { /* surfaced in the status line */ });

/* An optional ?url= lets the tab (or a link) deep-link straight to a
   destination instead of landing on an empty address bar. */
const requestedUrl = new URLSearchParams(location.search).get('url');
if (requestedUrl) {
  $address.value = requestedUrl;
  navigate(requestedUrl);
}
