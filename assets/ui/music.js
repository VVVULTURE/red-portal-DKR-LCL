/**
 * Red Portal — music.js
 * =====================
 * The looping background theme. Default ON; the preference is persisted under
 * rp_music and, once turned off, stays off across sessions until the user
 * turns it back on.
 *
 * Browsers block audio until the first user gesture, so playback starts on the
 * first interaction (if enabled). There is no track wired up yet -- a music
 * artist is making the theme; set its URL in art-manifest.json ("music": "…")
 * (or call RPMusic.setSource) and it will loop automatically for anyone who
 * has music enabled. Until a source exists, the switch simply remembers the
 * user's choice and nothing plays (no 404 noise).
 */
window.RPMusic = (function () {
  'use strict';

  const KEY = 'rp_music';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  let enabled = store.get(KEY) !== 'off';   // default ON
  let url = null;
  let audio = null;
  let unlocked = false;

  function ensureAudio() {
    if (audio || !url) return;
    audio = new Audio(url);
    audio.loop = true;
    audio.volume = 0.5;
    audio.preload = 'auto';
  }

  function tryPlay() {
    if (!enabled || !url || !unlocked) return;
    ensureAudio();
    if (audio) { const p = audio.play(); if (p && p.catch) p.catch(() => {}); }
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
    document.dispatchEvent(new CustomEvent('rp:music', { detail: { enabled } }));
  }

  /** Point the loop at a real audio file (from art-manifest.json). */
  function setSource(u) {
    if (!u || u === url) return;
    url = u;
    audio = null;                 // rebuild against the new source
    tryPlay();
  }

  return { setEnabled, setSource, get enabled() { return enabled; } };
})();
