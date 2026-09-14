/**
 * Red Portal — app.js
 * ===================
 * The navigation layer of the redesign. It owns three things:
 *
 *   views        home (the main wheel) / list (a wheel of games) / panel
 *                (an existing section such as Requests, shown in a frame)
 *   transitions  the forward zoom into a section and the reverse out of it
 *   inputs       keyboard, the on-screen arrows, search, history, back
 *
 * It deliberately owns NO data and NO launching. Main-wheel items are read
 * from the existing <nav> links, game items arrive from the existing grid
 * renderer (rp:grid events), and activating a game calls the existing
 * openGame() through the RedPortal bridge. Remove this file and the old
 * site is still all there underneath.
 */
(function () {
  'use strict';

  const RP    = window.RedPortal;
  const Wheel = window.RPWheel;
  const Scene = window.RPScene;
  const Sfx   = window.RPSfx;
  const Art   = window.RPArt;
  if (!RP || !Wheel || !Scene || !Sfx || !Art) return;

  const REDUCED = Scene.reduced;
  const COARSE  = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const $ = id => document.getElementById(id);

  /* Sections whose content is a list of launchable things: they get a
     wheel. Everything else keeps its own page inside a panel. The grid
     ids are the ones index.html already renders into. */
  const LIST = {
    games:     { grid: 'gamesGrid',     noun: 'games' },
    Testing:   { grid: 'preLaunchGrid', noun: 'games' },
    apps:      { grid: 'appsGrid',      noun: 'apps' },
    emulation: { grid: 'emulationGrid', noun: 'ROMs' },
  };

  /* Presentation copy only -- the sections themselves are defined by the
     existing markup and never duplicated here. */
  const BLURB = {
    games:     'Browser games. Pick one, it opens in its own tab.',
    apps:      'Web apps hosted right here.',
    emulation: 'Retro consoles in the browser, powered by EmulatorJS.',
    Testing:   'New arrivals still being checked. Some may be rough.',
    form:      'Ask for a game or a service to be added.',
    report:    'Something broken? Tell us, it goes straight to Discord.',
    executor:  'Run any HTML, yours or uploaded, in a new tab.',
    links:     'Places worth a visit.',
    tutorials: 'Short videos on getting the most out of the portal.',
    movies:    'Films from the Movies folder.',
    credits:   'The people who made this.',
    settings:  'Themes, sound, and your offline copy.',
    redproxy:  'Browse the web through Red Portal.',
  };

  const gridData = Object.assign({}, RP.grids ? RP.grids() : {});   // grid id -> raw list from the server
  let view = { view: 'home' };
  let busy = false;           // during a transition
  let listWheel = null, homeWheel = null;
  let listSection = null;
  let homeSelected = null;
  const previewCache = new Map();   // tab key -> preview node

  /* ── DOM ─────────────────────────────────────────────────────── */
  const stage       = $('stage');
  const stageHome   = $('stageHome');
  const stageList   = $('stageList');
  const panelView   = $('panelView');
  const crumb       = $('crumb');
  const hint        = $('hintText');
  const backBtn     = $('btnBack');
  const searchWrap  = $('search-bar-wrap');
  const searchInput = $('gameSearch');
  const homePreview = $('homePreview');
  const listPreview = $('listPreview');
  const listCountEl = $('listCount');

  /* ── main wheel: items come from the nav links ───────────────── */

  // Clean, artist-friendly filenames for the tab icons -> assets/icons/tab-<slug>.png.
  // The image removes itself if the file isn't there (see wheel.js), so the
  // tabs look exactly as they do now until an icon is actually uploaded.
  const TAB_ICON_SLUG = {
    games: 'games', apps: 'apps', emulation: 'emulation', Testing: 'testing',
    form: 'requests', report: 'report', executor: 'executor', links: 'links',
    tutorials: 'tutorials', movies: 'movies', credits: 'credits',
    settings: 'settings', navRedProxy: 'redproxy',
  };
  const TAB_ICON_BASE = 'https://assets.redportal.dpdns.org/assets/icons/tab-';

  function navItems() {
    return [...document.querySelectorAll('#mainNav a')].map(a => {
      const text = a.textContent.trim();
      const m = text.match(/^(\p{Extended_Pictographic}️?|\p{Emoji_Presentation})\s*(.*)$/u);
      const key = a.dataset.section || a.id;
      return {
        key,
        label:  m ? m[2] : text,
        glyph:  m ? m[1] : '',
        link:   a,
        hidden: a.classList.contains('nav-hidden'),
        icon:   TAB_ICON_BASE + (TAB_ICON_SLUG[key] || key) + '.png',
      };
    }).filter(it => !it.hidden);
  }

  function buildHomeWheel() {
    const keep = homeWheel ? (homeWheel.selected || {}).key : 'games';
    homeWheel.setItems(navItems(), keep);
    resolveTabIcons();
  }

  // Show an artist tab icon beside the BIG section title in the left preview
  // (not on the small wheel item), sized up to track the title -- but ONLY
  // once the file exists. Probed with fetch (not an <img>), so a missing icon
  // produces no console 404 and nothing shows until one is uploaded to
  // assets/icons/tab-*.png.
  const tabIconState = new Map();   // url -> true(exists) | false(absent) | 'pending'
  function setPreviewTabIcon(key, url) {
    const node = previewCache.get(key);
    if (!node) return;                                   // not rendered yet; renderHomePreview fills it later
    const slot = node.querySelector('.pv-tabicon');
    if (!slot || slot.querySelector('img')) return;      // no slot, or already filled
    const img = document.createElement('img');
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.src = url;
    slot.appendChild(img);
  }
  // A confirmed tab icon shows in two places, from the same tab-<slug>.png:
  // big beside the section title (left preview), and small in place of the
  // emoji on the wheel item. Tabs with no uploaded icon keep their emoji.
  function applyTabIcon(key, url) {
    setPreviewTabIcon(key, url);
    homeWheel.setGlyphIcon(key, url);
  }
  function resolveTabIcons() {
    for (const it of homeWheel.items) {
      if (!it.icon) continue;
      const known = tabIconState.get(it.icon);
      if (known === true) { applyTabIcon(it.key, it.icon); continue; }
      if (known === false || known === 'pending') continue;
      tabIconState.set(it.icon, 'pending');
      // no-cache (revalidate), NOT force-cache: a tab icon uploaded AFTER a
      // visitor first loaded the site would otherwise be blocked by the 404
      // that got cached before it existed.
      fetch(it.icon, { cache: 'no-cache' })
        .then(r => {
          tabIconState.set(it.icon, r.ok);
          if (r.ok) applyTabIcon(it.key, it.icon);
        })
        .catch(() => tabIconState.set(it.icon, false));
    }
  }

  homeWheel = new Wheel($('homeWheel'), {
    loop: true,
    tick: () => Sfx.play('tick'),
    onChange: (it) => { homeSelected = it; renderHomePreview(it); },
    onSettle: () => {},
    onActivate: (it) => activateTab(it),
  });
  homeWheel.bindArrow($('homeUp'), -1);
  homeWheel.bindArrow($('homeDown'), +1);
  buildHomeWheel();

  // The Red Proxy link is hidden until its key chord toggles it; mirror that.
  const navProxy = $('navRedProxy');
  if (navProxy && window.MutationObserver) {
    new MutationObserver(() => buildHomeWheel()).observe(navProxy, { attributes: true, attributeFilter: ['class'] });
  }

  /* ── home preview (left of the wheel) ────────────────────────── */

  function renderHomePreview(it) {
    if (!it) return;
    homePreview.classList.remove('is-in');
    let node = previewCache.get(it.key);
    if (!node) {
      node = document.createElement('div');
      node.className = 'pv';
      const logo = Art.tabLogo(it.key);
      const isList = !!LIST[it.key];
      node.innerHTML =
        `<div class="pv-logo">${logo
          ? `<img class="pv-logo-img" src="${logo}" alt="${esc(it.label)}">`
          : `<span class="pv-word" data-text="${esc(it.label)}">${esc(it.label)}</span>`}` +
          `<span class="pv-tabicon" aria-hidden="true"></span></div>` +
        `<p class="pv-blurb">${esc(BLURB[it.key] || '')}</p>` +
        `<p class="pv-meta" data-count></p>` +
        (isList ? `<div class="pv-fan" aria-hidden="true"></div>` : '') +
        `<p class="pv-cta"><kbd>⏎</kbd> ${isList ? 'Browse' : 'Open'}</p>`;
      previewCache.set(it.key, node);
    }
    homePreview.replaceChildren(node);
    updateHomeCount(it.key);
    if (it.icon && tabIconState.get(it.icon) === true) setPreviewTabIcon(it.key, it.icon);
    if (LIST[it.key]) fillFan(node, it.key);
    requestAnimationFrame(() => homePreview.classList.add('is-in'));
  }

  function updateHomeCount(key) {
    const node = previewCache.get(key);
    if (!node) return;
    const meta = node.querySelector('[data-count]');
    if (!meta) return;
    const cfg = LIST[key];
    if (cfg) {
      const n = (gridData[cfg.grid] || []).length;
      meta.textContent = n ? `${n} ${cfg.noun}` : gridData[cfg.grid] === undefined ? 'loading…' : `no ${cfg.noun} yet`;
    } else meta.textContent = '';
  }

  /** A loose fan of icons behind the section title, for list sections. */
  function fillFan(node, key) {
    const fan = node.querySelector('.pv-fan');
    if (!fan || fan.dataset.done) return;
    const list = gridData[LIST[key].grid] || [];
    if (!list.length) return;
    fan.dataset.done = '1';
    const keys = list.map(g => g.icon).filter(Boolean).slice(0, 40);
    let placed = 0;
    (async () => {
      for (const k of keys) {
        if (placed >= 5) break;
        const art = await Art.gameLogo(k);
        if (!art) continue;
        const img = document.createElement('img');
        img.className = 'pv-fan-img';
        img.src = art.url; img.alt = '';
        img.style.setProperty('--i', String(placed));
        fan.appendChild(img);
        placed++;
      }
      if (!placed) fan.remove();
    })();
  }

  /* ── list wheel (games / testing / apps / emulation) ─────────── */

  function toItems(list, section) {
    if (section === 'emulation') {
      // The API lists ROMs in bucket order; on a wheel of ~200 that is
      // noise. Group by console, then by name (display order only).
      list = list.slice().sort((a, b) =>
        String(a.console || '').localeCompare(String(b.console || '')) ||
        String(a.name).localeCompare(String(b.name)));
    }
    return list.map(g => ({
      key:   (section === 'emulation' ? (g.href || g.name) : (g.folder || g.href)),
      label: g.name,
      sub:   section === 'emulation' ? consoleLabel(g.console) : '',
      data:  g,
    }));
  }

  const CONSOLE_NAMES = { NES: 'NES', SNES: 'Super Nintendo', N64: 'Nintendo 64', GB: 'Game Boy', GBC: 'Game Boy Color', GBA: 'Game Boy Advance', NDS: 'Nintendo DS', PSX: 'PlayStation', PSP: 'PSP', Genesis: 'Genesis', Atari2600: 'Atari 2600', TurboGrafx16: 'TurboGrafx-16', Unsorted: 'Unsorted' };
  function consoleLabel(c) { return c ? (CONSOLE_NAMES[c] || c) : ''; }

  function ensureListWheel() {
    if (listWheel) return listWheel;
    listWheel = new Wheel($('listWheel'), {
      loop: true,
      tick: () => Sfx.play('tick'),
      onChange: (it) => renderListPreview(it),
      onSettle: (it) => resolveSettledArt(it),
      onActivate: (it) => launch(it),
    });
    listWheel.bindArrow($('listUp'), -1);
    listWheel.bindArrow($('listDown'), +1);
    return listWheel;
  }

  function refreshListWheel(keepKey) {
    if (!listSection) return;
    const cfg = LIST[listSection];
    const all = gridData[cfg.grid] || [];
    const q = (searchInput.value || '').trim().toLowerCase();
    const filtered = q ? all.filter(g => String(g.name).toLowerCase().includes(q)) : all;
    const w = ensureListWheel();
    const prev = keepKey !== undefined ? keepKey : (w.selected || {}).key;
    w.setItems(toItems(filtered, listSection), prev);
    listCountEl.textContent = filtered.length === all.length
      ? `${all.length} ${cfg.noun}`
      : `${filtered.length} of ${all.length} ${cfg.noun}`;
    stageList.classList.toggle('is-empty', !filtered.length);
    if (!filtered.length) {
      const never = gridData[cfg.grid] === undefined;   // list not fetched yet
      listPreview.replaceChildren(emptyNode(all.length ? 'No matches.' : never ? 'Loading…' : 'Nothing here yet.'));
      listCountEl.textContent = never ? '' : listCountEl.textContent;
    }
  }

  function emptyNode(text) {
    const d = document.createElement('div');
    d.className = 'pv pv--empty is-in';
    d.innerHTML = `<p class="pv-blurb">${esc(text)}</p>`;
    return d;
  }

  let previewToken = 0;
  function renderListPreview(it) {
    if (!it) return;
    const token = ++previewToken;
    const g = it.data;
    const key = g.icon || g.folder;
    const node = document.createElement('div');
    node.className = 'pv pv--game';
    node.innerHTML =
      `<div class="pv-art" data-art></div>` +
      `<h3 class="pv-title">${esc(it.label)}</h3>` +
      `<p class="pv-meta">${esc(metaLine(g))}</p>` +
      `<p class="pv-cta"><kbd>⏎</kbd> Play</p>`;
    const slot = node.querySelector('[data-art]');

    // No placeholder FLASH -- ever -- while scrolling or spinning. If the icon
    // is already known (probed before, so browser-cached), show it instantly
    // even mid-scroll. Otherwise leave the box empty (its size is reserved).
    // The placeholder (and any first-time icon probe) is deferred to onSettle,
    // so the "artwork pending" box appears only once selection LANDS on an
    // iconless game -- never flickering past during motion.
    const known = Art.cachedLogo(key);
    if (known) fillArt(slot, known);

    listPreview.classList.remove('is-in');
    listPreview.replaceChildren(node);
    requestAnimationFrame(() => { if (token === previewToken) listPreview.classList.add('is-in'); });
  }

  /** Once the wheel settles, fill the selected item's art: a cached icon, a
   *  placeholder for a known-iconless game, or a fresh probe. */
  function resolveSettledArt(it) {
    if (!it) return;
    const key = it.data.icon || it.data.folder;
    const slot = listPreview.querySelector('[data-art]');
    if (!slot || slot.querySelector('img')) return;   // icon already shown
    const known = Art.cachedLogo(key);
    if (known) fillArt(slot, known);
    else if (known === null) fillPlaceholder(slot, it.label);
    else resolveArt(previewToken, slot, key, it.label);
  }

  function fillArt(slot, art) {
    const img = document.createElement('img');
    img.className = 'pv-art-img pv-art-img--' + art.kind;
    img.src = art.url; img.alt = '';
    // Icons fill the fixed placeholder square (stay put); only a wide logo
    // is allowed to grow the box (has-logo).
    const show = () => { slot.replaceChildren(img); slot.classList.add('has-art'); slot.classList.toggle('has-logo', art.kind === 'logo'); };
    if (img.complete) show(); else img.onload = show;
  }
  function fillPlaceholder(slot, label) {
    slot.classList.remove('has-art', 'has-logo');
    slot.replaceChildren(Art.placeholder(label, { large: true }));
  }
  function resolveArt(token, slot, key, label) {
    Art.gameLogo(key).then(art => {
      if (token !== previewToken || !slot.isConnected) return;
      if (art) fillArt(slot, art); else fillPlaceholder(slot, label);
    });
  }

  function metaLine(g) {
    if (!g) return '';
    const parts = [];
    if (listSection === 'emulation') {
      parts.push(consoleLabel(g.console));
      if (!g.core) parts.push('no emulator core mapped');
    } else {
      parts.push({ games: 'Games', Testing: 'Testing', apps: 'Apps' }[listSection] || '');
      if (g.folder && g.folder !== g.name) parts.push(g.folder);
    }
    return parts.filter(Boolean).join(' · ');
  }

  function launch(it) {
    if (!it || !it.data || !it.data.href) return;
    Sfx.play('select');
    stageList.classList.add('is-launch');
    setTimeout(() => stageList.classList.remove('is-launch'), 520);
    RP.openGame(it.data.href);   // the existing launcher, untouched
  }

  /* ── grid data arrives from index.html's own renderer ────────── */

  document.addEventListener('rp:grid', e => {
    const { id, list } = e.detail || {};
    if (!id) return;
    gridData[id] = Array.isArray(list) ? list : [];
    if (homeSelected) updateHomeCount(homeSelected.key);
    if (view.view === 'list' && listSection && LIST[listSection].grid === id) refreshListWheel();
    const key = Object.keys(LIST).find(k => LIST[k].grid === id);
    const node = key && previewCache.get(key);
    if (node) fillFan(node, key);
  });

  /* ── views & transitions ─────────────────────────────────────── */

  const T_OUT = REDUCED ? 0 : 420;
  const T_IN  = REDUCED ? 0 : 460;

  function currentEl() {
    return view.view === 'home' ? stageHome : view.view === 'list' ? stageList : panelView;
  }

  /** Enter a state. push=false when coming from history. */
  function go(next, push) {
    if (busy) return;
    const fromEl = currentEl();
    const forward = next.view !== 'home' && view.view === 'home';
    const prevView = view;
    view = next;
    busy = true;
    homeWheel.enabled = false;
    if (listWheel) listWheel.enabled = false;

    if (push !== false) pushHistory(next);
    document.body.dataset.view = next.view;
    if (next.view === 'list') listSection = next.section;

    // leave
    fromEl.classList.add(forward ? 'v-leave-fwd' : 'v-leave-back');
    Scene.setZoom(next.view === 'home' ? 0 : 1);
    if (next.view !== 'home' && prevView.view !== 'home') {
      // panel <-> list without going home: treat as forward
      fromEl.classList.remove('v-leave-back'); fromEl.classList.add('v-leave-fwd');
    }

    setTimeout(() => {
      fromEl.classList.remove('is-active', 'v-leave-fwd', 'v-leave-back');
      const toEl = currentEl();
      mount(next);
      toEl.classList.add('is-active', forward || prevView.view !== 'home' && next.view !== 'home' ? 'v-enter-fwd' : 'v-enter-back');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        toEl.classList.remove('v-enter-fwd', 'v-enter-back');
      }));
      setTimeout(() => {
        busy = false;
        homeWheel.enabled = true;
        if (listWheel) listWheel.enabled = true;
        if (next.view === 'home') { homeWheel.layout(); homeWheel.root.focus({ preventScroll: true }); }
        if (next.view === 'list') { listWheel.layout(); listWheel.root.focus({ preventScroll: true }); }
      }, T_IN);
    }, T_OUT);
    updateChrome(next);
  }

  function mount(next) {
    if (next.view === 'list') {
      const cfg = LIST[next.section];
      stageList.dataset.section = next.section;
      $('listTitle').textContent = sectionLabel(next.section);
      refreshListWheel(next.keepKey);
      if (!next.keepKey && listWheel) listWheel.snapTo(0);
      stage.classList.add('is-active');
    } else if (next.view === 'home') {
      stage.classList.add('is-active');
      panelView.classList.remove('is-active');
      if (searchInput.value) { searchInput.value = ''; searchInput.dispatchEvent(new Event('input')); }
    } else {
      stage.classList.remove('is-active');
      panelView.scrollTop = 0;
    }
    if (next.view !== 'list') stageList.classList.remove('is-active');
    if (next.view !== 'home') stageHome.classList.remove('is-active');
  }

  function sectionLabel(id) {
    const it = navItems().find(i => i.key === id);
    return it ? it.label : id;
  }

  function updateChrome(next) {
    const label = next.view === 'home' ? '' : sectionLabel(next.section);
    crumb.textContent = label;
    crumb.hidden = !label;
    backBtn.hidden = next.view === 'home';
    document.body.classList.toggle('has-search', next.view === 'list');
    if (COARSE) {
      hint.textContent = next.view === 'panel' ? 'Back returns to the menu'
        : 'Swipe to browse · Tap to open';
      return;
    }
    hint.innerHTML = next.view === 'panel'
      ? '<kbd>Esc</kbd> Back'
      : '<kbd>▲</kbd><kbd>▼</kbd> Navigate &nbsp; <kbd>⏎</kbd> Select' + (next.view === 'home' ? '' : ' &nbsp; <kbd>Esc</kbd> Back &nbsp; <kbd>A–Z</kbd> Search');
  }

  /* ── history: browser Back returns to the previous menu ──────── */

  function pushHistory(state) {
    // No URL argument: a blob-wrapped copy of this page (the launcher
    // scenario) would throw on any URL that resolves cross-origin.
    try { history.pushState({ rp: state }, ''); } catch (_) {}
  }
  try { history.replaceState({ rp: { view: 'home' } }, ''); } catch (_) {}
  window.addEventListener('popstate', e => {
    const s = e.state && e.state.rp;
    if (!s) return;
    if (busy) { setTimeout(() => go(s, false), T_OUT + T_IN); return; }
    go(s, false);
  });

  function back() {
    if (view.view === 'home') return;
    Sfx.play('back');
    // Prefer real history so the browser's own stack stays consistent;
    // fall back to a direct jump when there is nothing to pop.
    if (history.state && history.state.rp && history.length > 1) history.back();
    else go({ view: 'home' }, false);
  }

  /* ── activating a main tab ───────────────────────────────────── */

  function activateTab(it) {
    if (!it || busy) return;
    Sfx.play('select');
    // The existing nav handlers run exactly as before (showSection, the
    // Red Proxy opener, the search-bar toggle). The wheel just clicks.
    it.link.click();
    if (LIST[it.key]) go({ view: 'list', section: it.key });
    else go({ view: 'panel', section: it.key });
  }

  /* ── keyboard ────────────────────────────────────────────────── */

  function inField(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const field = inField(e.target);
    const w = view.view === 'home' ? homeWheel : view.view === 'list' ? listWheel : null;

    if (e.key === 'Escape') {
      if (view.view === 'list' && searchInput.value) { searchInput.value = ''; searchInput.dispatchEvent(new Event('input')); searchInput.blur(); return; }
      if (field && view.view === 'panel') { e.target.blur(); return; }
      if (view.view !== 'home') { e.preventDefault(); back(); }
      return;
    }
    if (field) {
      if (w && e.target === searchInput && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter')) {
        e.preventDefault();
        if (e.key === 'Enter') w.activate(); else w.step(e.key === 'ArrowUp' ? -1 : 1);
      }
      return;
    }
    if (!w) {
      if (e.key === 'Backspace' && view.view === 'panel') { e.preventDefault(); back(); }
      return;
    }
    switch (e.key) {
      case 'ArrowUp': case 'ArrowLeft': e.preventDefault(); w.step(-1); break;
      case 'ArrowDown': case 'ArrowRight': e.preventDefault(); w.step(1); break;
      case 'PageUp': e.preventDefault(); w.step(-5); break;
      case 'PageDown': e.preventDefault(); w.step(5); break;
      case 'Home': e.preventDefault(); w.select(0); break;
      case 'End': e.preventDefault(); w.select(w.count - 1); break;
      case 'Enter': case ' ': e.preventDefault(); w.activate(); break;
      case 'Backspace': if (view.view === 'list') { e.preventDefault(); back(); } break;
      default:
        // typing in a list view starts a search
        if (view.view === 'list' && e.key.length === 1 && /[\p{L}\p{N}]/u.test(e.key)) {
          searchInput.focus();
        }
    }
  });

  /* ── search box filters the list wheel ───────────────────────── */
  searchInput.addEventListener('input', () => {
    if (view.view === 'list') refreshListWheel();
  });

  /* ── chrome buttons ──────────────────────────────────────────── */
  backBtn.addEventListener('click', back);
  document.querySelector('a.logo').addEventListener('click', () => {
    if (view.view !== 'home') { Sfx.play('back'); go({ view: 'home' }); }
  });

  /* Pick a random game: the wheel spins to a random item (never the current
     one) with a wheel-of-fortune overshoot, and just SELECTS it -- the game
     is not opened. */
  const btnRandom = $('btnRandom');
  if (btnRandom) btnRandom.addEventListener('click', () => {
    if (view.view !== 'list' || !listWheel) return;
    const n = listWheel.count;
    if (!n) return;
    if (n === 1) { listWheel.select(0); return; }
    let i; do { i = Math.floor(Math.random() * n); } while (i === listWheel.index);
    Sfx.play('select');
    listWheel.spinTo(i);
  });

  /* ── theme layers ────────────────────────────────────────────── */

  document.addEventListener('rp:theme', e => applyThemeLayers(e.detail && e.detail.theme));

  async function applyThemeLayers(theme) {
    if (!theme) return;
    await Art.ready;
    if (!theme.layers || !theme.layers.length) {
      Scene.clearLayers();
      document.body.classList.remove('has-layers');
      return;
    }
    const base = Art.layerBase + encodeURIComponent(theme.folder) + '/';
    const depths = theme.depth || [1, 0.5, 0.2];
    const ok = await Scene.setLayers(theme.layers.map((f, i) => ({ src: base + f, depth: depths[i] !== undefined ? depths[i] : 0.3 })));
    document.body.classList.toggle('has-layers', ok);
    // Every layer failed (not synced yet, offline): fall back to the flat
    // wallpaper the old engine used, so the page never sits on a bare colour.
    if (!ok && RP.setFlatBackground) RP.setFlatBackground(theme);
  }
  if (RP.currentTheme) applyThemeLayers(RP.currentTheme());

  /* ── side panel: sound toggle ────────────────────────────────── */

  (function addSoundToggle() {
    const panel = $('sidePanel');
    if (!panel) return;
    const sec = document.createElement('div');
    sec.className = 'sp-btn-section';
    sec.innerHTML = `<button class="sp-action-btn" id="btnSfxToggle" aria-pressed="${Sfx.enabled}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/></svg>
      <span>Sounds: ${Sfx.enabled ? 'On' : 'Off'}</span></button>`;
    panel.insertBefore(sec, panel.querySelector('.sp-btn-section'));
    const btn = sec.querySelector('button');
    btn.addEventListener('click', () => {
      Sfx.setEnabled(!Sfx.enabled);
      btn.setAttribute('aria-pressed', String(Sfx.enabled));
      btn.querySelector('span').textContent = 'Sounds: ' + (Sfx.enabled ? 'On' : 'Off');
      if (Sfx.enabled) Sfx.play('select');
    });
  })();

  /* ── boot ────────────────────────────────────────────────────── */

  Art.ready.then(m => {
    if (m && m.sfx) Sfx.setSources(m.sfx);
    if (m && m.music && window.RPMusic) window.RPMusic.setSource(m.music);
  });

  window.addEventListener('resize', () => {
    homeWheel.layout();
    if (listWheel) listWheel.layout();
  });

  stage.classList.add('is-active');
  stageHome.classList.add('is-active');
  document.body.dataset.view = 'home';
  updateChrome(view);
  homeWheel.layout();

  // Entrance: after the intro overlay, or straight away if it already went.
  const reveal = () => { document.body.classList.add('ui-ready'); homeWheel.layout(); };
  if (window.__introDone) reveal();
  else {
    const prev = window.__onIntroDone;
    window.__onIntroDone = () => { if (typeof prev === 'function') prev(); reveal(); };
    setTimeout(reveal, 4500);   // never stay hidden if the intro never reports
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  window.RPApp = { go, back, get view() { return view; }, homeWheel, get listWheel() { return listWheel; } };
})();
