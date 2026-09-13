/**
 * Red Portal — art.js
 * ===================
 * Resolves every piece of artwork the wheel UI shows, from one registry
 * (assets/ui/art-manifest.json), and builds the placeholder for anything
 * not there yet. The UI never references an image path directly, so the
 * artist's files can land later without code changes.
 *
 *   RPArt.ready            -> Promise, resolves once the manifest is read
 *   RPArt.tabLogo(id)      -> url | null
 *   RPArt.gameLogo(key)    -> Promise<{ url, kind:'logo'|'icon' } | null>
 *   RPArt.placeholder(label, opts) -> HTMLElement
 */
window.RPArt = (function () {
  'use strict';

  const ICON_BASE = 'https://assets.redportal.dpdns.org/assets/icons/';
  let manifest = { tabs: {}, games: {}, sfx: {}, layerBase: 'https://assets.redportal.dpdns.org/assets/themes/' };
  const iconCache = new Map();   // key -> Promise<bool>

  const ready = fetch('assets/ui/art-manifest.json', { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : null))
    .then(m => { if (m && typeof m === 'object') manifest = Object.assign(manifest, m); })
    .catch(() => {})
    .then(() => manifest);

  function tabLogo(id) {
    const u = manifest.tabs && manifest.tabs[id];
    return typeof u === 'string' && u ? u : null;
  }

  /** Does an image URL load? Cached per key so a game is probed once. */
  function probe(url) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
  }

  function gameLogo(key) {
    if (!key) return Promise.resolve(null);
    const u = manifest.games && manifest.games[key];
    if (typeof u === 'string' && u) return Promise.resolve({ url: u, kind: 'logo' });
    // Existing convention: assets/icons/<key>.png, present for some games
    // and simply absent for others (index.html does the same onerror dance).
    const url = ICON_BASE + encodeURIComponent(key) + '.png';
    if (!iconCache.has(key)) iconCache.set(key, probe(url));
    return iconCache.get(key).then(ok => (ok ? { url, kind: 'icon' } : null));
  }

  /**
   * A placeholder that looks designed rather than broken: a tilted tile
   * with the item's monogram and a small "artwork pending" tag. Its hue
   * is derived from the label so neighbouring games differ.
   */
  function placeholder(label, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'art-ph' + (opts.large ? ' art-ph--large' : '');
    const words = String(label || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    let mono = words.slice(0, 2).map(w => w[0]).join('');
    if (!mono) mono = '?';
    let h = 0;
    for (const c of String(label)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    el.style.setProperty('--ph-rot', ((h % 9) - 4) + 'deg');
    el.style.setProperty('--ph-shift', ((h >> 4) % 40 - 20) + 'deg');
    el.innerHTML =
      `<span class="art-ph-mono">${escapeHtml(mono.toUpperCase())}</span>` +
      `<span class="art-ph-name">${escapeHtml(label)}</span>` +
      `<span class="art-ph-tag">artwork pending</span>`;
    return el;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  return {
    ready, tabLogo, gameLogo, placeholder,
    get manifest() { return manifest; },
    get layerBase() { return manifest.layerBase; },
  };
})();
