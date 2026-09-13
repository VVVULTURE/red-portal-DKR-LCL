# Single-file game ports (WATHB)

Every playable game on Red Portal that could be converted is now **one
self-contained `.html` file**: no subresources, no network requests, and it
works inside a blob tab. This document is the companion to
`SESSION-HISTORY.md` and covers only that subsystem.

The builder lives in its own repo: **`VVVULTURE/Web-App-To-HTML-Builder`**
(private). Working copy `C:\Stuff\WATHB`, output `C:\Stuff\WATHB-built`,
replaced originals `C:\Stuff\WATHB-replaced-originals`.

---

## 1. The one thing to understand first

**A blob: document is not a page served over http.** Red Portal launches every
game by fetching its HTML and re-hosting it as a `blob:` URL, and a blob URL is
**opaque, not hierarchical**:

```js
new URL('.', document.baseURI)          // THROWS in a blob document
new URL('assets/x.png', blobUrl)        // THROWS
```

Anything that assumes a resolvable base dies on its first line and takes the
whole app with it. This single fact caused the worst bug in the project: the
runtime threw before installing a single hook, so there was no virtual
filesystem at all, and three games came back as white screens.

**Verify in a blob tab or you have not verified anything.** Serving a port over
`http://` exercises a completely different URL context. That mistake passed two
full verification runs over games that were broken in production.
`blob-harness.html` in the WATHB repo reproduces Red Portal's real launch path;
`verify-all.py` uses it by default.

---

## 2. How a port is built

Two layers. **Neither is sufficient alone**, and that is the central fact.

### Build time — `build.py`

References already present in the markup **cannot** be caught at runtime: the
HTML parser sets those attributes internally and starts the request before any
script executes. Patching `setAttribute` or the `src` setter catches nothing.
So the builder rewrites them first:

| Input | Becomes |
| --- | --- |
| `<script src>` | inlined, order preserved, `onload` replayed |
| `<link rel=stylesheet>` | inlined `<style>`, `@import` flattened |
| `url()` in CSS | data URI, resolved **relative to the stylesheet** |
| `<img>`, `<audio>`, `srcset` | data URI under 256 KB, `data-wathb-src` above |
| `<iframe src="local.html">` | built recursively, attached at runtime as a blob |
| `<base href>` | removed — it would re-point every relative URL |
| remote `<script>`/`<link>` | fetched and embedded, or dropped if telemetry |

Everything else is concatenated into one payload, base64'd, and carried
alongside an index of `path -> [offset, length, mime]`.

### Run time — `rpvfs.js`

Installed in `<head>` before any app code. Catches everything dynamic: `fetch`,
`XMLHttpRequest`, `img.src =`, `new Audio()`, injected `<script>`, Workers and
`importScripts`, `WebAssembly.instantiateStreaming`, CSS text poured into a
`<style>` element, `style.backgroundImage`, `new URL()`, `new Request()`.

A request for something absent returns a **synthetic success of the right
shape** — `{}` for JSON, a 1×1 PNG for images, a valid silent WAV for audio —
never a 404. That is what keeps the console clean.

---

## 3. Defect classes, and what each one taught

Every one of these was found by testing, and every one was a class affecting
many games rather than a single quirk. They are listed because the symptom
rarely points at the cause.

| Symptom | Actual cause |
| --- | --- |
| White screen; `'x' is not a valid URL` | `new URL('.', document.baseURI)` throws in a blob; the runtime died before installing anything |
| Stuck on "Downloading…", **console completely clean** | an inlined `<script>` never fires `onload`, and love.js starts Balatro from it |
| `Cannot set property response of #<XHR>` | GameMaker installs getter-only accessors on `XMLHttpRequest.prototype` — which is OUR prototype once the global is replaced |
| `WebAssembly.instantiate(): BufferSource argument is empty` | the page's OWN `blob:` URL was being synthesized over; Brotato merges its wasm from `.partN` files |
| `Failed to construct 'URL': Invalid base URL` | the *app's* own `new URL()` call, same opaque-base problem |
| `google is not defined` | a removed ad SDK's global; the frame it throws in dies |
| `SecurityError … ServiceWorkerRegistration` | in a blob document the origin is opaque, so **every** SW call throws, not just `register()` |
| Mojibake; `Invalid regular expression: range out of order` | the payload pushed `<meta charset>` past the 1024 bytes a browser sniffs, so it fell back to Latin-1 |
| A library silently undefined, error three steps later | `decode('utf-8','replace')` destroyed a Latin-1 script; use latin-1, which round-trips bytes |
| `Automatic publicPath is not supported` | webpack reads `document.currentScript.src`, always empty for an inlined script |
| 79 assets pulled from a CDN | an `<iframe>` is its own document; the generic media path turned it into a `data:` URL with no runtime inside |
| A file referenced but "missing" | the ripper percent-encoded the filename on disk (`Dadish%202%20Pk.js`), or mirrored a CDN tree into escaped directories |

---

## 4. Hard limits, measured

- **V8 caps a single JS string at 512 MiB**, so base64 carries at most
  **384 MiB** of assets. Eight games exceed it and can never be single files:
  Silksong (4.6 GB), OMORI (2.9 GB), Cuphead, Deltarune, GTA Vice City,
  Animal Crossing, Hollow Knight, Getting Over It. The builder refuses rather
  than emitting something broken.
- **Single files are ~33% larger and do not stream.** Buckshot Roulette is
  494 MB as one file; a player waits for all of it before anything appears.
  Under 50 MB the trade is clearly worth it; over 150 MB it is a real cost.
- Games whose assets live on a remote CDN rather than in the folder cannot be
  made self-contained. `missingRefs` in `build-report.json` names them.

---

## 5. Verification: what "passed" actually means

`verify.mjs` loads the port **and the original** and reports only problems the
original did not already have. A port passes when it adds no errors, no
exceptions, no failed requests, makes **zero** sub-requests, and is not sitting
on loader text the original has moved past.

**That is a comparison, not proof the game works.** Stardew Valley "passed"
while being unplayable, because the original was equally unplayable. Treat a
pass as "no worse than before", and play the game yourself before believing it.

Traps that produced **false** results, all fixed, all worth remembering:

- A 12-second wait reported Basketball Legends as "stuck" when it simply had
  not started. **A short timeout does not give fast results, it gives wrong ones.**
- A percent-encoded filename (`Baldi%27s`) missed the ignore list, so the
  harness's own fetch looked like the port reaching the network.
- A job that blew its deadline was recorded as failed **and then also
  reported a pass** when the work finished — one game, two verdicts.
- One browser cannot survive the whole set; it dies of memory exhaustion around
  job 70 and everything after fails with "could not create target", which looks
  exactly like a game defect. `verify-all.py` runs a fresh browser per slice.
- A game gated behind a start button is scored on its menu unless you pass
  `--click`.

---

## 6. Current state (2026-09-12)

| Measure | Value |
| --- | --- |
| Games verified and replaced with a single file | **70** |
| Verified overall | 70 of 95 built |
| Cannot ever be single-file (over the ceiling) | 8 |
| Live games loading | **103 / 103** |
| R2 objects | 44,306 (was 50,083 before the orphan prune) |

Replaced games are one `index.html` and nothing else — `Games/Balatro/` on R2
is now a single object. Originals are in `C:\Stuff\WATHB-replaced-originals`
with a manifest; rollback is one command:

```
python replace.py --restore --apply
```

Games that failed verification and the 8 over-ceiling ones were left untouched
as multi-file folders.

---

## 7. Runbook

```powershell
# build one
python build.py "C:\...\Games\Balatro" -o Balatro.html

# build everything under a Red Portal root
python batch.py "C:\Stuff\RedTesting\red-portal-DKR-LCL-main" -o C:\Stuff\WATHB-built

# verify in blob tabs, fresh browser per slice
python verify-all.py --built C:\Stuff\WATHB-built --size 8 --concurrency 3

# group the failures by root signature -- they cluster
python triage.py --built C:\Stuff\WATHB-built

# swap verified games in (dry run first; --restore --apply reverses it)
python replace.py --built C:\Stuff\WATHB-built --root "C:\...\red-portal-DKR-LCL-main"
```

Two local servers are needed while verifying: the Red Portal root on **8801**
(originals) and the built output on **8802** (ports).

---

## 8. Publishing a port to R2

A normal sync **only uploads; it never deletes.** Replacing a folder with one
`index.html` therefore leaves every old file on R2, and the bucket looks as
though the sync did nothing — the new `index.html` is there and being served,
but `game.data`, `love.wasm` and the rest sit beside it. This is confusing
enough that it has been reported as "the sync is broken" when it was not.

Clear the leftovers with a **scoped** prune, never a whole-bucket one:

```powershell
python sync_to_r2.py "<root>" --prune --prune-prefix Games/ --prune-prefix Testing/ --prune-prefix Apps/
# read prune-plan.txt, then add:  --yes --max-deletes <count>
```
