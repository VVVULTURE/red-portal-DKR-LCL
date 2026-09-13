# The wheel interface (UI redesign, September 2026)

Red Portal's front end is a console-frontend-style scene: a rotating wheel of
sections on the right, a large preview on the left, the artist's background
split into depth layers with mouse parallax behind it, and a forward zoom into
whichever section is chosen. The inspiration is the old Raspberry Pi Recalbox
menus; the brief is in the owner's spec (kept outside the repo).

This document is the companion to `SESSION-HISTORY.md` and covers only the
presentation layer. Read §1 before touching anything: the redesign is a layer
**around** the old site, not a rewrite of it, and several things only make
sense once you know what was deliberately left alone.

---

## 1. What was kept, and how the new layer attaches to it

Everything functional in `index.html` is unchanged: the theme engine, section
switching (`showSection`), the grid renderer (`paintGrid`), the launcher
(`openGame`, blob-wrapping and its URL patches), the Requests/Report/Executor
handlers, Red Proxy, the polling loop. The redesign adds five files under
`assets/ui/` and touches `index.html` in exactly these places:

| Hook in `index.html` | Why |
| --- | --- |
| `window.RedPortal` bridge (end of the IIFE) | `openGame`, `showSection`, `applyTheme`, `THEMES`, `currentTheme()`, `setFlatBackground()`, `grids()` -- the only things the new layer needs from inside the closure |
| `rp:grid` event from `paintGrid` + `latestGrids` snapshot | the wheels consume the same lists the grids render; the snapshot exists because the inlined first paint runs before `app.js` has loaded |
| `rp:theme` event from `applyTheme` | the scene builds parallax layers from the theme; the theme engine has no dependency on the scene existing |
| `THEMES[].folder / layers / depth` | the layered art, per theme (§3) |
| markup: `#scene`, `#stage`, `#panelView`, `#hintbar`, header buttons | the new chrome; the old `<nav>` and `<main>` are still there, just placed |

**The main wheel is built FROM the `<nav>` links** (`label`, emoji, `data-section`,
the `nav-hidden` state of Red Proxy) and activating an item **clicks the link**,
so the existing delegated handlers run exactly as before. There is no second
list of tabs anywhere. The game wheels are built from the `rp:grid` lists and
activating a game calls `RedPortal.openGame(href)`. The hidden grids are still
rendered inside `#panelView` because the search cache and the Report form's
game list read them.

Delete `assets/ui/` and the `<link>`/`<script>` tags and the old site is
intact underneath.

---

## 2. Files

| File | Owns |
| --- | --- |
| `assets/ui/wheel.js` | `RPWheel` -- one continuous position, every input, the cylinder render. Knows nothing about what the items are. |
| `assets/ui/scene.js` | `RPScene` -- layer sets, the parallax loop, idle drift, dust motes, the zoom used by transitions |
| `assets/ui/sfx.js` | `RPSfx` -- synthesized tick / select / back, replaceable by files, `rp_sfx` preference |
| `assets/ui/art.js` | `RPArt` -- resolves every image from `art-manifest.json`, probes `assets/icons/`, builds placeholders |
| `assets/ui/app.js` | the controller: views, transitions, history, keyboard, search, chrome, theme layers |
| `assets/ui/settings.js` | builds the Settings panel (theme grid, sound, offline copy) from `RedPortal.THEMES`/`RPSfx` |
| `assets/ui/wheel.css` | all new styling; design tokens still come from `index.html` |
| `assets/ui/art-manifest.json` | the artwork registry (§4) |
| `tools/ui-harness/` | headless tests; see its README |

Load order matters: engine modules first, `app.js` last. They are plain
scripts with relative paths on purpose -- a blob-wrapped copy of the page
(the launcher scenario) resolves them through the injected `<base>` exactly
like it resolves `/api/*`.

---

## 3. The scene: theme layers and parallax

The artist split every wallpaper into depth layers, in
`assets/themes/<Folder>/` on R2, numbered **3 (farthest) .. 1 (nearest)**.
Two themes have only 3 and 2. Measured, not assumed:

- every layer is 1920×1080; layer 3 is fully opaque; 2 and 1 are RGBA cut-outs
- several layer-1 files are **full-frame soft overlays** (Default's red haze,
  BOTW's pink vignette, XP's ground fog, Rainy's animated rain GIF) rather
  than props -- they have 0 % fully-opaque pixels but are not transparent
- **Smooth Ride's layer 3 still contains the truck and flag that layer 1 also
  carries.** Any real offset shows two trucks. Its `depth` is near zero until
  the artist paints them out of `ride-3.png`.

A theme entry declares `folder`, `layers` (back to front) and `depth` (same
order; 1 = full parallax, 0 = pinned). The opaque back layer moves most -- it
is oversized (`inset: -4%`) so nothing shows behind it; the mid subject about
half; a full-frame haze barely. The pointer sets a target, a single rAF loop
eases toward it and adds a slow drift so a still scene still breathes.
Amplitude is ±22 px horizontally at full deflection. Layers are inset:0 and `background-size: cover` (so they adapt to any screen size/aspect) with a 1.05 scale -- just enough overscan to hide the shift, no more zoom than necessary, and no visible edge at any deflection. Touch devices and
`prefers-reduced-motion` get no parallax; reduced motion also gets no motes.

`applyTheme` no longer fetches the flat wallpaper when `layers` exist. If
**every** layer fails to load (not synced yet, offline) the scene reports it
and `setFlatBackground()` puts the old `#theme-bg` back -- the page never sits
on a bare colour. Theme ids are unchanged, so everyone's saved choice keeps
working; folder names differ (`rain` → `Rainy`, `Summer` → `Sunny Day`,
`Windows XP` → `XP`, `Mr. Aspin` → `Mr Aspin`) and are mapped in `THEMES`.

**Adding a theme:** drop the folder in the sync folder, add the entry, run a
normal sync. The `Geometry Dash` theme was added this way.

---

## 4. Artwork and placeholders

Nothing in the UI references an image path directly. `art-manifest.json`
maps `tabs.<sectionId>` and `games.<key>` to logo URLs and `sfx.<name>` to
audio files; anything absent gets a generated placeholder (monogram tile,
"artwork pending" tag, hue derived from the name). A game with no logo entry
falls back to the existing `assets/icons/<key>.png` convention, probed once
per key -- the same request the hidden grid already makes, so this adds no
404s of its own.

Replacing a placeholder is one line in the manifest. No code changes.

---

## 5. The wheel: one state, every input

`RPWheel` keeps a float index `pos`. Items sit on a cylinder at
`(i - pos) * 22°`; those past 72° are not rendered (7 visible), so a wheel of
196 ROMs costs the same per frame as one of 11 tabs (measured 58 fps headless
with parallax on). The selected item is `round(pos)`; every input either sets
a target that `pos` eases toward (`tau` 0.11 s) or adds velocity:

| Input | Effect |
| --- | --- |
| ↑ ↓ (also ← →, PageUp/Down, Home/End) | step |
| on-screen arrows | step; hold repeats |
| scroll wheel (mouse) | one detent = one step, by sign not magnitude, debounced 45 ms |
| trackpad | accumulates, step per 70 px |
| mouse **inside the dead band** (±42 % of the column, covers the two neighbours) | moving onto a neighbour selects it |
| mouse **outside the dead band** | steers: velocity grows with distance, ramps in over 0.4 s. **Continuous while the cursor sits there** -- it does not need the mouse to keep moving; it stops when the cursor returns to the dead band or leaves the column |
| touch drag | follows the finger, flings with inertia |
| tap / click on the selected item, Enter, Space | **activate** |
| tap / click on another item | select it (never activates) |

Selection and activation are never the same gesture. The wheel loops **when it has enough items to actually wrap** (7+ with the
current geometry, via the `looping` getter); a 1-2 item list clamps at its
ends instead of spinning the lone item off-screen (short way round on `select`). Ticks play on every integer crossing.

Traps found while testing, all fixed, worth knowing:

- **Chrome fires `pointerover` when an item slides under a parked cursor.**
  Hover-select on that event hijacked keyboard navigation (the wheel eased
  past the cursor, the item under it got selected instead). Hover-select now
  lives in `pointermove` and only fires on a real change of coordinates.
- **`display` beats `[hidden]`.** `.wh-item { display:flex }` kept every
  off-wheel item visible, stacked at the poles; the Back button leaked onto
  the home view the same way. Every `display` rule now has a `[hidden]`
  partner.
- **A ratcheted mouse wheel double-stepped.** Windows rounds one G502 detent
  to a pixel delta that mapped to two items, and sometimes fires two events
  per click. A discrete notch (line mode, or `|deltaY| >= 48`) is now one
  step by its sign, debounced 45 ms; only trackpad pixel deltas accumulate.
- **Position steering stopped when the mouse was still.** An idle-fade meant
  to stop runaway spin also killed a cursor parked in the steer zone, so the
  wheel halted until you jiggled the mouse. Removed: steering is now purely a
  function of cursor position and runs every frame while the cursor is in the
  column.

---

## 6. Views, transitions, back

Three views: **home** (main wheel + section preview), **list** (a section's
items on a wheel + the selected game's art; Games, Testing, Apps, Emulation)
and **panel** (every other section in a glass frame; Requests, Report,
Executor, Links, Tutorials, Movies, Credits, **Settings**, Red Proxy).

Forward = the current view scales up and fades while the background zooms;
the new one arrives from slightly small. Back reverses it. 420 ms out, 460 ms
in; reduced motion collapses both to a crossfade via the existing global rule.

Back is **Escape, the on-screen Back button, and browser Back**, all on one
state. History uses `history.pushState(state, '')` with **no URL argument**:
in a blob-wrapped copy of the page any URL would resolve cross-origin and
throw (the Cubefield finding in `SESSION-HISTORY.md`). Typing in a list view
focuses the search box, which filters the wheel; Escape clears it first.

---

## 6b. Settings, and the intro

**Settings is a wheel tab** (⚙️), not a slide-out. Activating it opens a panel
laid out like a real settings menu -- a category rail (Appearance / Sound &
Motion / About & Data) beside a pane -- in Red Portal's own styling, modelled
loosely on the Interstellar proxy's settings screen. `assets/ui/settings.js`
builds it at runtime from `RedPortal.THEMES` (a theme-card grid with real
wallpaper thumbnails) and `RPSfx` (the sound toggle); "Download offline copy"
clicks the original, now-hidden side-panel button. The old header gear and its
side panel are hidden by `wheel.css`, not deleted -- settings.js still needs
that button. Add a settings row by editing `settings.js`; the categories are
one `CATS` array.

**The intro is a fast branded wash**, no GIF and no audio. A solid cover with
the logo fades in (~0.2 s), holds a beat, then fades out (~0.44 s) while the
scene and wheel animate in beneath it -- about 0.8 s end to end, click/tap to
skip, and nothing at all under reduced motion. The old `redintro.gif` and
`redportalintroaudio.mp3` are no longer requested.

## 7. Decisions made with the owner (2026-09-13)

- layers delivered into the sync folder; the `GeometryDash (new)` folder was
  renamed `GeometryDash`; layers ship to R2 through a normal sync, not git
- back navigation: Escape + on-screen Back + browser Back
- mouse: vertical position steers past a dead band
- loop infinitely; synthesized sounds with a Settings toggle
- mobile: swipe + always-visible arrows + tap
- Recalbox is inspiration only; no reference screenshot

---

## 8. Verified, and how

`tools/ui-harness/` drove every path in headless Chromium: keyboard, steering,
hover, scroll, touch drag and tap, arrows, search, launch (a real popup tab
with the game rendered), Escape and browser Back, every panel section, the
Red Proxy reveal chord, the theme picker, the sound toggle, reduced motion,
the flat-wallpaper fallback, the **foreign-origin blob launcher** scenario,
and the local build served over the **production** origin with real data.
Zero page errors in all of them; the only 4xx are the pre-existing icon 404s.

Not verified by a machine: how it feels. The steering constants in
`RPWheel.CFG` are tuned by eye and are the first thing to adjust if the
owner finds it too eager or too sluggish.

---

## 9. Known limitations

- **Emulation lists every ROM twice (196).** The flat `Emulation/*.zip`
  originals are still in the bucket beside the sorted copies (ledger #28).
  A scoped prune fixes the data; the wheel shows what the API returns.
- **Smooth Ride is nearly static** until the artist clears layer 3.
- Safari's `backdrop-filter` on the panel frame is slower than Chrome's;
  the frame is opaque enough without it.
- Tab logos and game logos are all placeholders until the artist supplies
  them (§4).
