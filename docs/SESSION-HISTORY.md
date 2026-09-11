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

Last updated: **2026-09-10** (re-verified against the live site)

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

**The local sync folder is not the repo.** It holds the game files (`Games/`,
`Testing/`, `Apps/`, `Emulation/`, `Movies/`) that get uploaded to R2. The repo
holds the *site* and no game files at all. Confirm this before assuming a game
is "missing from the repo" — they were never there.

### Key files

| File | Role |
| --- | --- |
| `server.js` | Everything: static serving, `/api/*`, the R2 game discovery, the server-side proxy routes |
| `index.html` | The whole front end, one file, two inline `<script>` blocks |
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

## 2. Current state (2026-09-10)

| Measure | Value |
| --- | --- |
| R2 objects | 87,956 |
| Games listed on the site | 104 (Games 46, Testing 57, Apps 1) — **2 are now dead tiles, see below** |
| Games listed that actually load | **102 / 104** — Dadish 3D and Recoil were deleted from the bucket; the manifest still lists them (ledger #23) |
| Hardcoded game links in `index.html` | **0** |
| Requests before the grids appear | **0** (inlined into the HTML) |
| `manifest.json` | ~875 KB gzipped, revalidated by ETag |
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
| 23 | **A tile 404s after deleting its files from R2** | The site lists from `manifest.json`, which is only rewritten by a sync. Deleting objects from the bucket by hand leaves them listed | Run a normal `sync_to_r2.py` (no `--prune`); it rebuilds the manifest from the bucket |
| 24 | **A single-file port loads but the app's own `<script src>` 404s** | References already in the markup are set by the HTML parser internally — `setAttribute` and the `src` property setter never see them, and the request starts before any script runs | Rewrite static refs at BUILD time; a runtime hook can only catch dynamic ones. Both layers required — see the WATHB repo |
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

- **GeForce NOW streaming is untested.** Sign-in reaches the real form; playing
  a game needs the owner's NVIDIA account.
- **The manifest needs regenerating.** The owner deleted `Testing/Dadish-3D`
  and `Testing/Recoil` from the R2 bucket (and they are gone locally too), but
  `manifest.json` still lists them, so the site shows two tiles that 404.
  A normal `sync_to_r2.py` run rebuilds the manifest from the bucket and fixes
  it — no prune needed. Ledger #23.
- **Only 3 games are actually missing** — Google Snake, Postal, Get Yolked.
  ~~13 games are gone everywhere~~ **was wrong** — see the correction note
  below. Verified 2026-09-10 by fetching every `href` in `/api/grids`.
- **`Testing/Recoil` is a mirrored game hub holding 372 more playable games**
  (`Testing/Recoil/_cdn/3be7cabfa2eb/*/index.html`) that the site surfaces as a
  single tile. They are already on R2 and already paid for in storage. Listing
  them would take the site from 104 to ~470 games with no new uploads. Three
  games previously believed lost live in here: `a day in the office`,
  `amazing-strange-rope-police-vice-spider`, `last-breath-epstein`. Whether to
  surface them, and how, is the owner's call.
- **Credentials shared in conversation** (R2 access key + secret, and the bot's
  hardcoded fallbacks) should be rotated. Rotating R2 means updating the `.bat`
  and the bot's `.env`.
- **A few double-prefixed subresource requests** on the GFN mall page —
  `/rp/<our origin>/rp/<target>` — which Scramjet's same-origin guard rejects.
  Cosmetic (a couple of login-wall images); cause not yet identified.
- GFN creates its own `blob:` URLs that Scramjet routes to the server, which
  cannot resolve them. Harmless noise, accounts for most recorded errors.

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
