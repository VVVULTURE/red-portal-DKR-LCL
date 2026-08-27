/**
 * Red Proxy — service worker
 * ===========================
 * Registered at root scope "/" (see register-sw.js — has to be, since
 * Scramjet's own codec rewrites proxied URLs to live under its internal
 * prefix at the site root, not under /redproxy/). It only actually acts on
 * requests that fall under that internal proxy prefix; everything else
 * (Red Portal itself, Games/, Testing/, assets/) passes straight through
 * via a plain fetch(), unchanged from having no service worker at all.
 */
importScripts('/scram/scramjet.all.js');

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) {
    return scramjet.fetch(event);
  }
  return fetch(event.request);
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});
