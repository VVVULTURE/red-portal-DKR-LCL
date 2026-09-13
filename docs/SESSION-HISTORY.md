# Red Portal — Working History

> **THE RULE — read this first, every session.**
>
> **This file must always reflect the latest state of the work.** Before you
> finish any session in which you changed code, deployed something, found a
> bug, ran a destructive operation, or learned something non-obvious about how
> this project behaves, you **update this file** — add to the Session Log, add
> to the Bug Ledger, correct anything that is now wrong, and update the
> Current State numbers. Treat it as part of the task, not an optional extra.
>
> **Never put secrets in here.** `VVVULTURE/red-portal-DKR-LCL` is a **public**
> GitHub repo. R2 keys, the Discord webhook, `BOT_SECRET`, and GitHub tokens
> have all passed through these conversations; none of them belong in a file
> that gets committed. Refer to them by name only.
>
> **Never delete history from this file to make it shorter.** Wrong turns and
> false leads are recorded on purpose — they are the expensive part, and
> re-deriving them costs far more than storing them. Condense old entries only
> if they are genuinely redundant, and keep the root causes.

Last updated: **2026-09-13**

---

## 0. How to use this document

This exists so a compacted or fresh session can pick the work up without
re-deriving anything. Read in this order:

1. **§1 Project map** — what exists and where.
2. **§2 Current state** — what is true right now, with numbers.
3. **§3 Architecture** — how the two subsystems actually work, and *why*, since
   several designs look wrong until you know what they are avoiding.
4. **§7 Bug ledger** — before debugging anything, check whether it is already
   in here. Several bugs in this project look identical from the outside and
   have completely different causes.
5. **§8 Runbook** — the commands, including the destructive ones.

---

## 1. Project map

| Thing | Location |
| --- | --- |
| Site repo (**PUBLIC**) | `github.com/VVVULTURE/red-portal-DKR-LCL` |
| Live site | `https://redportal.dpdns.org` (Render, Docker) |
| Asset bucket | Cloudflare R2, public at `https://assets.redportal.dpdns.org` |
| Local sync folder | `C:\Stuff\RedTesting\red-portal-DKR-LCL-main` |
| Discord bot | `C:\Stuff\Red Bot\red-portal-bot-for-friend` (local, exposed via ngrok) |
| Single-file port builder | `github.com/VVVULTURE/Web-App-To-HTML-Builder` (**private**), working copy `C:\Stuff\WATHB`, output `C:\Stuff\WATHB-built` |
| Replaced multi-file originals | `C:\Stuff\WATHB-replaced-originals` (+ manifest; `replace.py --restore --apply` reverses everything) |

### The two documents

| Doc | Covers |
| --- | --- |
| `docs/SESSION-HISTORY.md` (this file) | the site, the proxy, R2 discovery, the bot, the bug ledger, the runbook |
| `docs/SINGLE-FILE-PORTS.md` | the WATHB pipeline: how a port is built, every defect class, the measured limits, what "verified" means |
| `docs/UI-REDESIGN.md` | the wheel interface (Sept 2026): how it attaches to the old site, the theme layer contract, the art registry, the input model, what was verified |

**The local sync folder is not the repo.** It holds the game files (`Games/`,
`Testing/`, `Apps/`, `Emulation/`, `Movies/`) that get uploaded to R2. The repo
holds the *site* and no game files at all. Confirm this before assuming a game
is "missing from the repo" — they were never there.

### Key files

| File | Role |
| --- | --- |
| `server.js` | Everything: static serving, `/api/*`, the R2 game discovery, the server-side proxy routes |
| `index.html` | The front end: all functionality, one file, two inline `<script>` blocks |
| `assets/ui/*` | The wheel presentation layer on top of it -- see `docs/UI-REDESIGN.md` |
| `tools/ui-harness/` | Headless-Chromium tests for that layer (not shipped in the image) |
| `redproxy/ssr.mjs` | Server-side Scramjet: rewrites pages, injects the client, WebSocket relay |
| `redproxy/rp-client.js` | Injected into every proxied page: virtual URL identity, navigation interception |
| `sync_to_r2.py` | Uploads the local folder to R2, writes `manifest.json`, optional mirror-prune |
| `prune-keep.txt` | R2 keys `--prune` must never delete |
| `game-overrides.json` | Per-folder display-name / entry-point overrides for discovery |

`redproxy/` contains **exactly two files**. If you find `frame.html`,
`frame.js`, `frame-sw.js`, `sw.js`, `register-sw.js`, `controller-init.js`,
`app.js`, `search.js`, `embed.html` or `redproxy/index.html`, they have come
back from somewhere and are dead — see §5.

---

## 2. Current state (2026-09-13)

| Measure | Value |
| --- | --- |
| R2 objects | 44,306 |
| Games listed on the site | 103 (Games 46, Testing 56, Apps 1) |
| Games listed that actually load | **103 / 103** — checked by fetching every `href` |
| Games served as ONE self-contained .html | **70** (see `SINGLE-FILE-PORTS.md`) |
| Games that can never be single-file | 8 — over the 384 MiB ceiling |
| Emulation ROMs | 98 in the sync folder, sorted into 12 console folders. **The bucket still holds the 98 flat originals too, so `/api/emulation` returns 196** -- ledger #28 |
| Theme wallpapers | 12, each split into depth layers under `assets/themes/<Folder>/` in the sync folder (33 files, ~27 MB). **Not on R2 until the next normal sync** |
| Front end | Wheel interface (`docs/UI-REDESIGN.md`), on branch `ui-redesign` pending the layer sync |
| Hardcoded game links in `index.html` | **0** |
| Requests before the grids appear | **0** (inlined into the HTML) |
| Launcher page cross-origin isolated | **Yes** — COOP same-origin + COEP credentialless |
| `.git` / `node_modules` public on R2 | No — 404 |

### Non-negotiable product rules (from the owner)

1. **No `<iframe>` elements anywhere in Red Proxy.** Not the outer wrapper, not
   the content frame. This is a hard rule, not a preference.
2. **Everything runs in a blob tab.** There is no "no cloak" option.
3. **Nothing the proxy needs may be fetched from a third party.** Service
   worker, wisp, WASM — all served by Red Portal itself.
4. Red Portal must keep working when it is *itself* launched inside a blob tab.

---

## 3. Architecture

### 3.1 Red Proxy — how it works now

The address bar shows `blob:https://redportal.dpdns.org/<uuid>`. The page
inside believes it is at the real target URL. There is no service worker and no
iframe.

```
user types a URL in the Red Proxy tab
      │
      ├─ index.html rpOpen(): window.open('', '_blank') FIRST (before any await,
      │  or the popup blocker kills it), then fetch('/rp/<encoded target>')
      │  with X-RP-Dest: document
      │
      ├─ server.js → redproxy/ssr.mjs
      │     · Scramjet rewrites the HTML server-side
      │     · injects 4 scripts: scramjet.js, rp-wasm.js, a data: script
      │       declaring globalThis.__rpTarget, then rp-client.js
      │     · per-visitor cookie jar keyed by an rp_sid cookie
      │     · responses are no-store (see §7, the CDN bug)
      │
      └─ the tab replaces itself with a blob: URL built from that HTML
            │
            └─ rp-client.js boots inside the blob
                  · installVirtualIdentity(): overrides client.url so the page
                    reads __rpTarget as its own location
                  · intercepts clicks and form submits, re-fetches, hands the
                    tab a NEW blob — the address never becomes a real URL
```

**Things that look wrong but are deliberate:**

- **The URL codec is not `encodeURIComponent`.** Only `%`, `?` and `#` are
  escaped, so the target keeps its slashes. `encodeURIComponent` packs the
  whole target into one path segment, and every relative URL in the proxied
  page then resolves by replacing that segment (`./x.js` → `/rp/x.js`, no
  target at all, 502). **This codec exists in three places and they must stay
  identical:** `ssr.mjs`, `rp-client.js`, and `index.html`. Changing one and
  not the others has broken production before.
- **No `<base>` element is injected.** Scramjet's `meta.base` reads the page's
  own `<base>`, and injecting one made every relative URL get rewritten twice.
- **The page identity comes from `meta.origin`, never `meta.base`.** See §7 —
  this was the GeForce NOW sign-in bug.
- **A bare navigation is cloaked by the server, not the client.** `ssr.mjs`
  answers a top-level HTML navigation with a stub that turns itself into a
  blob, carrying the page as base64. The client used to re-fetch instead, which
  breaks any URL that may only be requested once.
- **WebRTC is untouched, on purpose.** That is *why* GeForce NOW can work: the
  page and its signalling socket are proxied, the video stream negotiates
  directly with NVIDIA.

### 3.2 R2 game discovery

Red Portal lists games by reading **`manifest.json` from R2**, not by calling
the R2 API (every List call from Render measured multiple seconds).

```
sync_to_r2.py  ──uploads files + manifest.json──►  R2
                                                    │
server.js: getManifest()  ◄──── HTTPS + gzip + If-None-Match
      │
      ├─ indexManifest(): ONE pass, filename-first, groups every index.html
      │  by top prefix and folder
      │
      ├─ per folder: shallowest index.html wins; a folder with none is skipped
      │  (this is exactly the requested behaviour — it already worked)
      │
      └─ lastGoodGrids snapshot ──► inlined into index.html as window.__RP_GRIDS
                                     so the grids paint with ZERO requests
```

**Discovery rules:** for each folder directly under `Games/`, `Testing/` or
`Apps/`, find every `index.html` at any depth, take the **shallowest**; ties
break alphabetically and log a warning; a folder with no `index.html` is not
listed. Override either the name or the exact path per folder in
`game-overrides.json`.

**Why the manifest is built from the BUCKET, not the local folder:** they are
different sets. The bucket holds games uploaded from other copies of the folder
that are perfectly playable. A local-only manifest silently delists them —
this happened, 62 games vanished. See §7.

**Why `lastGoodGrids` never expires:** inlining originally read the 15-second
list cache, so a real visitor almost never arrived during a warm window and the
inlining hardly ever fired. First paint needs *some* list instantly, not a
fresh one; the client reconciles right after.

### 3.3 The Discord bot

Two doors, same shared secret (`x-bot-secret`), same Discord webhook:

| Endpoint | From | Behaviour |
| --- | --- | --- |
| `/post-request` | `/api/request` | Runs the full pipeline: search, crawl, write files, sync to R2 |
| `/post-report` | `/api/report` | Posts a notification to Discord. **No pipeline.** |

`BOT_URL` on Render includes the `/post-request` path; the report endpoint is
addressed by swapping the pathname, so there is only ever one env var.

The bot's `config.js` keeps **hardcoded credential fallbacks** (R2 secret,
GitHub token, Discord webhook, `BOT_SECRET`). That folder must never be pushed
to a public repo as-is.

---

## 4. Session log

### Session 1 — building the proxy (summarized; predates this file)

**Asked for:** wipe the Red Proxy tab's contents but keep the tab and its open
function; run Scramjet with everything it needs served by Red Portal itself;
work while Red Portal is inside a blob tab. Explicit instruction: *"You are not
allowed to guess or assume anything in this chat."*

Then, in order: remove the iframe (a hard rule); keep it working and compatible
with as many sites as possible; the owner's own idea — *"have the actual link
be the blob tab with the proxy, but the website is tricked into thinking it is
at the link it is supposed to be"* — which became the implemented design;
target sites narrowed to Google, Wikipedia and GeForce NOW.

**Migrated** from service-worker Scramjet in an iframe → server-side Scramjet
in `ssr.mjs` + blob tabs + `rp-client.js`. Bugs fixed along the way are in §7.

**False leads I recorded so nobody repeats them:** I claimed WebRTC would block
GeForce NOW (wrong — Scramjet never touches it); I called `<base href="#">` a
smoking gun (wrong — GFN sends it itself); I treated "12 of 16 resources went
direct to NVIDIA" as evidence of a bug (wrong — a control run against a working
build read identically; it is Scramjet's deliberate illusion).

### Session 2 — this session

#### Phase A — the GeForce NOW sign-in

**Reported:** signing in worked for a second, the tab jumped to
`…/rp/https://login.nvgs.nvidia.com/v1/login?…`, then returned to a blob
showing NVIDIA's *"This Page Isn't Available — 404"*.

Findings, in the order they came:

1. The `$io` / `$rfs` / `$fs` parameters in that URL are **Scramjet's own**
   control params (`initiatorOrigin`, `referrerSource`, `fetchSite`), found in
   its `dist`. Not NVIDIA's. So the URL was legitimately rewritten.
2. Replaced the client's re-fetch recovery with **server-side cloaking**
   (`isBareNavigation` / `cloakStub` in `ssr.mjs`), so the origin is asked
   exactly once. Removed `reblobIfExposed()`.
3. The 404 **reproduced with no replay at all** — so the token theory was
   wrong. Instrumented the transport: **NVIDIA returned 200 to every request in
   the chain.** The "404" was the Angular app's own error screen.
4. Root cause: `__rpTarget` was taken from `meta.base ?? meta.origin`. NVIDIA's
   login ships `<base href="/">`, so the page was told it lived at
   `https://login.nvgs.nvidia.com/` — path and query gone, including the
   single-use `key` the whole sign-in rides on. Fixed to prefer `meta.origin`.
5. Separately, `getWorkerInjectScripts` was **not implemented**, and Scramjet
   calls it unconditionally — so every worker script failed to load outright.

**Verified on production:** GET IN reaches NVIDIA's real sign-in form (email,
password, "Stay logged in", SSO buttons) with the tab still `blob:`.
Streaming a game is still untested — it needs the owner's NVIDIA account.

#### Phase B — R2 discovery

**Asked for:** re-run the sync with a mirror-prune; debug a game that Red
Portal said was missing; bug-scan and optimize that whole function.

Found, before changing anything:

- **20 of 174 listed games were broken.** 11 had all their files locally and
  simply were not in the bucket; 9 were ghosts with no local files.
- **R2 was serving the previous run's `manifest.json`** — it only ever got
  there because the directory walk happened to pick it up, and the walk runs
  *before* the file is written.
- **`.git` (698 objects), `node_modules` (4,227) and the 20 MB
  `.sync_state.json` were publicly readable.** `.git/config` returned 200.
- **`--prune` walked `.sync_state.json`, not the bucket**, so it could never
  delete an object the state file had not recorded.
- Change detection compared size and nothing else — `and True` sat where the
  rest of the check should have been.

Rewrote `sync_to_r2.py` (exclusions, size→mtime→hash, explicit manifest upload,
true bucket-listing prune with dry-run + `--max-deletes` + `prune-keep.txt`,
`--repair`) and optimized `server.js` (gzip, single-pass index, in-flight
dedupe, overrides cache fix). Removed all 66 hardcoded game buttons.

**A regression I caused and caught:** uploading a *correct* local-only manifest
delisted 72 games. Nine deserved it; **62 were live and playable** and existed
only in the bucket. Fixed by building the manifest from the bucket.

**The prune, run by the owner** after being shown what it would delete:
38,981 objects, 0 failures. The owner's reasoning — *"there are some games I
deleted because I don't want them anymore"* — is why the folder is the source
of truth. 80% of the deletion was one duplicate, `Games/GTA-Vice-City`
(31,256 files), whose spaced twin `Games/GTA Vice City` survived.

Result: 104 listed, **104 working, 0 broken**, and the `.git` exposure closed
as a side effect.

#### Phase C — speed and dead code

**Asked for:** clear the old architecture out of Red Proxy, and make discovery
as fast as possible.

The discovery *algorithm* already did what was asked, so this was purely speed:
inlined the grids into the HTML (**3 requests → 0** before the grids appear),
the non-expiring `lastGoodGrids` snapshot, one combined `/api/grids`, ETag
revalidation (**878,970 bytes → 0**), and a boot-time warm-up.

Deleted 10 dead `redproxy/` files and 146 lines of routing. The hidden nav link
still pointed at `frame.html`; it points at `#redproxy` now.

#### Session 3 — verification pass

**Asked:** "I thought all of the games on Red Portal were fixed now."

They very nearly were, and this file was the thing that was wrong. Fetched
every `href` in `/api/grids` (104 of them) rather than trusting §9:

- **103 of 104 load.** The one failure is Dadish 3D — ledger #21.
- **§9's "13 games are gone everywhere" was false.** Eight of them —
  Granny, Eaglercraft 1.8, Eaglercraft 1.12.2, Stardew Valley, GTA Vice City,
  FNF, Baldi's Basic Plus, ASRP — were listed and playable the entire time.
  That list was compiled during the *pre-prune* audit and never re-checked
  after the bucket-built manifest (`f19c031`) restored them. It also flatly
  contradicted §2 in the same document. Ledger #22.
- Only **Google Snake, Postal and Get Yolked** are genuinely absent.
- **`Testing/Recoil` holds 372 more games** — see §9.

**Method note worth keeping:** the "104/104 working" figure came from checking
HTTP status. Dadish 3D returns 200 with 32 bytes of JSON. *Status codes do not
verify content* — check size and sniff for `<` when auditing game entry points.
Two other traps hit on the way: `urllib` rejects unencoded spaces in URLs, so
four healthy games (`GTA Vice City`, `Snow Rider 3D`, `How To Fish`,
`Youtube + YT Music`) looked broken until the paths were percent-encoded; and
`/api/r2-status` reported `manifest.json fetch timed out` at 10.5 s while a
direct fetch of the same object took **0.6 s** — treat that diagnostic's
timeout as advisory, not as evidence the manifest is slow.

#### Session 3b — WATHB, the single-file port builder

**Asked for:** a pipeline that turns a game folder into one `.html` that still
works, where every path the game asks for resolves even with no assets on
disk and no errors. Manual first, then generalise. Reference point:
`National-Porting-Association/EverBuilder`.

Lives in its own repo now — see the project map. Red Portal's own code was
not touched by this work.

**The finding that shaped the design.** The first Unity attempt failed with
`createUnityInstance is not defined`. A `<script src>` that is already in the
markup is set by the HTML parser internally: `setAttribute` is never called,
the `src` property setter is never invoked, and the request starts before any
script can run. So a runtime hook — which is all EverBuilder has — cannot
catch it. **Two layers are required**: the builder rewrites what is in the
markup, the runtime catches what is created dynamically. Ledger #24.

**Where EverBuilder would not have been enough** (read before reusing it):
its `findBestMatch` falls back to basename equality, so any request for
`data.json` gets the first embedded key ending in `data.json` — wrong file,
silently. Its XHR shim ignores `responseType`, so a loader asking for
`arraybuffer` gets text. It hooks neither `img.src`, Workers, `importScripts`,
nor CSS `url()`.

**Verified, not assumed:**

- 2048 — 16 requests to **0**, no new errors, tiles still respond to arrow
  keys, and `font-family` still resolves to Clear Sans, which proves the
  `@import` -> `@font-face` -> `url()` chain survived (those resolve relative
  to the *stylesheet*, not the document).
- Deepest Sword (Unity WebGL, 24.8 MiB) — 7 requests to **0**, renders its
  title screen from a single 33 MiB file.
- Batch: **94 of 102 folders built, 0 failures.**

**Hard limits, measured:**

- V8 caps one JS string at **512 MiB**, so base64 carries at most **384 MiB**
  of assets. **8 games exceed it** — Silksong 4.6 GB, OMORI 2.9 GB, Cuphead
  2.1 GB, Deltarune 1.7 GB, GTA Vice City 1.6 GB, Animal Crossing 1.4 GB,
  Hollow Knight 861 MB, Getting Over It 660 MB. These cannot be single files
  at all; the builder refuses rather than emitting something broken.
- **Only 2 of 31 Unity-tagged games have complete local builds.** The other 29
  are partial mirrors that stream from a CDN — the same shape as Dadish 3D.
  44 of the 94 builds report missing references for this reason.

**Status at the pause on 2026-09-10 (resumed 2026-09-11):** the tool is at
`29b7b4e` in the WATHB repo. Built output is in `C:\Stuff\WATHB-built`, NOT
pushed anywhere -- the owner tests them by hand through Red Portal's HTML
executor. **The only environment that counts is a blob: tab**; verifying over
`http://` passed games that were broken in production, twice. The verifier's
`blob-harness.html` now reproduces the real launch path.

Defect classes found and fixed in the pipeline so far, each one a class:
runtime died on `new URL('.', blobUrl)` (blob URLs are opaque); inlined
scripts never fire `onload` (love.js starts Balatro from it); GameMaker's
getter-only `response` on the XHR prototype; the page's own `blob:` URLs
were being synthesized over (Brotato's merged wasm); the app's own
`new URL()` throwing; every service-worker call throwing (opaque origin);
removed ad SDK globals; libraries genuinely absent from the folder (16 games,
now vendored at build time); `<meta charset>` pushed past the browser's
1024-byte sniff window by the payload (mojibake); lossy `'replace'` decoding
destroying Latin-1 scripts; percent-encoded filenames; mirrored CDN trees
resolved by unique suffix; iframes as separate documents (9 games are
wrappers; Eggy Car went 80 requests -> 0).

**Outcome (2026-09-11): 70 of 95 verified, and those 70 are now live in the
sync folder.** `replace.py` moved each original folder to
`C:\Stuff\WATHB-replaced-originals` and dropped the single file in as
`index.html`; the manifest there makes rollback one command:
`python replace.py --restore --apply`. Failures and the 8 over-ceiling games
were left untouched as multi-file folders.

**The sync has NOT been run** -- R2 still serves the old multi-file versions.
A normal `sync_to_r2.py` run publishes the swap. Note it leaves the old
per-game files orphaned in the bucket; harmless, since discovery takes the
shallowest `index.html`, but only a `--prune` removes them.

Later classes found by triaging failures by signature rather than one game at
a time: scripts carrying BOTH a src and a body were never inlined (the spec
ignores the body, my regex required it to be empty) -- Basketball Stars' physics
engine vanished this way; webpack's `publicPath: auto` reads
`document.currentScript.src`, empty for an inlined script, and throws; iframes
are separate documents and the generic media path turned them into data: URLs
with no runtime, so Eggy Car pulled 79 assets off a CDN; `<meta charset>` was
pushed past the browser's 1024-byte sniff window by the payload, producing
mojibake; `'replace'` decoding destroyed Latin-1 scripts outright.

Two verifier bugs that faked results, worth remembering: a 12s wait reported
Basketball Legends as "stuck" when it simply had not started, and a
percent-encoded filename (`Baldi%27s`) missed the ignore list and looked like
the port reaching the network. A short timeout does not produce fast results,
it produces wrong ones.

#### Phase D — the Report tab

**Asked for:** a Report tab next to Requests, styled like it, for bugs and
broken games, going to the same place as requests but **not** through the
pipeline.

Added `/api/report` → `/post-report` → Discord notification. The "which game"
field suggests every game currently on the site, read from the already-inlined
grid data, so it costs no request. Browser and page URL are attached
automatically, with the user-agent read from the **request headers** rather
than trusted from the page, and the form says so.

Also fixed a break I had caused: the bot's `templates.js` still built game
pages pointing at `redproxy/embed.html`, deleted in Phase C. It now builds
`/rp/` URLs with the path-preserving codec.

---

#### Session 4 — single-file ports shipped, isolation, emulator sort

**Asked for:** finish the port pipeline, make every convertible game a single
file, swap them into Red Portal keeping the originals for rollback, fix the
Stardew Valley error, sort the emulator ROMs, and write all of it down.

- **70 games replaced** with one self-contained `.html` each, verified in blob
  tabs first. Originals moved to `C:\Stuff\WATHB-replaced-originals`;
  `replace.py --restore --apply` puts every one back. Full detail, including
  all thirteen defect classes, is in `SINGLE-FILE-PORTS.md`.
- **Cross-origin isolation** added to the launcher so SharedArrayBuffer games
  work. Ledger #25. The measurement that settled it: a blob tab created by an
  isolated document reports `crossOriginIsolated === true`; created by a
  non-isolated one it has no SharedArrayBuffer at all.
- **98 emulator ROMs sorted** into 12 console folders. Classified by reading
  the ROM *inside* each archive, not by title — the title lies here. Doom is
  the **SNES** port, Monopoly is **DS**, Tetris is **Game Boy**, Pac-Man World
  is **PS1**, and `pokemon_emerald.xir` is a ZIP with a renamed extension
  holding two GBA ROMs. Three `.pce` games had no console entry at all;
  TurboGrafx-16 → core `pce` was added to `cores.json`.
- **`--prune-prefix`** added to `sync_to_r2.py`. Ledger #26.
- Orphan cleanup took the bucket 50,083 → **44,306** objects, after which all
  **103 listed games still load**.

**A mistake worth recording:** when the owner reported the bucket not updating,
the first check reported all 70 games as `DIFFERENT`. That was wrong — R2 does
not return `Content-Length` on a `HEAD`, so every comparison was against
`None`. A `Range: bytes=0-0` request reports the true size in `Content-Range`.
Measure with a method you have confirmed returns a number.

#### Session 5 — the wheel interface

**Asked for:** a complete UI redesign into a console-frontend experience
(the owner's spec: a rotating wheel of tabs, a preview to its left, the
artist's layered backgrounds with parallax, a forward zoom into sections,
smooth animated selection from mouse, keyboard, on-screen arrows and touch)
with every existing function preserved, nothing guessed, and no partial
deploy.

**Inspected before designing** (all from the repo and the live site, which
was byte-identical to `origin/main`): vanilla single-file SPA, no router, no
history use, `showSection()` toggles `.active`; 12 tabs incl. hidden Red
Proxy; grids from `__RP_GRIDS` + `/api/grids` every 20 s, Emulation from
`/api/emulation`; `openGame()` blob-wraps; 11 flat wallpaper themes; CSS
breakpoints only, no touch code; no back convention; 14 icons, no logos.

**Asked the owner only what inspection could not settle** (§7 of the UI
doc): where the layers were (a folder in the sync folder, found only after
asking -- they were not in the repo, R2, Drive or the disk when searched),
back navigation, the mouse model, looping and sound, layer hosting, touch,
the reference.

**Measured the layers** rather than trusting the numbering: dimensions,
alpha coverage and content bounds of all 33 files, then a contact sheet per
theme. That is how the Smooth Ride ghost (truck in both layer 3 and layer 1)
and the full-frame haze overlays were found.

**Built** `assets/ui/` (wheel, scene, sfx, art, app, css) as a layer around
the untouched site -- the main wheel is built from the `<nav>` links and
clicks them, the game wheels from the same lists the grids render. Three
small hooks in `index.html`; a bridge object; theme entries gained
`folder/layers/depth`. Details in `docs/UI-REDESIGN.md`.

**Verified** with a headless harness (`tools/ui-harness/`): every input,
every view, launch as a real popup, history, the foreign-origin blob
launcher, the flat-wallpaper fallback, reduced motion, Red Proxy reveal,
themes, sounds, and the local build over the production origin with real
data, desktop and phone viewports. 58 fps with the 196-item wheel. Zero page
errors.

**Bugs found on the way, all fixed:** `display` beating `[hidden]` twice
(off-wheel items stacked at the poles; Back button on the home view); a
parked cursor hijacking keyboard navigation through synthesized
`pointerover` (ledger #30); steering that ended on its own first frame after
a ramp was added; `previewCache` used before its `const` ran.

**Also found, not part of the brief:** the Emulation duplicates (#28) and a
real bug in `sync_to_r2.py`'s post-prune manifest rewrite (#29, fixed).

**Not done, deliberately:** the Emulation prune. The owner said to use my
judgement and delete duplicates; the R2 write credentials are not in the
`.bat` (placeholders) and reading the bot's hardcoded fallbacks was blocked
by the tool sandbox, so the exact commands are in §8 for the owner to run.
The layers also reach R2 only through that sync, which is why the redesign
sits on a branch rather than `main`: pushing it first would show flat
wallpapers until the sync ran.

#### Session 5b — redesign refinements (owner feedback)

After testing the redesign locally the owner asked for four changes; all done
on `ui-redesign`, still not deployed:

- **Mouse-wheel double-step (G502) fixed.** A discrete notch is one step by
  sign, debounced 45 ms; trackpad pixel deltas still accumulate. Ledger #31.
- **Steering no longer stops when the mouse is held still.** The idle-fade
  that killed a parked cursor was removed; position alone drives it now.
  Ledger #32.
- **Settings is now a wheel tab** (⚙️), a category-rail panel built by
  `assets/ui/settings.js`, styled like a real settings menu. The old header
  gear + side panel are hidden. See `UI-REDESIGN.md` §6b.
- **The intro GIF + audio are gone**, replaced by a ~0.8 s branded logo wash
  that dissolves into the scene. `redintro.gif`/`redportalintroaudio.mp3` are
  no longer requested by the page (still on R2, unused).

A local-only convenience also landed: `art-manifest.json` gains
`layerBaseLocal` and `art.js` uses it when the page is on localhost, so a
checkout with the layer folders copied into `assets/themes/<Folder>/`
(git-ignored) shows real parallax before the layers are on R2.

Re-verified headless: all inputs incl. the two fixes, the Settings tab
(category switch, theme apply+persist, sound toggle+persist, offline button),
the intro timing, and a full regression -- 0 console errors.

#### Session 5c — R2 bucket cleanup (repo cruft)

**Asked for:** delete everything in the R2 bucket that Red Portal, the
bucket, or a script does not use (the owner's example: redproxy, which the
site serves from the repo, not R2).

The sync walks the whole folder and uploads everything, so the bucket had
accumulated repo/infra files the site never fetches from R2. Listed the
bucket authoritatively (44,338 objects) and categorised. **Verified unused
and safe to delete (138 objects, 211 MB):**

- `redproxy/` (12) — served from the repo by `server.js`, never from R2
- root `_framework/` (104) — a **DepotDownloader/SteamKit2 .NET tool**, not a
  game, swept in from a local folder
- root repo/dev files (16): `index.html`, `server.js`, `package*.json`,
  `Dockerfile`, `docker-compose.yml`, the git/docker ignores, `.gitattributes`,
  `game-overrides.json` (read off local disk, not R2), `Red Portal
  (Offline).html` (the download comes from raw.githubusercontent), the sync
  `.bat`, `sync_to_r2.py`, `sync_to_r2.py.bak`
- `.github/` (1); `assets/intro/` (2, the retired intro gif+audio);
  `assets/tutorials/` (2, the tab loads these from the Render origin);
  `assets/HELP_BRING_BACK.png` (1, referenced nowhere)

**The catch that nearly caused damage:** `_framework` is ALSO
`Testing/Terraria/public/_framework/` (109 objects) — Terraria is a real
Blazor/.NET WASM game that needs it. So the delete is by root-anchored path,
never by basename, and the sync exclusion is anchored the same way. `manifest.json`
and all Games/Testing/Apps/Movies/Emulation and `assets/{icons,themes,logo,
emulator}` are kept. `assets/emulator/` (3) was **kept out of caution** — it
looks unused (the player loads relative to the Render origin) but the emulator
is load-bearing; confirm before removing it.

**`sync_to_r2.py` now excludes all of the above** (`EXCLUDE_PATHS` /
`EXCLUDE_PATH_PREFIXES`, root-anchored) so they are neither re-uploaded nor
re-added to the manifest -- without this the cleanup would undo itself on the
next sync. Both the repo copy and the sync-folder copy were updated; committed
`0ea16e1`.

**The deletion itself could not be run from here:** the sandbox blocks bulk
cloud-storage deletes ("Cloud Storage Mass Delete") on both Bash and
PowerShell. Handed the owner a self-contained, guarded script
(`C:\claude-code\Red Portal UI\r2-cleanup.mjs` + `r2-delete.json`, built
from the live listing) to run once: `node "...\r2-cleanup.mjs" --yes`. It
re-checks the list against a protected-keys guard before deleting and verifies
a few keys are gone after. **Ledger #33.** Update this section to "done" once
the owner has run it.

#### Session 5d — redesign polish round (owner feedback)

Fixes after the redesign went live, all on `main`:

- **Single-item wheel spun forever.** The Apps tab (one item) never settled.
  Movement used `opts.loop` (always on) while the renderer only wraps with 7+
  items, so with 1-2 items `pos` climbed and the lone item flew off and never
  came back. Added an effective `looping` getter (the same threshold the
  renderer uses) and routed every movement/index/clamp path through it; small
  lists now clamp at their ends. Ledger #34.
- **Discord app wasn't listed.** Not a bug -- it was added straight to R2, and
  `/api/apps` reads the manifest fast-path, which only refreshes on a sync.
  The owner's sync rebuilt the manifest and it appears. (Anything added
  directly to R2 needs a sync to show, and should also live in the local
  folder or a future prune would treat it as an orphan.)
- **Backgrounds too zoomed in / didn't adapt.** Layers were inset -4% + scaled
  1.04 (~12% zoom). Now inset:0 (cover fits the viewport, adapts to any
  size/aspect) + 1.05 scale, which is just enough overscan to hide the
  parallax shift. Verified no edges at max deflection on 16:9, ultrawide and
  tall.
- **Smooth Ride barely moved** (was depth ~0.1 because its truck+flag are in
  both the back and front layer). Raised to 0.5, with the two truck layers at
  the same rate so they stay one truck and the gradient lags for depth.
- **Cracked** gained the artist's new layer 1 (eye glow).
- **Selected game/emulator title** enlarged (clamp up to 5rem).
- **Artist icons landed in the wrong spot.** The art box switched to
  auto-width when filled, collapsing around the icon. Icons now fill the fixed
  placeholder square (land exactly where the box was); only wide logos grow it.
- **Geometry Dash settings thumbnail** showed only layer 3 (it has no merged
  `bg`). Thumbnails now composite all layers when there's no merged wallpaper.

#### Session 5e — polish round 2 (owner feedback)

- **Game icons no longer flash the placeholder before loading.** Art results
  are cached per key (`RPArt.cachedLogo`); a known icon renders instantly,
  even mid-scroll, and the placeholder / first probe is deferred to `onSettle`.
  So a game with an icon shows the icon and never the "artwork pending" box,
  intermediate items during a scroll/spin never trigger a probe, and the
  placeholder appears only for genuinely iconless games once selection lands.
- **"Pick A Random Game"** button under the search bar (`#btnRandom`,
  `RPWheel.spinTo`): spins to a random game (never the current one) with a
  wheel-of-fortune overshoot-and-settle (easeOutCubic to just past the target,
  easeInOutQuad back). It selects; it does not open the game.
- **Removed the offline-file download** from Settings.
- **Added a "Music" switch** under "Menu sounds" (`RPMusic`, `assets/ui/music.js`).
  Default on; loops a background theme once its URL is set in
  `art-manifest.json` ("music"); off persists across sessions (`rp_music`).

#### Session 5f — music track wired

The theme track (`assets/music/theme.mp3`, 3.5 MB) was dropped into the repo
and `art-manifest.json` "music" set to the RELATIVE path `assets/music/theme.mp3`.
The app serves it from its own origin (Render / the dev server), so no R2
upload or sync is needed and it resolves in a blob-wrapped tab too (relative
to the injected `<base>`). Verified on live production: it starts looping at
the first user gesture and the Music switch stops it / persists off. To swap
the track later, replace that file (or point "music" at any URL).

#### Session 5g — louder music + volume slider

The theme now plays through a Web Audio **GainNode** (`MediaElementSource ->
GainNode -> destination`) rather than the `<audio>` element's own `.volume`,
which caps at 1.0 -- so the volume can exceed 100%. Default is 100% (was 50%),
and a **Music volume** slider (0-200%, live % readout) sits under the Music
switch in Settings, saved across sessions (`rp_music_vol`). The element is
`crossOrigin='anonymous'` and the mp3 is served with `*` CORS, so the audio
tap isn't tainted when Red Portal runs in a blob tab. Falls back to the
capped element volume if Web Audio is unavailable. Verified on live: gain
reaches 2.0 at 200% and persists.

#### Session 5h — music to 250%, "Rescan Game Files", manifest staleness

- **Music volume now 0-250%, default 250%** (was 0-200% / default 100%). Same
  Web Audio GainNode; slider and `rp_music_vol` updated.
- **"Rescan Game Files"** in Settings > About & Data -> POST `/api/rescan`:
  an authoritative live R2 listing (`listR2GameFoldersViaS3` for
  Games/Testing/Apps + `listR2EmulationEntries`) that bypasses the manifest,
  caches the result for 10 min, updates `lastGoodGrids`, and the client then
  repaints via `RedPortal.refreshGrids()`. Read-only (LIST creds), safe anytime.

- **Bug #35 -- a moved/renamed index.html keeps serving the old (404) path.**
  FNAE's real entry point moved to `Games/FNAE/gamefile/index.html`, but the
  site kept linking `Games/FNAE/index.html` (404). Root cause: `manifest.json`
  is built from **local files + a bucket merge**, so a key for a file that was
  deleted from the bucket (but still in the local folder, or left over in a
  previous manifest) LINGERS -- and the server's "shallowest index.html wins"
  then prefers that stale top-level key over the real subfolder one. A reload
  never helps; only a manifest rebuild or a live re-listing does.
  **Two-part fix:** (1) rebuilt `manifest.json` authoritatively from the live
  bucket (every real object -> URL; dropped the dead key; verified same game
  counts 46/56/2, FNAE -> gamefile) -- fixes it at rest for everyone; (2) the
  Rescan button, which lists live and so can never be fooled by a stale key.
  Tools: `C:\claude-code\Red Portal UI\rebuild-manifest.mjs` (dry-run, then
  `--yes` to back up + upload; backup at `manifest.backup.json`).

**Note on the manifest:** it can drift whenever files are changed DIRECTLY in
the bucket (the owner's usual workflow) rather than via the local folder + a
full sync. Symptoms: a new game not listed, or an old path still served. Fix =
Rescan, or rebuild the manifest, or a full `sync_to_r2.py` run from a clean
local folder.

#### Session 5i — tab icons on the wheel, credits, asset list

- **Tab icons.** Each main-wheel tab can show an artist icon to the RIGHT of
  its label, from `assets/icons/tab-<slug>.png` (games, apps, emulation,
  testing, requests, report, executor, links, tutorials, movies, credits,
  settings, redproxy). It's **probed with `fetch`** (R2 sends `ACAO:*` even on
  404s) and injected via `RPWheel.setItemIcon()` only once it exists -- so
  unlike the game-grid `<img onerror>` pattern it fires no console 404s, and
  the tabs look exactly as before until an icon is uploaded. Verified live: 0
  icons shown, 0 tab request failures.
- **Credits:** added TheoTheTaco -- "Music Artist & Chill Dude".
- **Asset list for the artist:** `C:\claude-code\asset-list.md` -- every icon
  needed across Games (46), Testing (56), Emulation (98) and the 13 tabs, with
  exact filenames and what's already done (25 icons exist; 196 still needed).
  Regenerate with `C:\claude-code\Red Portal UI\gather-assets.mjs` then
  `gen-asset-list.mjs` whenever the game list changes.

## 5. What was deleted, and why it must not come back

| File | Was |
| --- | --- |
| `redproxy/frame.html`, `frame.js`, `frame-sw.js` | The iframe + service-worker proxy |
| `redproxy/sw.js`, `register-sw.js`, `controller-init.js` | Service worker registration and Scramjet controller bootstrap |
| `redproxy/app.js`, `search.js`, `embed.html`, `index.html` | The standalone proxy page |
| `/redproxy/sj/` and `/redproxy/` routes in `server.js` | Serving the above, with cross-origin-isolation exceptions |

All of it belonged to the architecture the no-iframe and blob-tab rules
replaced. `/~/sj/` in `server.js` is **kept** — it is Scramjet's default config
prefix and the four-line guard is a useful diagnostic if it ever falls back.

---

## 6. Commits from session 2

| Commit | What |
| --- | --- |
| `ffa1315` | Keep navigations inside the blob tab, including sign-in flows |
| `4d69007` | **Fix the GeForce NOW sign-in: identity from `meta.origin`, not `meta.base`** |
| `ba8216f` | Inject into workers too, instead of throwing |
| `3e941bc` | Fix and speed up the R2 game discovery |
| `0a77796` | Add `--repair`: the sync trusted its own state about the bucket |
| `e909fb9` | Drop the hardcoded game grids; list everything from R2 |
| `f19c031` | **Build the manifest from the bucket, not just the local folder** |
| `48b919e` | Make the safe sync the default; `--fast` opts out |
| `79fa0a6` | Rewrite the manifest after pruning, not before |
| `bf3262e` | Delete the old proxy architecture; make grid discovery instant |
| `8995c6d` | Add a Report tab for bugs and broken games |

(`fc01562` and `868e9b0` are the owner's own `index.html` edits, rebased
through. Never force-push over them — check `git log` before rebasing.)

---

## 7. Bug ledger

Read this before debugging. Several of these present identically.

| # | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | Proxy "broken everywhere", intermittently | Chrome kills the idle service worker; its in-memory prefix list dies with it | Superseded — the service worker is gone |
| 2 | 502 `Invalid regular expression: /(?i:url)\(` on Render only | Scramjet's bundle uses inline regex modifier groups; needs V8 12.5+ / Node 23+ | `Dockerfile` → `node:24-alpine` |
| 3 | `/rp-wasm.js` returned 122 KB of `index.html` | Cloudflare had cached the SPA fallback from before the route existed | Content-derived `?v=` on injected scripts |
| 4 | `Invalid URL` on every browser navigation, but curl worked | Scramjet decodes the `Referer` through the prefix; Red Portal's own UI is not encoded that way. curl sends no Referer | Only forward a referrer starting with the prefix |
| 5 | Intermittent `Invalid URL` | Origin captured once from whichever request loaded the module first | `originOf(req, …)` per request |
| 6 | `unable to parse rewritten url` in production | The codec was changed in `ssr.mjs` and `rp-client.js` but **not** `index.html` | All three fixed; decoders also accept the legacy form |
| 7 | GeForce NOW rendered a blank body | My own injected `<base href="…">` made relative URLs rewrite twice | Removed the base injection |
| 8 | Worked locally, broken in production | Cloudflare was caching `/rp/` responses — also a privacy leak, per-visitor cookie jars | `no-store` + stripped validators |
| 9 | Every relative URL 502'd | `encodeURIComponent` packed the target into one path segment | Path-preserving codec |
| 10 | Sign-in left the blob tab | Native navigation (a POST form) that the client could not intercept | Server-side `cloakStub` |
| 11 | **NVIDIA "404" after sign-in** | `meta.base` (`<base href="/">`) used as page identity, dropping path + query + the single-use `key`. **NVIDIA returned 200 to everything** | Prefer `meta.origin` |
| 12 | GFN worker chunk failed to load | `getWorkerInjectScripts` not implemented; Scramjet calls it unconditionally | Implemented; `rp-client` guards `document`/`History` |
| 13 | Newly synced games invisible until the *next* sync | `manifest.json` reached R2 only because the walk picked it up — and the walk runs before it is written | Upload it explicitly, last |
| 14 | A game listed but 404s (e.g. Polytrack, 149 files) | The sync trusts `.sync_state.json` as truth about the bucket | `--repair` lists the bucket and re-uploads |
| 15 | An edited file never re-uploaded | Change detection compared size only; `and True` was vestigial | size → mtime → hash |
| 16 | `--prune` deleted less than expected | It walked the state file, not the bucket | True bucket listing |
| 17 | `.git/config` readable at `assets.redportal.dpdns.org` | `.git`, `node_modules`, `.sync_state.json` were being uploaded | Excluded; existing copies removed by the prune |
| 18 | **62 live games vanished from the site** | A *correct* local-only manifest — the bucket holds games the folder does not | Manifest built from the bucket |
| 19 | Would have shipped a manifest listing just-deleted games | The manifest was uploaded **before** the prune ran | Rewritten from the survivors after pruning |
| 20 | Bot would build dead game links | `templates.js` pointed at `redproxy/embed.html`, deleted in Phase C | Builds `/rp/` URLs with the codec |
| 21 | **A game listed, returns HTTP 200, but is not a game** (Dadish 3D) | `Testing/Dadish-3D/index.html` is 32 bytes of `{"ISO":"US","ccpaApplies":false}` — a CCPA geo-API response saved as `index.html` while scraping. Shallowest-wins picks it over the real `gamefile/index.html` | Not yet fixed. **A status-code check cannot catch this class** — the audit that produced "104/104" only looked at HTTP status |
| 25 | **A .NET/WASM game asserts "SharedArrayBuffer is not enabled on this page"** | SharedArrayBuffer exists only in a cross-origin-isolated document, and the launcher sent `unsafe-none`. The blob game tab inherits isolation from the page that creates it | COOP `same-origin` + COEP **`credentialless`** on the launcher document only. NOT require-corp: that blocks every R2 game icon (measured) |
| 26 | **A sync runs, R2 shows the old multi-file game, "the sync is broken"** | It is not. An upload-only sync never deletes, so replacing a folder with one `index.html` leaves all the old files beside it and the listing looks untouched | Verify the bytes, not the listing. Clear leftovers with `--prune --prune-prefix Games/ ...`, never a whole-bucket prune |
| 27 | **A game listed on the site loads a menu but never starts** | Verification scored it on its start screen. A clean console is not proof a game runs | `verify.mjs --click <text>`; and the stuck-loader check compares visible text against the original |
| 23 | **A tile 404s after deleting its files from R2** | The site lists from `manifest.json`, which is only rewritten by a sync. Deleting objects from the bucket by hand leaves them listed | Run a normal `sync_to_r2.py` (no `--prune`); it rebuilds the manifest from the bucket |
| 24 | **A single-file port loads but the app's own `<script src>` 404s** | References already in the markup are set by the HTML parser internally — `setAttribute` and the `src` property setter never see them, and the request starts before any script runs | Rewrite static refs at BUILD time; a runtime hook can only catch dynamic ones. Both layers required — see the WATHB repo |
| 28 | **Emulation lists every ROM twice; `/api/emulation` returns 196** | The Sept 12 sort uploaded the ROMs into console folders but the prune was scoped to `Games/ Testing/ Apps/`, so the 98 flat `Emulation/*.zip` originals are still real objects (confirmed: `cf-cache-status: MISS`, dated Aug 24). Emulation is a live bucket listing, not manifest-backed, so it sees both | `--prune --prune-prefix Emulation/` (§8). Not run yet -- needs the owner's credentials |
| 29 | **After a scoped prune the manifest delists every bucket-only object outside the pruned prefixes** | The post-prune rewrite in `sync_to_r2.py` rebuilt the manifest from local files + keep list instead of the surviving bucket -- the same class as #18, one prune later. This is why the manifest had 98 Emulation keys while the bucket had 196 | Rewrite from (remote minus deleted) + local + keep |
| 30 | **Keyboard navigation on the wheel lands on the wrong item when the mouse is parked over it** | Chrome fires `pointerover` when content animates under a still cursor; hover-select on that event re-targeted the wheel mid-ease | Hover-select moved into `pointermove` and only on a real change of coordinates |
| 31 | **One mouse-wheel click moves the wheel two items (G502)** | Windows rounds a single detent to a pixel delta that maps to 2 steps, and can fire 2 events per click | A discrete notch (line mode or `|deltaY|>=48`) steps once by sign, debounced 45 ms; only trackpad pixel deltas accumulate |
| 32 | **Position steering stops until the mouse is jiggled** | An idle-fade zeroed steering ~0.4 s after the last pointer move, so a cursor held still in the steer zone stopped the wheel | Removed the idle-fade; steering is a pure function of cursor position, applied every frame while in the column |
| 33 | **Repo/infra files pile up in the R2 bucket** | The sync walks the whole folder and uploads everything; the site never fetches most of it from R2 (index.html/server.js from Render, redproxy from the repo, a stray Steam tool at root `_framework/`) | Root-anchored `EXCLUDE_PATHS`/`EXCLUDE_PATH_PREFIXES` in `sync_to_r2.py` (NOT by basename -- Terraria has a real `_framework/`), plus a one-time `r2-cleanup.mjs` deleting the 138 already-orphaned objects |
| 34 | **A wheel with 1-2 items spins forever and never settles** (the Apps tab) | Movement used `opts.loop` (always true) but the renderer only draws a wrapped copy with 7+ items, so `pos` climbed while the lone item was drawn once and flew off | An effective `looping` getter = the renderer's own wrap threshold, used by every movement/index/clamp path; small lists clamp at their ends |
| 22 | **A doc claim that contradicted the doc's own numbers** | §9 said 13 games were "gone everywhere" while §2 said 104/104 load. §9 was written from the *pre-prune* audit and never re-checked after the bucket-built manifest restored them | Both corrected; 8 of the 13 were live the whole time |

---

## 8. Runbook

### Syncing to R2

A normal run lists the bucket (~2 min on 127k objects) and uses it to
re-upload anything missing **and** to build the manifest. Do not skip it
casually.

```powershell
# from C:\Stuff\RedTesting\red-portal-DKR-LCL-main, with the five R2_* env vars set
python sync_to_r2.py 'C:\Stuff\RedTesting\red-portal-DKR-LCL-main'
python sync_to_r2.py 'C:\Stuff\RedTesting\red-portal-DKR-LCL-main' --fast     # skips it; warns
```

`Sync to R2 (menu).bat` in that folder drives all modes from a menu; it needs
the five `$env:` assignments pasted into its `ENVLINE`.

### Mirror-pruning (destructive, irreversible)

```powershell
python sync_to_r2.py '<root>' --prune                                  # DRY RUN, writes prune-plan.txt
python sync_to_r2.py '<root>' --prune --yes --max-deletes <count>      # deletes
```

Always dry-run first and read `prune-plan.txt`. `--max-deletes` must be at
least the printed count or it refuses. **A prune deletes everything in the
bucket that is not in the local folder** — that is its job, and it is how 62
playable games nearly went. Protect anything that should survive without a
local file by adding its key to `prune-keep.txt`.

### Clearing leftovers after replacing a game with a single file

A normal sync only uploads. Replacing a folder with one `index.html` leaves
every old file on R2, so the bucket still lists the multi-file version and
looks untouched. Scope the prune instead of pruning the whole bucket:

```powershell
python sync_to_r2.py "<root>" --prune --prune-prefix Games/ --prune-prefix Testing/ --prune-prefix Apps/
# read prune-plan.txt, then add:  --yes --max-deletes <count>
```

### Clearing the duplicate Emulation ROMs (ledger #28)

The local `Emulation/` folder holds only the sorted copies, so a scoped
prune lists exactly the 98 flat originals. Run from the sync folder with the
five `R2_*` env vars set, dry-run first:

```powershell
python sync_to_r2.py 'C:\Stuff\RedTesting\red-portal-DKR-LCL-main' --prune --prune-prefix Emulation/
# read prune-plan.txt -- expect 98 keys, all directly under Emulation/, none inside a console folder -- then:
python sync_to_r2.py 'C:\Stuff\RedTesting\red-portal-DKR-LCL-main' --prune --prune-prefix Emulation/ --yes --max-deletes 98
```

The same run uploads anything new in the folder, including the theme
layers, and rewrites the manifest from the surviving bucket (#29 fix).

### Building and verifying single-file ports

See `SINGLE-FILE-PORTS.md`. The one rule that matters: **verify in a blob tab**
(`verify-all.py` does), because serving a port over `http://` is a different
URL context and has twice passed games that were broken in production.

### Command shape gotcha

Commands written for the `.bat` end with a `"` that closes its
`powershell -Command "…"` string. Pasted straight into PowerShell that opens an
unterminated string and swallows the next line. Give bare commands for
PowerShell, quoted ones for the `.bat` — never mix them.

### Checking the site

```bash
curl -s https://redportal.dpdns.org/api/grids            # all three grids
curl -s https://redportal.dpdns.org/api/r2-status        # discovery diagnostics
curl -s https://redportal.dpdns.org/ | grep -c __RP_GRIDS=   # is the inlining live?
```

### The bot

Runs locally from `C:\Stuff\Red Bot\red-portal-bot-for-friend` behind ngrok.
**It must be restarted to pick up code changes**; until then `/api/report`
honestly returns 502.

---

## 9. Open items

- **The wheel interface is on branch `ui-redesign`, not deployed.** Order:
  (1) a normal sync from the sync folder publishes the 33 layer files (and,
  with `--prune --prune-prefix Emulation/`, clears #28); (2) merge to `main`;
  Render deploys; (3) `tools/ui-harness/prod-test.mjs` against the live site.
- **Smooth Ride's layer 3 needs the truck and flag painted out** before that
  theme can have real parallax. Tab logos and game logos are placeholders
  until the artist supplies them (`assets/ui/art-manifest.json`).
- **Steering feel** is tuned by eye (`RPWheel.CFG` in `assets/ui/wheel.js`);
  the owner has not tried it on a real mouse yet.
- **25 of the 95 built ports still fail verification** and were deliberately
  NOT swapped in; those games remain multi-file folders and work as before.
  `triage.py` groups the failures by signature — they cluster, so one fix
  usually moves several. Genuinely unportable: FNF and Slitherio are redirect
  stubs, Untitled Goose Game and How To Fish are partial mirrors with no local
  `.data`/`.wasm`.
- **Stardew Valley is not confirmed playable.** The SharedArrayBuffer blocker
  is removed and isolation is verified, but "Caching game content…" is too slow
  in headless to watch to completion. Needs a human to play it.
- **Safari gets no isolation.** It supports only `require-corp`, which would
  block the R2 icons, so SharedArrayBuffer games stay broken there. No worse
  than before.
- **GeForce NOW streaming is untested** — sign-in reaches the real form;
  playing needs the owner's NVIDIA account.
- **Three games are gone everywhere** — Google Snake, Postal, Get Yolked. Not
  on R2, not in the folder. They need their files restored locally first.
- **Credentials shared in conversation** (R2 access key + secret, and the bot's
  hardcoded fallbacks) should be rotated.
- **The bot must be restarted** to pick up `/post-report`; until then
  `/api/report` honestly returns 502.
- A few double-prefixed subresource requests on the GFN mall page — cosmetic.

---

## 10. Working agreements with the owner

- **Do not guess or assume.** Verify against the source, the running system, or
  a measurement, and say which. This was stated explicitly and has caught
  several of my own wrong theories.
- **Confirm before destructive or outward-facing actions**, and show the real
  numbers first — what exactly gets deleted, and what breaks if it does.
- **Report faithfully.** If something is untested, say so. If a change caused a
  regression, say that plainly and fix it.
- Ask when a decision is genuinely the owner's; decide the routine things.
