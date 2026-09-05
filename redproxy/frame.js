'use strict';
/**
 * Red Proxy — proxy engine and launcher
 * ======================================
 * Loaded into Red Portal's own document (index.html) when the Red Proxy
 * tab is opened, and by the standalone /redproxy/frame.html page. Both
 * hosts give it the same toolbar markup and it drives them identically.
 *
 * No iframes anywhere
 * -------------------
 * The page that owns this script IS the engine: it registers the service
 * worker, builds the Controller and the libcurl transport, and answers
 * every proxied request the worker forwards to it. Proxied pages open as
 * real, top-level tabs at the Controller's own prefix, so nothing is ever
 * rendered inside Red Portal. Two consequences worth knowing:
 *
 *   - Sites that refuse to be framed are no longer a problem at all,
 *     because nothing is framed.
 *   - This page has to stay open. It is the engine; close it and the
 *     opened tabs lose the Controller that serves them.
 *
 * The one thing a browser will not allow is showing the target's own URL
 * in the address bar of those tabs -- a document can only ever display a
 * URL on the origin that served it, which is what stops sites spoofing
 * each other. READABLE_CODEC below is the next best thing: it keeps the
 * target legible inside the proxied address instead of percent-mangled.
 *
 * Why a blob: page can never be the engine
 * ----------------------------------------
 * Red Portal is often opened through an external launcher that re-hosts
 * it as a blob: URL. A blob: URL does inherit the origin of whoever
 * created it, so a blob made by Red Portal itself really is on the
 * portal's origin -- but that still does not help: a blob: document
 * cannot use service workers at all. Registering from one fails with
 * InvalidStateError ("the document is in an invalid state"), and even
 * getRegistrations() throws. Both were confirmed directly in Chrome.
 * So when Red Portal finds itself blob-wrapped it opens a real
 * portal-origin tab to act as the engine instead (see index.html).
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
/* Root scope, which is wider than this worker's own directory and so
   needs the Service-Worker-Allowed header server.js sends for this path.
   Not for the reason the old implementation needed it (its proxied URLs
   genuinely lived at the site root; ours are under SJ_PREFIX and would
   fit a "/redproxy/" scope perfectly well) but because the Controller now
   runs inside Red Portal's own document at "/", and the worker talks to
   its page through clients.matchAll() -- which returns ONLY clients the
   worker controls. Left at "/redproxy/", index.html would be an
   uncontrolled client and would silently never receive two things: the
   cookie broadcasts that keep the Controller's jar in sync (so logins on
   proxied sites would break) and the revive message a restarted worker
   sends to get its prefixes back.

   This is safe for the rest of the site in a way the old root-scope
   worker was not. frame-sw.js returns immediately from its fetch handler
   for anything shouldRoute() does not claim, never calling respondWith(),
   so ordinary traffic behaves exactly as if no worker existed -- and it
   is served WITHOUT COEP/COOP, which is what actually caused the earlier
   site-wide R2 asset breakage (a worker inherits cross-origin isolation
   from its own script response and imposes it on everything it touches). */
const SW_SCOPE  = '/';
const SJ_PREFIX = '/redproxy/sj/';   // must stay under SW_SCOPE

const SCRAMJET_BUNDLE   = '/scram/scramjet.js';
const SCRAMJET_WASM     = '/scram/scramjet.wasm';
const SCRAMJET_UTILS    = '/scram/scramjet-utils.js';
const CONTROLLER_API    = '/controller/controller.api.js';
const CONTROLLER_INJECT = '/controller/controller.inject.js';
const LIBCURL_CLIENT    = '/libcurl/index.js';

const SEARCH_TEMPLATE = 'https://www.google.com/search?q=%s';

/* Keeps the target URL legible in the address bar.
   ------------------------------------------------
   Scramjet's default codec is encodeURIComponent, which turns a proxied
   page's address into .../sj/<ids>/https%3A%2F%2Fexample.com%2F. Now that
   pages open as real tabs, that string is what someone actually reads, so
   escape only the characters that genuinely cannot survive as-is and
   leave the rest alone: .../sj/<ids>/https://example.com/

   Exactly three characters have to be escaped, and each for a concrete
   reason found in scramjet's own url rewriter:

     ?  rewriteUrl() appends scramjet's own "?params" AFTER the encoded
        segment, and unrewriteUrl() does `realUrl.search = ""` before
        decoding. A literal ? in the target would merge with those and
        then be thrown away, silently losing the site's query string.
     #  a literal fragment would terminate the path early; scramjet
        carries the real hash separately and re-appends it.
     %  must be escaped first, or decoding could not tell an escape this
        codec produced from one that was already in the URL.

   These two functions are serialized with Function.prototype.toString()
   and re-evaluated inside every proxied page, so they must stay
   self-contained -- no closures, no outside references. */
const READABLE_CODEC = {
  encode: (url) => {
    if (!url) return url;
    return url
      .replace(/%/g, '%25')
      .replace(/\?/g, '%3F')
      .replace(/#/g, '%23');
  },
  decode: (url) => {
    if (!url) return url;
    return url
      .replace(/%23/gi, '#')
      .replace(/%3F/gi, '?')
      .replace(/%25/gi, '%');
  },
};

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
    config.codec        = READABLE_CODEC;

    controller = new Controller({ serviceworker, transport });
    // Waits on a round trip to the service worker plus the WASM load. This
    // is the step with no failure mode of its own, so the timeout above is
    // what stops a lost handshake from hanging the UI forever.
    await step('connecting to the service worker', controller.wait());

    /* A Frame has to exist for a page to be servable: the worker routes on
       the Controller's prefix, and the Controller then answers only if one
       of its frames' prefixes matches the path. What a Frame does NOT have
       to be is rendered. Pages open as real tabs here, so this element is
       a detached <div> that is never inserted into the document and never
       loads anything -- it exists purely to own frame.prefix.

       Deliberately not createFrame() with no argument: that default
       constructs an <iframe> internally, and Red Portal's rule is that no
       iframe element gets created at all. Frame only ever sets an expando
       on this element, assigns .src (a harmless expando on a div, unused
       here because we never call frame.go()), and reads .contentWindow
       behind optional chaining -- so a div satisfies it completely. */
    frame = controller.createFrame(document.createElement('div'));

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

/* The tab currently showing a proxied page, so the toolbar can still
   drive it. Same-origin (it is a redportal.dpdns.org URL), so reaching
   into its history is allowed even though it is a separate tab. */
let openedTab = null;

function tabIsUsable() {
  try {
    return !!openedTab && !openedTab.closed;
  } catch (_) {
    return false;
  }
}

function refreshNavButtons() {
  const usable = tabIsUsable();
  $back.disabled = !usable;
  $forward.disabled = !usable;
  $reload.disabled = !usable;
}

/** Builds the proxied address for a target and opens it as a real tab.
 *
 *  This is what replaces frame.go(): rather than pointing a nested frame
 *  at the proxied URL, the page becomes the top-level document of its own
 *  tab. Nothing renders inside Red Portal, so no iframe is needed
 *  anywhere -- and sites that refuse to be framed stop being a problem,
 *  since nothing is framed.
 *
 *  This page stays open as the engine: the worker forwards every proxied
 *  request back to the Controller living here, so closing Red Portal
 *  stops the opened tabs working. That is surfaced rather than left to
 *  fail silently -- see the closed-tab check below. */
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
    // waits for it to have our prefix back before we open into it.
    await reviveSettled;

    const target = toTargetUrl(value);
    const proxied = new URL(
      frame.prefix + READABLE_CODEC.encode(target),
      location.origin
    ).href;

    const tab = window.open(proxied, '_blank');
    if (!tab) {
      setStatus('Your browser blocked the new tab. Allow pop-ups for this site, then try again.', true);
      return;
    }

    openedTab = tab;
    refreshNavButtons();
    $address.value = target;
    const p = $splash.querySelector('p');
    if (p) p.textContent = 'Opened in a new tab. Keep Red Portal open — it runs the proxy.';
  } catch (err) {
    console.error('[redproxy] navigation failed', err);
    setStatus('Could not open that page: ' + err.message, true);
  }
}

$form.addEventListener('submit', (event) => {
  event.preventDefault();
  navigate($address.value);
});

/* Drive the opened tab's own history. It is same-origin, so this is
   permitted; if it has since been closed the buttons go back to disabled
   rather than throwing. */
function withOpenedTab(action) {
  if (!tabIsUsable()) {
    openedTab = null;
    refreshNavButtons();
    return;
  }
  try {
    action(openedTab);
  } catch (err) {
    console.error('[redproxy] could not reach the opened tab', err);
    setStatus('Could not reach that tab.', true);
  }
}

$back.addEventListener('click', () => withOpenedTab((w) => w.history.back()));
$forward.addEventListener('click', () => withOpenedTab((w) => w.history.forward()));
$reload.addEventListener('click', () => withOpenedTab((w) => w.location.reload()));

// Keep the buttons honest if the user closes the proxied tab themselves.
setInterval(refreshNavButtons, 1500);

/* Boot as soon as this document loads rather than waiting for the first
   submit: the tab only ever embeds this page when the user has actually
   opened Red Proxy, and the WASM/transport setup is the slow part. The
   address bar unlocks when it finishes. */
boot().catch(() => { /* surfaced in the status line */ });

/* An optional ?url= lets a link deep-link straight to a destination
   instead of landing on an empty address bar.

   Only honoured on the standalone /redproxy/frame.html page, which marks
   itself with data-rp-standalone. This same file is also loaded directly
   into Red Portal's own document, where the query string belongs to Red
   Portal rather than to the proxy -- reading it there would let any
   ?url= on a Red Portal link silently drive the proxy somewhere. */
if (document.body.hasAttribute('data-rp-standalone')) {
  const requestedUrl = new URLSearchParams(location.search).get('url');
  if (requestedUrl) {
    $address.value = requestedUrl;
    navigate(requestedUrl);
  }
}
