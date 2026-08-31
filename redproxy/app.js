'use strict';

const DEFAULT_SEARCH_TEMPLATE = 'https://www.google.com/search?q=%s';

function setStatus(msg, isError) {
  const el = document.getElementById('rp-status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('err', !!isError);
}

const $rpAddress = document.getElementById('rp-address');
const $rpForm = document.getElementById('rp-form');
const $rpBack = document.getElementById('rp-back');
const $rpForward = document.getElementById('rp-forward');
const $rpReload = document.getElementById('rp-reload');
const $rpFrameEl = document.getElementById('rp-frame');
const $rpPlaceholder = document.getElementById('rp-frame-placeholder');

let rpFrame = null;
let initPromise = null;

/** Attaches the Controller to the real, already-in-the-DOM #rp-frame
 *  iframe -- NOT a top-level navigation of this tab. The Controller
 *  architecture needs to stay resident in a page's own JS context for a
 *  frame it manages to keep working (confirmed directly: navigating the
 *  whole tab away via location.href to a computed proxy URL, the way the
 *  old v1.1.0 API supported, tears down the Controller mid-flight here
 *  and leaves an empty shell document with just its two injected
 *  bootstrap <script> tags and no body -- an iframe kept in this same
 *  document works correctly, exactly like the in-page Red Proxy section
 *  on the main site). */
function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    setStatus('Loading Red Proxy…');
    const controller = await initRedProxyController();

    const urlWatcher = new window.$scramjetUtils.UrlWatcherPlugin((url) => {
      if ($rpAddress) $rpAddress.value = url;
      $rpBack.disabled = false;
      $rpForward.disabled = false;
      $rpReload.disabled = false;
      $rpPlaceholder.style.display = 'none';
    });

    rpFrame = controller.createFrame($rpFrameEl, { plugins: [urlWatcher] });

    $rpAddress.disabled = false;
    $rpForm.querySelector('button[type="submit"]').disabled = false;
    $rpPlaceholder.querySelector('p').textContent = 'Type a URL or search above to get started.';
    setStatus('');
  })().catch((err) => {
    initPromise = null;
    setStatus('Failed to load Red Proxy: ' + err.message, true);
    throw err;
  });
  return initPromise;
}

document.getElementById('rp-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const val = $rpAddress.value.trim();
  if (!val) return;
  try {
    await init();
    rpFrame.go(toTargetUrl(val, DEFAULT_SEARCH_TEMPLATE));
  } catch (err) {
    console.error('[redproxy]', err);
    // Already surfaced via rp-status by init()'s catch.
  }
});

$rpBack.addEventListener('click', () => rpFrame && rpFrame.back());
$rpForward.addEventListener('click', () => rpFrame && rpFrame.forward());
$rpReload.addEventListener('click', () => rpFrame && rpFrame.reload());

// Kick off init as soon as the page loads, so the toolbar is usable
// (address bar enabled) without waiting for the first submit.
init().catch(() => {});
