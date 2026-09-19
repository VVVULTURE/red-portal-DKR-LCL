/**
 * Red Portal — music.js
 * =====================
 * The looping background theme, with a volume that goes past 100%.
 *
 * An <audio> element's own volume caps at 1.0, so the track is routed through
 * the Web Audio API (MediaElementSource -> GainNode -> output) whose gain can
 * exceed 1 -- letting the volume run 0..250% (gain 0..2.5). If Web Audio is
 * unavailable the element's volume is used instead, capped at 100%.
 *
 * Two persisted preferences, both surviving across sessions:
 *   rp_music      "on" | "off"   -- default ON
 *   rp_music_vol  0..250 (percent) -- default 250
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

  function clampVol(v) { v = Math.round(Number(v)); if (!isFinite(v)) v = 100; return Math.max(0, Math.min(250, v)); }

  let enabled = store.get(KEY) !== 'off';                 // default ON
  let vol = store.get(KEY_VOL) === null ? 250 : clampVol(store.get(KEY_VOL));  // default 250%
  let url = null;
  let audio = null;
  let ctx = null, gainNode = null, graphTried = false;
  let started = false;   // true only once sound is ACTUALLY coming out
  let ducked = false;    // temporarily paused for a video, WITHOUT changing enabled

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

  /** True only when audio is genuinely audible: element playing AND, if the
   *  Web Audio graph is in use, its context actually running (not suspended). */
  function audiblyPlaying() {
    return !!audio && !audio.paused && (!ctx || ctx.state === 'running');
  }

  /** Attempt to start (or resume) playback. Safe to call repeatedly; it only
   *  marks `started` once sound can truly come out. MUST be called from within
   *  a user-gesture handler to succeed the first time (browser autoplay gate). */
  function play() {
    if (!enabled || !url) return;
    ensureAudio();
    buildGraph();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    const p = audio && audio.play();
    if (p && p.then) {
      // Only count it as started if the graph's context is actually running.
      // A resolved play() into a SUSPENDED context is silent — the old bug
      // was treating that as "unlocked", which then swallowed the real gesture.
      p.then(() => { if (!ctx || ctx.state === 'running') started = true; }).catch(() => {});
    }
  }

  // Best-effort autoplay on load, BEFORE any gesture. Works only if the browser
  // already trusts the site (built-up Media Engagement Index, or Sound=Allow);
  // otherwise it's a silent no-op and the gesture handler below takes over. It
  // never sets `started` unless the context is genuinely running.
  function attemptAutoplay() { play(); }

  // Start on the FIRST interaction of any kind — a move, key, scroll, tap or
  // click anywhere — and keep listening until sound is actually coming out, so
  // a wasted/blocked first attempt can't leave it permanently silent. Once
  // audibly playing, the listeners remove themselves.
  const GESTURES = ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'touchend', 'pointermove', 'wheel', 'scroll', 'click'];
  function onGesture() {
    if (!enabled) return;
    if (audiblyPlaying()) { started = true; teardownGestures(); return; }
    play();
    // Re-check shortly after: ctx.resume()/play() resolve async, so confirm and
    // detach only once it's truly running.
    setTimeout(() => { if (audiblyPlaying()) { started = true; teardownGestures(); } }, 300);
  }
  function teardownGestures() {
    GESTURES.forEach(ev => window.removeEventListener(ev, onGesture, { capture: true }));
  }
  GESTURES.forEach(ev => window.addEventListener(ev, onGesture, { passive: true, capture: true }));

  function setEnabled(on) {
    enabled = !!on;
    store.set(KEY, enabled ? 'on' : 'off');
    if (enabled) play();                                  // toggled on = a gesture, so this starts sound
    else if (audio) { audio.pause(); started = false; }   // off: stop and stay off (persisted) until turned back on
    document.dispatchEvent(new CustomEvent('rp:music', { detail: { enabled, volume: vol } }));
  }

  /** Volume as a percent, 0..200. Persisted; applied live via the GainNode. */
  function setVolume(pct) {
    vol = clampVol(pct);
    store.set(KEY_VOL, String(vol));
    applyVolume();
    document.dispatchEvent(new CustomEvent('rp:music', { detail: { enabled, volume: vol } }));
  }

  /** Temporarily pause the theme (e.g. while a movie/video plays) and resume it
   *  afterward — WITHOUT changing the persisted on/off. duck(true) pauses only
   *  if music is actually playing; duck(false) resumes only what was ducked and
   *  only if the user still has music enabled. */
  function duck(on) {
    if (on) {
      if (enabled && audio && !audio.paused) { audio.pause(); ducked = true; }
    } else if (ducked) {
      ducked = false;
      if (enabled) play();   // called from the click that stopped the video → gesture context, resumes cleanly
    }
  }

  /** Point the loop at a real audio file (from art-manifest.json). */
  function setSource(u) {
    if (!u || u === url) return;   // already on this track — don't restart it
    url = u;
    // Tear the OLD track down before switching. Without this the previous audio
    // element keeps playing (it's only detached, not stopped) so you hear both
    // at once, and orphaned AudioContexts pile up and glitch the sound.
    if (audio) { try { audio.pause(); audio.src = ''; audio.load(); } catch (_) {} }
    if (ctx)   { try { ctx.close(); } catch (_) {} }
    audio = null; ctx = null; gainNode = null; graphTried = false; started = false;   // rebuild against the new source
    attemptAutoplay();  // gesture-free try now; the gesture listeners still cover the first interaction
  }

  return {
    setEnabled, setVolume, setSource, duck,
    get enabled() { return enabled; },
    get volume() { return vol; },
  };
})();
