/**
 * Red Portal — sfx.js
 * ===================
 * Tiny UI sounds for the wheel: tick, select, back. Synthesized with the
 * Web Audio API so there are no files to load; any of them can be
 * replaced by a real recording by listing a URL in art-manifest.json
 * ("sfx": { "tick": "https://.../tick.mp3" }) -- see RPArt.
 *
 * The context is created lazily on the first user gesture (browsers
 * refuse to start one otherwise) and everything is a no-op before that.
 * A user preference is persisted under rp_sfx; default on.
 */
window.RPSfx = (function () {
  'use strict';

  const KEY = 'rp_sfx';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  let ctx = null;
  let master = null;
  let enabled = store.get(KEY) !== 'off';
  let unlocked = false;
  const buffers = {};   // name -> AudioBuffer for artist-supplied files
  const urls = {};      // name -> url

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    return ctx;
  }

  function unlock() {
    if (unlocked) return;
    const c = ensure();
    if (!c) return;
    unlocked = true;
    if (c.state === 'suspended') c.resume().catch(() => {});
    Object.keys(urls).forEach(load);
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, unlock, { once: false, passive: true }));

  function load(name) {
    if (!ctx || buffers[name] !== undefined) return;
    buffers[name] = null;
    fetch(urls[name]).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b))
      .then(buf => { buffers[name] = buf; })
      .catch(() => { buffers[name] = null; });
  }

  function playFile(name) {
    const buf = buffers[name];
    if (!buf) return false;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(master);
    s.start();
    return true;
  }

  /* ── synthesized voices ───────────────────────────────────────── */

  function blip(freq, dur, type, gain, when, slide) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, when);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, when + dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(master);
    o.start(when); o.stop(when + dur + 0.02);
  }

  function noise(dur, gain, when, hp) {
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = ctx.createBufferSource(); s.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 2500;
    const g = ctx.createGain(); g.gain.value = gain;
    s.connect(f); f.connect(g); g.connect(master);
    s.start(when);
  }

  const VOICES = {
    tick()   { const t = ctx.currentTime; noise(0.03, 0.18, t, 3200); blip(1250, 0.045, 'square', 0.05, t, 900); },
    select() { const t = ctx.currentTime; blip(520, 0.09, 'triangle', 0.22, t); blip(780, 0.16, 'triangle', 0.2, t + 0.07, 1040); noise(0.08, 0.08, t, 1800); },
    back()   { const t = ctx.currentTime; blip(700, 0.09, 'triangle', 0.18, t, 520); blip(420, 0.14, 'triangle', 0.16, t + 0.06, 300); },
    hover()  { const t = ctx.currentTime; blip(1600, 0.03, 'sine', 0.05, t); },
  };

  let lastTick = 0;
  function play(name) {
    if (!enabled || !unlocked || !ctx) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); return; }
    if (name === 'tick') {
      // fast spins would otherwise machine-gun; cap ticks per second
      const now = performance.now();
      if (now - lastTick < 28) return;
      lastTick = now;
    }
    if (urls[name] && playFile(name)) return;
    const v = VOICES[name];
    if (v) v();
  }

  function setEnabled(on) {
    enabled = !!on;
    store.set(KEY, enabled ? 'on' : 'off');
    document.dispatchEvent(new CustomEvent('rp:sfx', { detail: { enabled } }));
  }

  /** Register artist-supplied files: { tick: url, select: url, back: url }. */
  function setSources(map) {
    Object.assign(urls, map || {});
    if (ctx) Object.keys(urls).forEach(load);
  }

  return { play, setEnabled, setSources, get enabled() { return enabled; } };
})();
