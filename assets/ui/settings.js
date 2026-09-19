/**
 * Red Portal — settings.js
 * ========================
 * Builds the Settings panel (the ⚙️ Settings wheel tab) at runtime, in
 * Red Portal's styling, laid out like a real settings menu: a category
 * rail on the left and a pane on the right.
 *
 * It owns no data of its own -- themes come from RedPortal.THEMES and are
 * applied with RedPortal.applyTheme, sounds from RPSfx, the offline copy
 * by clicking the existing (now hidden) side-panel button. Delete this
 * file and the tab is just an empty card; nothing else breaks.
 */
(function () {
  'use strict';
  const RP  = window.RedPortal;
  const Sfx = window.RPSfx;
  const Art = window.RPArt;
  const root = document.getElementById('settingsRoot');
  if (!RP || !root) return;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const CATS = [
    { id: 'appearance', label: 'Appearance', icon: 'M8 2a6 6 0 1 0 0 12 1.5 1.5 0 0 0 1.4-2 1.5 1.5 0 0 1 1.3-2.2H12a2 2 0 0 0 2-2A6 6 0 0 0 8 2z' },
    { id: 'sound',      label: 'Sound & Motion', icon: 'M3 6h3l4-3v10l-4-3H3z M12 6a3 3 0 0 1 0 4' },
    { id: 'about',      label: 'About & Data', icon: 'M8 7v4 M8 4.5h.01 M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z' },
  ];

  function buildShell() {
    root.classList.add('set-wrap');
    root.innerHTML =
      '<nav class="set-rail" role="tablist" aria-label="Settings categories">' +
        CATS.map((c, i) =>
          `<button class="set-cat${i === 0 ? ' active' : ''}" role="tab" data-cat="${c.id}" aria-selected="${i === 0}">
             <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${c.icon}"/></svg>
             <span>${esc(c.label)}</span>
           </button>`).join('') +
      '</nav>' +
      '<div class="set-panes">' +
        CATS.map((c, i) => `<section class="set-pane${i === 0 ? ' active' : ''}" data-pane="${c.id}" role="tabpanel"></section>`).join('') +
      '</div>';

    root.querySelectorAll('.set-cat').forEach(btn => {
      btn.addEventListener('click', () => selectCat(btn.dataset.cat));
    });
  }

  function selectCat(id) {
    root.querySelectorAll('.set-cat').forEach(b => {
      const on = b.dataset.cat === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    root.querySelectorAll('.set-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === id));
    if (Sfx) Sfx.play('tick');
  }

  /* ── a reusable row + pill toggle ─────────────────────────────── */
  function row(title, desc, control) {
    const r = document.createElement('div');
    r.className = 'set-row';
    r.innerHTML = `<div class="set-row-text"><div class="set-row-title">${esc(title)}</div>${desc ? `<div class="set-row-desc">${esc(desc)}</div>` : ''}</div>`;
    r.appendChild(control);
    return r;
  }
  /** A 0-200% volume slider bound to RPMusic. */
  function volumeControl(Music) {
    const wrap = document.createElement('div');
    wrap.className = 'set-vol';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0'; range.max = '250'; range.step = '5';
    range.value = String(Music ? Music.volume : 250);
    range.setAttribute('aria-label', 'Music volume');
    const out = document.createElement('span');
    out.className = 'set-vol-val';
    out.textContent = range.value + '%';
    const paint = () => { const v = +range.value; out.textContent = v + '%'; range.style.setProperty('--fill', (v / 250 * 100) + '%'); };
    range.addEventListener('input', () => { paint(); if (Music) Music.setVolume(+range.value); });
    paint();
    wrap.append(range, out);
    return wrap;
  }

  function toggle(on, onChange) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'set-toggle' + (on ? ' on' : '');
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(on));
    b.innerHTML = '<span class="set-knob"></span>';
    b.addEventListener('click', () => {
      const next = !b.classList.contains('on');
      b.classList.toggle('on', next);
      b.setAttribute('aria-checked', String(next));
      onChange(next);
    });
    return b;
  }

  /* ── Appearance: the theme grid ──────────────────────────────── */
  function fillAppearance(pane) {
    pane.innerHTML = '<h3 class="set-h">Theme</h3><p class="set-sub">The wheel, glow and background all follow the theme. Your choice is remembered.</p>';
    const grid = document.createElement('div');
    grid.className = 'set-themes';
    const cur = (RP.currentTheme() || {}).id;
    const base = (Art && Art.layerBase) || 'https://assets.redportal.dpdns.org/assets/themes/';
    RP.THEMES.forEach(t => {
      // Prefer the flat merged wallpaper (one small image). If a theme has no
      // merged bg (e.g. Geometry Dash), composite its depth layers back-to-
      // front so the thumbnail shows the FULL scene, not just layer 3.
      let thumbCss = '';
      if (t.bg) {
        thumbCss = `background-image:url('${t.bg}');`;
      } else if (t.folder && t.layers && t.layers.length) {
        const dir = base + encodeURIComponent(t.folder) + '/';
        // A layer may be a bare filename or an absolute URL (see applyThemeLayers).
        const urls = t.layers.slice().reverse().map(f => `url('${/^https?:\/\//i.test(f) ? f : dir + f}')`); // front-most first for CSS stacking
        thumbCss = `background-image:${urls.join(',')};`;
      }
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'set-theme' + (t.id === cur ? ' active' : '');
      card.dataset.themeId = t.id;
      card.innerHTML =
        `<span class="set-theme-thumb" style="${thumbCss}--sw:${t.color}"></span>` +
        `<span class="set-theme-name"><span class="set-theme-dot" style="background:${t.color}"></span>${esc(t.name)}</span>`;
      card.addEventListener('click', () => {
        RP.applyTheme(t.id);
        grid.querySelectorAll('.set-theme').forEach(c => c.classList.toggle('active', c.dataset.themeId === t.id));
        if (Sfx) Sfx.play('select');
      });
      grid.appendChild(card);
    });
    pane.appendChild(grid);
  }

  /* ── Sound & Motion ──────────────────────────────────────────── */
  function fillSound(pane) {
    const Music = window.RPMusic;
    pane.innerHTML = '<h3 class="set-h">Sound & Motion</h3>';
    pane.appendChild(row('Menu sounds', 'Soft clicks as the wheel turns and when you open something.',
      toggle(Sfx ? Sfx.enabled : false, on => { if (Sfx) { Sfx.setEnabled(on); if (on) Sfx.play('select'); } })));
    // Directly under Menu sounds: the looping background theme. Default on;
    // once off it stays off across sessions until turned back on.
    pane.appendChild(row('Music', 'The Red Portal theme, looping in the background.',
      toggle(Music ? Music.enabled : true, on => { if (Music) Music.setEnabled(on); })));
    // Volume, 0-200% (100% = the track's own level; higher amplifies it).
    // Saved across sessions.
    pane.appendChild(row('Music volume', 'How loud the theme plays, up to 250%.', volumeControl(Music)));
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tag = document.createElement('span');
    tag.className = 'set-pill';
    tag.textContent = reduced ? 'Reduced (from your device)' : 'Full';
    pane.appendChild(row('Animation', 'Follows your device’s reduced-motion setting. Turn it on there to calm the wheel and parallax.', tag));
  }

  /* ── About & Data ────────────────────────────────────────────── */
  function fillAbout(pane) {
    pane.innerHTML = '<h3 class="set-h">About & Data</h3>';

    // Rescan: force an authoritative re-listing of the R2 bucket so newly
    // added/replaced games, testing games and emulator ROMs (and moved
    // index.html files) are picked up without waiting on the cached manifest.
    const rescan = document.createElement('button');
    rescan.type = 'button';
    rescan.className = 'set-btn';
    rescan.textContent = 'Rescan Game Files';
    rescan.addEventListener('click', async () => {
      if (rescan.disabled) return;
      rescan.disabled = true;
      const label = rescan.textContent;
      rescan.textContent = 'Rescanning…';
      try {
        const res = await fetch('/api/rescan', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
        if (RP.refreshGrids) RP.refreshGrids();   // repaint wheels from the fresh listing
        const n = (data.games || 0) + (data.testing || 0) + (data.apps || 0);
        rescan.textContent = `Found ${n} games ✓`;
      } catch (e) {
        rescan.textContent = 'Rescan failed — try again';
      }
      setTimeout(() => { rescan.textContent = label; rescan.disabled = false; }, 3500);
    });
    pane.appendChild(row('Rescan Game Files',
      'Re-Syncs from the R2 bucket to gather all of the latest games, emulated games, and testing games from our storage.',
      rescan));

    const links = document.createElement('div');
    links.className = 'set-links';
    links.innerHTML =
      '<a class="set-link" href="https://discord.gg/TzEsEJgtJp" target="_blank" rel="noopener noreferrer">Discord</a>' +
      '<a class="set-link" href="https://github.com/VVVULTURE/red-portal-DKR-LCL" target="_blank" rel="noopener noreferrer">Source on GitHub</a>';
    pane.appendChild(row('Links', 'The community and the code.', links));

    const note = document.createElement('p');
    note.className = 'set-note';
    note.textContent = 'Settings are stored in this browser only.';
    pane.appendChild(note);
  }

  function build() {
    buildShell();
    fillAppearance(root.querySelector('[data-pane="appearance"]'));
    fillSound(root.querySelector('[data-pane="sound"]'));
    fillAbout(root.querySelector('[data-pane="about"]'));
    // keep the sound toggle in step if it is changed elsewhere
    document.addEventListener('rp:sfx', e => {
      const t = root.querySelector('[data-pane="sound"] .set-toggle');
      if (t && e.detail) { t.classList.toggle('on', e.detail.enabled); t.setAttribute('aria-checked', String(e.detail.enabled)); }
    });
    // Rebuild the theme grid when themes change (auto-discovered themes are
    // added asynchronously after this panel is first built).
    document.addEventListener('rp:themes', () => {
      const pane = root.querySelector('[data-pane="appearance"]');
      if (pane) fillAppearance(pane);
    });
  }

  if (Art && Art.ready) Art.ready.then(build); else build();
})();
