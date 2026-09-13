# Red Portal

## Read the docs before working on this repo

| File | What it holds |
| --- | --- |
| `docs/SESSION-HISTORY.md` | Architecture, the bug ledger, the runbook (including the destructive commands), and the record of what has already been tried and ruled out. **Start here.** |
| `docs/SINGLE-FILE-PORTS.md` | The WATHB pipeline: how a game becomes one self-contained `.html`, every defect class found, the measured limits, and what "verified" actually means. |

Several bugs in this project present identically and have completely different
causes. Checking the ledger first is cheaper than re-deriving them — that has
been true every single time.

## Keep them updated

**Any session that changes code, deploys, finds a bug, runs a destructive
operation, or learns something non-obvious about how this project behaves must
update `docs/SESSION-HISTORY.md` before finishing** — Session Log, Bug Ledger,
Current State numbers, and correct anything now out of date. Port-pipeline
findings go in `docs/SINGLE-FILE-PORTS.md`. This is part of the task, not an
extra. Do not trim the history to make it shorter; the wrong turns are recorded
on purpose.

## This repo is PUBLIC

`github.com/VVVULTURE/red-portal-DKR-LCL`. No R2 keys, Discord webhook,
`BOT_SECRET` or GitHub tokens in any committed file — including the docs. Refer
to them by name.

## Things that break production if you get them wrong

1. **The proxy URL codec exists in three copies** — `redproxy/ssr.mjs`,
   `redproxy/rp-client.js`, `index.html` — and they must stay identical. Only
   `%`, `?` and `#` are escaped, deliberately; `encodeURIComponent` breaks every
   relative URL in a proxied page.
2. **`sync_to_r2.py --prune` deletes everything in the R2 bucket that is not in
   the local folder.** Dry-run first, read `prune-plan.txt`, and prefer
   `--prune-prefix` to scope it. Only ever prune when the owner asks.
3. **A normal sync only uploads; it never deletes.** After replacing a game
   folder with one `index.html`, the old files stay on R2 and the bucket looks
   unchanged. That is not a broken sync — verify the bytes, not the listing.
4. **A blob: document has no resolvable base.** `new URL('.', document.baseURI)`
   THROWS there, and Red Portal runs every game in a blob tab. Anything
   assuming a base dies before it starts.
5. **Verify in a blob tab, never over `http://`.** They are different URL
   contexts. Testing over http has twice passed games that were broken in
   production.

## Hard product rules

No `<iframe>` in Red Proxy. Everything runs in a blob tab. Nothing the proxy
needs is fetched from a third party. Red Portal must keep working when it is
itself launched inside a blob tab.

## Working agreements

Do not guess or assume — verify against the source, the running system, or a
measurement, and say which. Confirm before destructive or outward-facing
actions and show the real numbers first. Report faithfully: if something is
untested, say so.
