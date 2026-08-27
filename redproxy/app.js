'use strict';

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
  files: {
    wasm: '/scram/scramjet.wasm.wasm',
    all:  '/scram/scramjet.all.js',
    sync: '/scram/scramjet.sync.js',
  },
});
scramjet.init();

const connection = new BareMux.BareMuxConnection('/baremux/worker.js');

const DEFAULT_SEARCH_TEMPLATE = 'https://www.google.com/search?q=%s';

function setStatus(msg, isError) {
  const el = document.getElementById('rp-status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('err', !!isError);
}

/** Point bare-mux at the local (same-process) wisp endpoint, over the fast
 *  WASM libcurl transport — never a third-party proxy/wisp server. */
async function ensureTransport() {
  const wispUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/wisp/';
  if ((await connection.getTransport()) !== '/libcurl/index.mjs') {
    await connection.setTransport('/libcurl/index.mjs', [{ websocket: wispUrl }]);
  }
}

async function goTo(rawInput) {
  setStatus('Connecting…');
  await registerRedProxySW();
  await ensureTransport();

  const target = toTargetUrl(rawInput, DEFAULT_SEARCH_TEMPLATE);

  // Scramjet's own Frame machinery is used ONLY to compute the
  // codec-rewritten URL -- the iframe element it creates is never inserted
  // into the page (so it never loads anything, never renders). The whole
  // tab then navigates directly to that computed URL, so the proxied site
  // takes over the real top-level browsing context -- no iframe involved
  // in what actually gets shown.
  const frame = scramjet.createFrame();
  const encoded = frame.go(target) || frame.frame.src;
  location.href = encoded;
}

document.getElementById('rp-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('rp-address');
  const val = input.value.trim();
  if (!val) return;
  goTo(val).catch((err) => {
    console.error('[redproxy]', err);
    setStatus('Failed: ' + err.message, true);
  });
});
