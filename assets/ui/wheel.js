/**
 * Red Portal — wheel.js
 * =====================
 * The rotating selection wheel: one continuous position (`pos`, a float
 * index) that every input nudges, and a render loop that places each
 * item around a cylinder from that one number. Mouse steering, hover,
 * scroll wheel, touch drag, on-screen arrows and the keyboard all end up
 * as either "set target" or "add velocity" on the same state, so there is
 * exactly one navigation model and every method animates identically.
 *
 * Nothing in here knows what the items ARE. The controller (app.js) hands
 * in plain objects and listens for change / settle / activate.
 *
 *   const w = new RPWheel(rootEl, { onChange, onSettle, onActivate, tick });
 *   w.setItems([{ key, label, glyph, sub }]);
 *   w.step(+1);  w.select(3);  w.activate();
 */
window.RPWheel = (function () {
  'use strict';

  const DEG = Math.PI / 180;
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Geometry and feel. Everything tunable is here.
  const CFG = {
    stepDeg:      22,     // angular spacing between items
    maxDeg:       72,     // items beyond this angle are not rendered
    frontBoost:   0.22,   // extra scale on the selected item, fading over one step
    minScale:     0.58,   // scale of an item at 90 degrees
    minOpacity:   0.12,
    tau:          0.11,   // seconds -- easing time constant toward target
    settleEps:    0.004,  // |target - pos| below this counts as settled
    steerMax:     4.2,    // items per second at full deflection
    steerDead:    0.42,   // fraction of the zone half-height that does not steer (covers the two neighbours, which hover-select instead)
    steerCurve:   1.7,
    steerRampMs:  420,    // steering builds up over this long, so entering the column does not jerk
    scrollPx:     70,     // trackpad pixels per item (small-delta accumulation)
    notchGapMs:   45,     // min time between mouse-wheel detents (kills one-click-two-steps)
    flingFriction: 4.5,   // 1/s -- higher stops sooner
    flingMin:     0.35,   // items/s below which a fling snaps to the nearest item
    holdDelayMs:  360,    // arrow buttons: hold-to-repeat
    holdEveryMs:  115,
    tapPx:        9,      // finger travel under this is a tap, not a drag
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  class RPWheel {
    constructor(root, opts) {
      this.root = root;
      this.opts = Object.assign({ loop: true }, opts || {});
      this.items = [];
      this.nodes = [];
      this.pos = 0;          // continuous index
      this.target = 0;       // where easing is heading (unbounded when looping)
      this.vel = 0;          // items / second, used by 'free' and 'steer'
      this.mode = 'ease';    // ease | steer | drag | free
      this.lastIdx = -1;
      this.settled = false;
      this.enabled = true;
      this.radius = 320;
      this.frontY = 0;
      this._raf = 0;
      this._last = 0;
      this._steer = 0;       // -1..1 current deflection
      this._notchAt = 0;     // last mouse-wheel detent, for debouncing
      this._steerStart = 0;  // when the current steering run began
      this._mouseAt = 0;     // last real mouse movement over the zone
      this._mx = -1; this._my = -1;
      this._scrollAcc = 0;
      this._drag = null;
      this._spin = null;
      this._hold = null;
      this._settleTimer = 0;

      root.classList.add('wh');
      root.setAttribute('role', 'listbox');
      root.tabIndex = -1;

      // The steering zone is the whole wheel column. Items sit inside it.
      this.zone = document.createElement('div');
      this.zone.className = 'wh-zone';
      root.appendChild(this.zone);
      this.track = document.createElement('div');
      this.track.className = 'wh-track';
      this.zone.appendChild(this.track);

      // Selection bar: a fixed highlight at the front point. Items scroll
      // through it rather than each carrying its own highlight, which is
      // what makes the wheel read as one physical object.
      this.bar = document.createElement('div');
      this.bar.className = 'wh-bar';
      this.zone.appendChild(this.bar);

      this._bind();
      this.layout();
      this._loop = this._loop.bind(this);
      this._raf = requestAnimationFrame(this._loop);
    }

    /* ── data ──────────────────────────────────────────────────── */

    setItems(items, keepKey) {
      const prevKey = keepKey !== undefined ? keepKey : (this.items[this.index] || {}).key;
      this.items = items.slice();
      this.track.innerHTML = '';
      this.nodes = this.items.map((it, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wh-item';
        b.setAttribute('role', 'option');
        b.dataset.i = String(i);
        b.innerHTML =
          (it.glyph ? `<span class="wh-glyph" aria-hidden="true">${it.glyph}</span>` : '') +
          `<span class="wh-label">${escapeHtml(it.label)}</span>` +
          (it.sub ? `<span class="wh-sub">${escapeHtml(it.sub)}</span>` : '');
        // An artist icon (if any) is injected to the RIGHT of the label later
        // by setItemIcon(), only once it's confirmed to exist -- so no request
        // fires and nothing changes until one is actually uploaded.
        this.track.appendChild(b);
        return b;
      });
      let idx = this.items.findIndex(it => it.key === prevKey);
      if (idx < 0) idx = 0;
      this.pos = this.target = idx;
      this.vel = 0;
      this.mode = 'ease';
      this.lastIdx = -1;
      this.settled = false;
      this._render(true);
    }

    get count() { return this.items.length; }

    /** Whether the wheel can ACTUALLY wrap. `opts.loop` is only a request;
     *  looping needs enough items to fill the arc, or the render never draws
     *  a wrapped copy and movement just spins the lone item off into nothing.
     *  This is the exact same threshold `_render` uses, so movement and
     *  drawing always agree. With the current geometry it is 7+ items; a 1-
     *  or 2-item list (e.g. Apps) clamps at its ends instead. */
    get looping() {
      return this.opts.loop && this.items.length * CFG.stepDeg > 2 * CFG.maxDeg;
    }

    /** Rounded, normalised index of the selected item. */
    get index() {
      const n = this.items.length;
      if (!n) return -1;
      const r = Math.round(this.pos);
      return this.looping ? ((r % n) + n) % n : clamp(r, 0, n - 1);
    }

    get selected() { return this.items[this.index] || null; }

    /* ── navigation API (all inputs funnel into these) ─────────── */

    /** Move by whole items. */
    step(delta) {
      if (!this.items.length || !this.enabled) return;
      if (this.mode !== 'ease') { this.target = Math.round(this.pos); this.mode = 'ease'; }
      this._setTarget(this.target + delta);
    }

    /** Select an item by normalised index, taking the short way round. */
    select(i) {
      const n = this.items.length;
      if (!n || !this.enabled) return;
      if (!this.looping) { this._setTarget(clamp(i, 0, n - 1)); return; }
      // unwrap i to the copy nearest to pos
      const base = Math.round(this.pos);
      let d = ((i - base) % n + n) % n;
      if (d > n / 2) d -= n;
      this._setTarget(base + d);
    }

    selectKey(key) {
      const i = this.items.findIndex(it => it.key === key);
      if (i >= 0) this.select(i);
    }

    /** Put an (already-confirmed) icon image to the right of item `key`'s
     *  label. Idempotent; survives the per-frame transform updates. */
    setItemIcon(key, url) {
      const i = this.items.findIndex(it => it.key === key);
      if (i < 0) return;
      const node = this.nodes[i];
      if (!node || node.querySelector('.wh-icon')) return;
      const img = document.createElement('img');
      img.className = 'wh-icon';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.src = url;
      node.appendChild(img);
    }

    /** Replace item `key`'s emoji glyph (left of the label) with an
     *  (already-confirmed) artist icon, smaller. Keeps the emoji if no icon
     *  has been uploaded. Idempotent. */
    setGlyphIcon(key, url) {
      const i = this.items.findIndex(it => it.key === key);
      if (i < 0) return;
      const node = this.nodes[i];
      if (!node) return;
      let glyph = node.querySelector('.wh-glyph');
      if (!glyph) {                       // a tab with no emoji still gets a left slot
        glyph = document.createElement('span');
        glyph.className = 'wh-glyph';
        glyph.setAttribute('aria-hidden', 'true');
        node.insertBefore(glyph, node.firstChild);
      }
      if (glyph.querySelector('.wh-glyph-icon')) return;   // already replaced
      glyph.textContent = '';                              // drop the emoji
      glyph.classList.add('has-icon');
      const img = document.createElement('img');
      img.className = 'wh-glyph-icon';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.src = url;
      glyph.appendChild(img);
    }

    /** Animated wheel-of-fortune spin to item i: a quick run that overshoots
     *  slightly then settles back. Selects, never activates. */
    spinTo(i) {
      const n = this.items.length;
      if (!n || !this.enabled) return;
      let dest;
      if (this.looping) {
        const base = Math.round(this.pos);
        let d = ((i - base) % n + n) % n;
        if (d > n / 2) d -= n;        // nearest copy
        dest = base + d;
      } else {
        dest = clamp(i, 0, n - 1);
      }
      const dist = Math.abs(dest - this.pos);
      if (dist < 0.001) { this._setTarget(dest); return; }
      const dir = dest >= this.pos ? 1 : -1;
      const over = this.looping ? dest + dir * 0.5 : clamp(dest + dir * 0.5, -0.5, n - 0.5);
      this._spin = {
        from: this.pos,
        over,
        to: dest,
        start: performance.now(),
        d1: clamp(600 + dist * 45, 700, 1600),  // longer spin for a farther pick
        d2: 300,                                  // settle-back
      };
      this.mode = 'spin';
      this.settled = false;
    }

    /** Jump without animation (used when a view first appears). */
    snapTo(i) {
      const n = this.items.length;
      if (!n) return;
      this.pos = this.target = this.looping ? i : clamp(i, 0, n - 1);
      this.vel = 0; this.mode = 'ease'; this.lastIdx = -1; this.settled = false;
      this._render(true);
    }

    activate() {
      const it = this.selected;
      if (it && this.enabled && this.opts.onActivate) this.opts.onActivate(it, this.index);
    }

    _setTarget(t) {
      const n = this.items.length;
      if (!this.looping) t = clamp(t, 0, n - 1);
      if (t === this.target && this.mode === 'ease') return;
      this.target = t;
      this.mode = 'ease';
      this.settled = false;
      if (REDUCED) { this.pos = t; }
    }

    /* ── layout ────────────────────────────────────────────────── */

    layout() {
      const h = this.root.clientHeight || 600;
      const w = this.root.clientWidth || 400;
      // Radius from height so the arc fills the column; capped so the
      // curve stays readable on very tall viewports.
      this.radius = clamp(h * 0.46, 150, 520);
      this.frontY = h / 2;
      this.compact = w < 340;
      this.root.style.setProperty('--wh-front-y', this.frontY + 'px');
      this._render(true);
    }

    /* ── render loop ───────────────────────────────────────────── */

    _loop(now) {
      this._raf = requestAnimationFrame(this._loop);
      if (!this.items.length) return;
      const dt = this._last ? Math.min(0.05, (now - this._last) / 1000) : 0.016;
      this._last = now;
      const n = this.items.length;

      if (this.mode === 'steer') {
        // Position steering: while the cursor sits in the column past the
        // dead band, the wheel keeps turning at a speed set by how far the
        // cursor is from centre -- it does NOT depend on the mouse still
        // moving. (An earlier idle-fade stopped a parked cursor after a
        // fraction of a second, which read as the wheel randomly halting
        // until you jiggled the mouse.) It stops when the cursor returns to
        // the dead band (_steer 0) or leaves the column (pointerleave).
        const ramp = Math.min(1, (now - this._steerStart) / CFG.steerRampMs);
        const v = this._steer * CFG.steerMax * ramp * ramp;
        this.vel = v;
        if (this._steer === 0) {
          this.mode = 'ease';
          this.target = Math.round(this.pos);
        } else {
          this.pos += v * dt;
          if (!this.looping) this.pos = clamp(this.pos, 0, n - 1);
        }
      } else if (this.mode === 'free') {
        this.pos += this.vel * dt;
        this.vel *= Math.exp(-CFG.flingFriction * dt);
        if (!this.looping && (this.pos <= 0 || this.pos >= n - 1)) {
          this.pos = clamp(this.pos, 0, n - 1); this.vel = 0;
        }
        if (Math.abs(this.vel) < CFG.flingMin) {
          this.mode = 'ease';
          this.target = Math.round(this.pos);
        }
      } else if (this.mode === 'spin') {
        // Wheel-of-fortune: a fast decelerating run PAST the target, then a
        // small settle back onto it. (Used by "Pick a Random Game".)
        const sp = this._spin;
        const el = now - sp.start;
        if (REDUCED) { this.pos = sp.to; this.target = sp.to; this.mode = 'ease'; }
        else if (el < sp.d1) {
          const t = el / sp.d1;
          const e = 1 - Math.pow(1 - t, 3);            // easeOutCubic into the overshoot
          this.pos = sp.from + (sp.over - sp.from) * e;
        } else if (el < sp.d1 + sp.d2) {
          const t = (el - sp.d1) / sp.d2;
          const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;  // easeInOutQuad back
          this.pos = sp.over + (sp.to - sp.over) * e;
        } else {
          this.pos = sp.to;
          this.target = sp.to;
          this.mode = 'ease';                          // next frame settles + emits
        }
      } else if (this.mode === 'ease') {
        const d = this.target - this.pos;
        if (Math.abs(d) < CFG.settleEps) {
          if (!this.settled) {
            this.pos = this.target;
            this.settled = true;
            this._render(false);
            this._emitSettle();
          }
          return;
        }
        const k = REDUCED ? 1 : 1 - Math.exp(-dt / CFG.tau);
        this.pos += d * k;
      }
      // drag: pos is written by the pointer handler directly
      this._render(false);
    }

    _render(force) {
      const n = this.items.length;
      if (!n) return;
      const R = this.radius;
      const step = CFG.stepDeg * DEG;
      const maxA = CFG.maxDeg * DEG;
      const half = n / 2;
      const loop = this.looping;

      for (let i = 0; i < n; i++) {
        let d = i - this.pos;
        if (loop) { d = ((d % n) + n + half) % n - half; }
        const a = d * step;
        const node = this.nodes[i];
        if (Math.abs(a) > maxA) {
          if (!node.hidden) { node.hidden = true; node.classList.remove('is-front'); }
          continue;
        }
        if (node.hidden) node.hidden = false;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const x = R * (1 - c);
        const y = R * s;
        const boost = 1 + CFG.frontBoost * Math.max(0, 1 - Math.abs(d));
        const scale = (CFG.minScale + (1 - CFG.minScale) * c) * boost;
        const op = clamp(CFG.minOpacity + (1 - CFG.minOpacity) * c, 0, 1);
        node.style.transform = `translate3d(${x.toFixed(2)}px, ${(this.frontY + y).toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
        node.style.opacity = op.toFixed(3);
        node.style.zIndex = String(100 + Math.round(c * 100));
        const front = Math.abs(d) < 0.5;
        if (front !== node.classList.contains('is-front')) {
          node.classList.toggle('is-front', front);
          node.setAttribute('aria-selected', front ? 'true' : 'false');
        }
      }

      const idx = this.index;
      if (idx !== this.lastIdx) {
        const prev = this.lastIdx;
        this.lastIdx = idx;
        if (prev !== -1 && this.opts.tick) this.opts.tick();
        if (this.opts.onChange) this.opts.onChange(this.items[idx], idx, prev === -1);
      }
      if (force) { this.settled = false; }
    }

    _emitSettle() {
      if (this.opts.onSettle) this.opts.onSettle(this.selected, this.index);
    }

    /* ── input ─────────────────────────────────────────────────── */

    _bind() {
      const zone = this.zone;

      // Mouse steering: vertical position inside the column, past a dead
      // band around the front point, becomes angular velocity.
      zone.addEventListener('pointermove', e => {
        if (e.pointerType !== 'mouse' || !this.enabled) return;
        if (this._drag) return;
        // Chrome re-dispatches a move at the SAME coordinates when content
        // animates under a parked cursor; only a change in position counts.
        if (e.clientX === this._mx && e.clientY === this._my) return;
        this._mx = e.clientX; this._my = e.clientY;
        this._mouseAt = performance.now();
        const r = zone.getBoundingClientRect();
        const dy = (e.clientY - (r.top + this.frontY)) / (r.height / 2);
        const mag = Math.abs(dy);
        if (mag <= CFG.steerDead) {
          this._steer = 0;
          if (this.mode === 'steer') { this.mode = 'ease'; this.target = Math.round(this.pos); }
          // Inside the dead band a real move onto a neighbouring item
          // selects it. Done here rather than on pointerover, which the
          // browser also fires when an item slides under a PARKED cursor
          // while the wheel animates -- acting on that hijacks keyboard
          // and arrow navigation.
          const b = e.target.closest && e.target.closest('.wh-item');
          if (b && this.settled) {
            const i = Number(b.dataset.i);
            if (i !== this.index) this.select(i);
          }
          return;
        }
        const t = clamp((mag - CFG.steerDead) / (1 - CFG.steerDead), 0, 1);
        // moving the mouse DOWN (dy > 0) brings lower items up: pos increases
        this._steer = Math.sign(dy) * Math.pow(t, CFG.steerCurve);
        if (this.mode !== 'steer' && (this.mode === 'ease' || this.mode === 'free')) {
          this.mode = 'steer';
          this._steerStart = performance.now();
        }
      });
      zone.addEventListener('pointerleave', e => {
        if (e.pointerType !== 'mouse') return;
        this._steer = 0;
        if (this.mode === 'steer') { this.mode = 'ease'; this.target = Math.round(this.pos); }
      });

      // Hovering an item inside the dead band selects it; clicking the
      // selected one activates it. Two separate intentions, never merged.
      this.track.addEventListener('click', e => {
        if (!this.enabled) return;
        const b = e.target.closest('.wh-item');
        if (!b) return;
        if (this._tapSuppress) { this._tapSuppress = false; return; }
        const i = Number(b.dataset.i);
        if (i === this.index && this.settled) this.activate();
        else { this.select(i); }
      });

      // Scroll wheel steps whole items; trackpads accumulate.
      zone.addEventListener('wheel', e => {
        if (!this.enabled) return;
        e.preventDefault();
        // A ratcheted mouse wheel reports one detent as a line delta or a
        // large pixel jump, and Windows sometimes rounds a single G502 click
        // to a value that would map to two steps. So a discrete notch is ONE
        // step by its sign, never by its magnitude, and two events from one
        // physical click are debounced away. A trackpad instead streams many
        // small pixel deltas -- those still accumulate.
        const discrete = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 48;
        if (discrete) {
          const dir = Math.sign(e.deltaY);
          if (dir && performance.now() - this._notchAt >= CFG.notchGapMs) {
            this._notchAt = performance.now();
            this.step(dir);
          }
          this._scrollAcc = 0;
          return;
        }
        this._scrollAcc += e.deltaY;
        const steps = Math.trunc(this._scrollAcc / CFG.scrollPx);
        if (steps !== 0) { this._scrollAcc -= steps * CFG.scrollPx; this.step(steps); }
      }, { passive: false });

      // Touch: drag the wheel directly, fling with inertia, tap to pick.
      zone.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' || !this.enabled) return;
        try { zone.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or already-released pointer */ }
        this._drag = { id: e.pointerId, y0: e.clientY, pos0: this.pos, y: e.clientY, t: performance.now(), v: 0, moved: false };
        this.mode = 'drag'; this.vel = 0;
      });
      zone.addEventListener('pointermove', e => {
        const d = this._drag;
        if (!d || e.pointerId !== d.id) return;
        const now = performance.now();
        const dt = Math.max(1, now - d.t) / 1000;
        const pxPerItem = Math.max(28, this.radius * Math.sin(CFG.stepDeg * DEG));
        const dy = e.clientY - d.y;
        d.v = 0.6 * d.v + 0.4 * (-(dy / pxPerItem) / dt);
        d.y = e.clientY; d.t = now;
        if (Math.abs(e.clientY - d.y0) > CFG.tapPx) d.moved = true;
        // dragging a finger DOWN pulls the wheel down: earlier items come up
        let p = d.pos0 - (e.clientY - d.y0) / pxPerItem;
        if (!this.looping) p = clamp(p, 0, this.items.length - 1);
        this.pos = p;
        e.preventDefault();
      }, { passive: false });
      const endDrag = e => {
        const d = this._drag;
        if (!d || e.pointerId !== d.id) return;
        this._drag = null;
        if (!d.moved) {
          // a tap: the item under the finger is selected, or activated if
          // it is already the selected one
          const el = document.elementFromPoint(e.clientX, e.clientY);
          const b = el && el.closest && el.closest('.wh-item');
          this.mode = 'ease'; this.target = Math.round(this.pos);
          this._tapSuppress = true;   // the click that follows must not double-handle
          setTimeout(() => { this._tapSuppress = false; }, 400);
          if (b) {
            const i = Number(b.dataset.i);
            if (i === this.index) this.activate(); else this.select(i);
          }
          return;
        }
        this._tapSuppress = true;
        setTimeout(() => { this._tapSuppress = false; }, 400);
        this.vel = clamp(d.v, -14, 14);
        if (Math.abs(this.vel) < CFG.flingMin) { this.mode = 'ease'; this.target = Math.round(this.pos); }
        else this.mode = 'free';
      };
      zone.addEventListener('pointerup', endDrag);
      zone.addEventListener('pointercancel', endDrag);
    }

    /** Wire an on-screen arrow button: tap steps once, holding repeats. */
    bindArrow(btn, delta) {
      let timer = null, interval = null;
      const stop = () => { clearTimeout(timer); clearInterval(interval); timer = interval = null; btn.classList.remove('is-held'); };
      btn.addEventListener('pointerdown', e => {
        if (!this.enabled) return;
        e.preventDefault();
        btn.classList.add('is-held');
        this.step(delta);
        timer = setTimeout(() => { interval = setInterval(() => this.step(delta), CFG.holdEveryMs); }, CFG.holdDelayMs);
      });
      ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(ev => btn.addEventListener(ev, stop));
      btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.step(delta); }
      });
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      this.root.innerHTML = '';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  RPWheel.CFG = CFG;
  return RPWheel;
})();
