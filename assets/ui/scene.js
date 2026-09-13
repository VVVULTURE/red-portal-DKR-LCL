/**
 * Red Portal — scene.js
 * =====================
 * The layered background behind the whole interface: the artist's depth
 * layers (back to front), a parallax loop driven by the pointer, the
 * atmosphere (dust motes + vignette), and the zoom state used by the
 * enter/leave transitions.
 *
 * Layers are described by the theme entry, never hardcoded here:
 *   RPScene.setLayers([{ src, depth }, ...])   // back first
 * `depth` is how far a layer shifts relative to the pointer: 1 = the full
 * parallax amplitude, 0 = pinned. Per the artwork, the opaque backdrop
 * moves the most and the foreground haze/prop layers the least -- the
 * back layer is oversized so its movement never reveals an edge, while a
 * foreground layer that moved a lot would visibly float off its subject.
 */
window.RPScene = (function () {
  'use strict';

  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COARSE  = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  const AMP_X = 22;   // px at depth 1, full pointer deflection, 1920px wide
  const AMP_Y = 14;
  const SMOOTH = 0.055; // per-frame approach factor toward the pointer target
  const DRIFT_PX = 4;   // idle breathing so a still scene is not dead
  const DRIFT_S  = 14;

  const root   = document.getElementById('scene');
  const stack  = document.getElementById('pxStack');
  const fx     = document.getElementById('pxFx');

  let sets = [];           // live layer sets: { el, layers:[{el, depth}] }
  let target = { x: 0, y: 0 };
  let cur    = { x: 0, y: 0 };
  let zoom   = 0;          // 0..1, driven by transitions
  let raf = 0, t0 = performance.now();
  let generation = 0;

  /* ── pointer → target ──────────────────────────────────────────── */
  if (!REDUCED && !COARSE) {
    window.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      target.x = (e.clientX / window.innerWidth  - 0.5) * 2;
      target.y = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });
    document.addEventListener('mouseleave', () => { target.x = 0; target.y = 0; });
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!sets.length) return;
    cur.x += (target.x - cur.x) * SMOOTH;
    cur.y += (target.y - cur.y) * SMOOTH;
    const t = (now - t0) / 1000;
    const dx = REDUCED ? 0 : Math.sin(t * 2 * Math.PI / DRIFT_S) * DRIFT_PX;
    const dy = REDUCED ? 0 : Math.cos(t * 2 * Math.PI / (DRIFT_S * 1.37)) * DRIFT_PX * 0.6;
    const scale = 1.04 + zoom * 0.07;
    for (const set of sets) {
      for (const L of set.layers) {
        const x = (-cur.x * AMP_X + dx) * L.depth;
        const y = (-cur.y * AMP_Y + dy) * L.depth;
        const s = scale + zoom * 0.05 * L.depth;
        L.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${s.toFixed(4)})`;
      }
    }
  }

  /* ── layer sets ───────────────────────────────────────────────── */

  function preload(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = src;
    });
  }

  /**
   * Replace the current layers with a new set, crossfading once every
   * image has either loaded or failed. A layer that fails is dropped;
   * if all fail the previous set stays and false is returned.
   */
  async function setLayers(layers) {
    const gen = ++generation;
    const ok = await Promise.all(layers.map(L => preload(L.src)));
    if (gen !== generation) return false;           // a newer theme won
    const live = layers.filter((_, i) => ok[i]);
    if (!live.length) return false;

    const el = document.createElement('div');
    el.className = 'px-set';
    const set = { el, layers: [] };
    live.forEach((L, i) => {
      const d = document.createElement('div');
      d.className = 'px-layer';
      d.style.backgroundImage = `url("${L.src}")`;
      d.style.zIndex = String(i + 1);
      el.appendChild(d);
      set.layers.push({ el: d, depth: REDUCED ? 0 : L.depth });
    });
    stack.appendChild(el);
    const old = sets.slice();
    sets.push(set);
    // next frame so the initial opacity:0 is committed before the fade
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.classList.add('is-in');
      old.forEach(o => o.el.classList.remove('is-in'));
      setTimeout(() => {
        old.forEach(o => { o.el.remove(); });
        sets = sets.filter(s => !old.includes(s));
      }, 900);
    }));
    root.classList.add('has-layers');
    return true;
  }

  function clearLayers() {
    generation++;
    sets.forEach(s => s.el.remove());
    sets = [];
    root.classList.remove('has-layers');
  }

  /* ── atmosphere ───────────────────────────────────────────────── */

  function buildMotes(count) {
    fx.innerHTML = '';
    if (REDUCED) return;
    const n = COARSE ? Math.round(count * 0.5) : count;
    for (let i = 0; i < n; i++) {
      const m = document.createElement('i');
      m.className = 'px-mote';
      const size = 1.5 + Math.random() * 3.2;
      m.style.setProperty('--x',  (Math.random() * 100).toFixed(2) + '%');
      m.style.setProperty('--y',  (Math.random() * 100).toFixed(2) + '%');
      m.style.setProperty('--s',  size.toFixed(2) + 'px');
      m.style.setProperty('--d',  (18 + Math.random() * 26).toFixed(1) + 's');
      m.style.setProperty('--dl', (-Math.random() * 40).toFixed(1) + 's');
      m.style.setProperty('--dx', ((Math.random() - 0.5) * 120).toFixed(1) + 'px');
      m.style.setProperty('--o',  (0.25 + Math.random() * 0.5).toFixed(2));
      fx.appendChild(m);
    }
  }

  /* ── zoom (transitions) ───────────────────────────────────────── */

  function setZoom(v) { zoom = REDUCED ? 0 : v; }

  buildMotes(26);
  raf = requestAnimationFrame(loop);

  return { setLayers, clearLayers, setZoom, get reduced() { return REDUCED; } };
})();
