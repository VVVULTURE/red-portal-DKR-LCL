'use strict';
/**
 * Red Proxy — shared client bootstrap (Scramjet Controller architecture)
 * =========================================================================
 * Used by embed.html, the standalone /redproxy page (app.js), and
 * index.html's in-page Red Proxy section -- one copy of this sequence
 * instead of three. Mirrors MercuryWorkshop's own reference bootstrap
 * (github.com/MercuryWorkshop/scramjet, packages/bootstrap/src/client.ts)
 * exactly in spirit: register the service worker, load the core bundles,
 * construct a transport talking directly to THIS server's own /wisp/
 * endpoint (no external proxy/wisp service anywhere), then build a
 * Controller. Adapted from their runtime-npm-download approach to this
 * project's normal build-time-installed-dependency static file layout
 * (see server.js's /scram/, /controller/, /libcurl/ routes) -- same
 * packages, same versions, just served from disk instead of fetched from
 * the npm registry on every boot.
 */

function rpLoadScriptOnce(src) {
  window.__rpLoadedScripts = window.__rpLoadedScripts || new Map();
  const cache = window.__rpLoadedScripts;
  if (cache.has(src)) return cache.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    // Dynamically-created <script> elements default to async=true (a
    // well-known DOM quirk), meaning they can execute in FETCH-COMPLETION
    // order rather than the order they were appended -- fatal here, since
    // scramjet.js/controller.api.js/scramjet-utils.js/the transport
    // client all expect earlier ones to have already run and set up
    // their globals (confirmed: loading them via Promise.all without this
    // threw "Cannot destructure property 'BareResponse' of
    // 'globalThis.$scramjet' as it is undefined" -- controller.api.js
    // executing before scramjet.js finished). Setting async=false forces
    // in-DOCUMENT-ORDER execution once all pending scripts have loaded,
    // while still letting the browser fetch them in parallel.
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
  cache.set(src, p);
  return p;
}

/** Registers /redproxy/sw.js at root scope and waits for it to actually
 *  be controlling this page -- mirrors the reference's registerSw(), with
 *  one addition: an explicit {scope:'/'} (the reference's own swPath is
 *  served AT the site root, so it gets scope "/" for free; this project
 *  keeps the service worker under /redproxy/ instead, so scope has to be
 *  widened explicitly -- same fix as Bug #1 from earlier in this
 *  project's history, and the matching Service-Worker-Allowed: / response
 *  header server.js already sends for this exact path). */
async function registerRedProxyServiceWorker() {
  const registration = await navigator.serviceWorker.register('/redproxy/sw.js', {
    scope: '/',
    type: 'classic',
    updateViaCache: 'none',
  });
  await navigator.serviceWorker.ready;

  if (registration.active) return registration.active;

  if (registration.installing) {
    await new Promise((resolve) => {
      const sw = registration.installing;
      if (sw.state === 'activated') { resolve(); return; }
      sw.addEventListener('statechange', function onChange() {
        if (sw.state === 'activated') {
          sw.removeEventListener('statechange', onChange);
          resolve();
        }
      });
    });
    return registration.active;
  }

  if (registration.waiting) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    });
    return navigator.serviceWorker.controller;
  }

  throw new Error('No service worker found in registration');
}

/** Registers the SW, loads the core/controller/utils/transport bundles,
 *  and returns a ready-to-use Controller. Safe to call directly from a
 *  document's own top-level script (unlike the old bare-mux SharedWorker
 *  design, there's no separate worker-port negotiation step to race) as
 *  long as -- same rule as always -- this document's own origin is
 *  genuinely redportal.dpdns.org (never call this from a page that might
 *  be blob-wrapped by a foreign-origin launcher). */
async function initRedProxyController() {
  const sw = await registerRedProxyServiceWorker();

  await Promise.all([
    rpLoadScriptOnce('/scram/scramjet.js'),
    rpLoadScriptOnce('/controller/controller.api.js'),
    rpLoadScriptOnce('/scram/scramjet-utils.js'),
    rpLoadScriptOnce('/libcurl/index.js'),
  ]);

  const wispUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/wisp/';
  const LibcurlCtor = window.LibcurlTransport.LibcurlClient;
  const transport = new LibcurlCtor({ wisp: wispUrl });

  const { Controller, config } = window.$scramjetController;
  config.injectPath  = '/controller/controller.inject.js';
  config.wasmPath     = '/scram/scramjet.wasm';
  config.scramjetPath = '/scram/scramjet.js';

  const controller = new Controller({ serviceworker: sw, transport });
  await controller.wait();
  return controller;
}
