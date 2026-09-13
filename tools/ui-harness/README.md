# UI harness

Headless-Chromium checks for the wheel interface (`assets/ui/`). Each script
drives the real page, prints state after every step, and screenshots. They
need `playwright` with a downloaded Chromium; the request bot's
`node_modules` already has it -- link or copy it next to these scripts, or
run with `NODE_PATH` pointed at it.

The theme layers may not be on R2 yet: every script routes
`assets.redportal.dpdns.org/assets/themes/**` to the files in the sync
folder (`THEMES_DIR` at the top of each file). Edit that path if it moves.

| Script | What it proves |
| --- | --- |
| `ui-test.mjs [url] [outDir] [--mobile]` | keyboard, steering, list wheel, search, launch (a real popup), Escape, history back, panel view, themes. Zero console errors expected. |
| `hover-test.mjs` | hover-select inside the dead band, click-activates, position steering, scroll wheel |
| `touch-test.mjs` | tap-select, swipe fling, tap-activate (real popup), arrow tap on a phone viewport |
| `blob-test.mjs` | Red Portal opened as a `blob:` tab from a **foreign origin** (`launcher.html` on :8899, the real launcher scenario): modules resolve, layers load, history works, a game launches |
| `misc-test.mjs [part3]` | layers unavailable → flat wallpaper fallback; reduced motion; Red Proxy reveal chord → wheel item → panel; theme picker; sound toggle; Executor |
| `prod-test.mjs [--mobile]` | the LOCAL `index.html` + `assets/ui/*` served over the **production** origin by route interception, everything else real -- run this before pushing |
| `perf.mjs` | frame rate while the 196-item Emulation wheel spins with parallax on |

Local server for the first five:

```powershell
# in a checkout with node_modules
$env:PORT=8811; $env:R2_PUBLIC_DOMAIN='assets.redportal.dpdns.org'; $env:SELF_PING_ENABLED='0'; node server.js
python -m http.server 8899   # from a folder holding launcher.html, for blob-test
```

"Zero console errors" excludes the pre-existing icon 404s from the hidden
grids (`assets/icons/<game>.png` for games with no icon), which the old site
produced too.
