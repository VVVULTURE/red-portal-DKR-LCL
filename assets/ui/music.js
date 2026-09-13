/**
 * Red Portal — music.js
 * =====================
 * The looping background theme, with a volume that goes past 100%.
 *
 * An <audio> element's own volume caps at 1.0, so the track is routed through
 * the Web Audio API (MediaElementSource -> GainNode -> output) whose gain can
 * exceed 1 -- letting the volume run 0..200% (gain 0..2). If Web Audio is
 * unavailable the element's volume is used instead, capped at 100%.
 *
 * Two persisted preferences, both surviving across sessions:
 *   rp_music      "on" | "off"   -- default ON
 *   rp_music_vol  0..200 (percent) -- default 100
 *
 * Browsers block audio until the first user gesture, so playback (and the
 * AudioContext) start on the first interaction. The track URL comes from
 * art-manifest.json ("music"); it is served same-origin with `*` CORS, so the
 * MediaElementSource is not tainted even when Red Portal runs in a blob tab.
 */
window.RPMusic = (function () {
  'use strict';

  const KEY = 'rp_music', KEY_VOL = 'rp_music_vol';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  function clampVol(v) { v = Math.round(Number(v)); if (!isFinite(v)) v = 100; return Math.max(0, Math.min(200, v)); }

  let enabled = store.get(KEY) !== 'off';                 // default ON
  let vol = store.get(KEY_VOL) === null ? 100 : clampVol(store.get(KEY_VOL));  // default 100%
  let url = null;
  let audio = null;
  let ctx = null, gainNode = null, graphTried = false;
  let unlocked = false;

  function ensureAudio() {
    if (audio || !url) return;
    audio = new Audio();
    audio.crossOrigin = 'anonymous';   // so the Web Audio tap isn't tainted cross-origin
    audio.loop = true;
    audio.preload = 'auto';
    audio.src = url;
  }

  // Route through a GainNode so volume can exceed 100%. Once built, the
  // element plays ONLY through the graph, so gain is the single volume control.
  function buildGraph() {
    if (graphTried || !audio) return;
    graphTried = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { audio.volume = Math.min(1, vol / 100); return; }   // fallback: capped at 100%
    try {
      ctx = new AC();
      const src = ctx.createMediaElementSource(audio);
      gainNode = ctx.createGain();
      gainNode.gain.value = vol / 100;
      src.connect(gainNode);
      gainNode.connect(ctx.destination);
    } catch (_) {
      gainNode = null;
      audio.volume = Math.min(1, vol / 100);
    }
  }

  function applyVolume() {
    if (gainNode) gainNode.gain.value = vol / 100;
    else if (audio) audio.volume = Math.min(1, vol / 100);
  }

  function tryPlay() {
    if (!enabled || !url || !unlocked) return;
    ensureAudio();
    buildGraph();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    const p = audio && audio.play();
    if (p && p.catch) p.catch(() => {});
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    tryPlay();
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, unlock, { passive: true }));

  function setEnabled(on) {
    enabled = !!on;
    store.set(KEY, enabled ? 'on' : 'off');
    if (enabled) tryPlay();
    else if (audio) audio.pause();
    document.dispatchEvent(new CustomEvent('rp:music', { detail: { enabled, volume: vol } }));
  }

  /** Volume as a percent, 0..200. Persisted; applied live via the GainNode. */
  function setVolume(pct) {
    vol = clampVol(pct);
    store.set(KEY_VOL, String(vol));
    applyVolume();
    document.dispatchEvent(new CustomEvent('rp:music', { detail: { enabled, volume: vol } }));
  }

  /** Point the loop at a real audio file (from art-manifest.json). */
  function setSource(u) {
    if (!u || u === url) return;
    url = u;
    audio = null; ctx = null; gainNode = null; graphTried = false;   // rebuild against the new source
    tryPlay();
  }

  return {
    setEnabled, setVolume, setSource,
    get enabled() { return enabled; },
    get volume() { return vol; },
  };
})();
