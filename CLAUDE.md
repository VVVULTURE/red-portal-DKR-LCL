# Red Portal

## Read `docs/SESSION-HISTORY.md` before working on this repo

It holds the architecture, the bug ledger, the runbook (including the
destructive commands), and the record of what has already been tried and ruled
out. Several bugs in this project present identically and have completely
different causes — checking the ledger first is cheaper than re-deriving them.

## Keep it updated

**Any session that changes code, deploys, finds a bug, runs a destructive
operation, or learns something non-obvious about how this project behaves must
update `docs/SESSION-HISTORY.md` before finishing** — Session Log, Bug Ledger,
Current State numbers, and correct anything now out of date. This is part of
the task, not an extra. Do not trim the history to make it shorter; the wrong
turns are recorded on purpose.

## This repo is PUBLIC

`github.com/VVVULTURE/red-portal-DKR-LCL`. No R2 keys, Discord webhook,
`BOT_SECRET` or GitHub tokens in any committed file — including the history
doc. Refer to them by name.

## Two things that break production if you get them wrong

1. **The proxy URL codec exists in three copies** — `redproxy/ssr.mjs`,
   `redproxy/rp-client.js`, `index.html` — and they must stay identical. Only
   `%`, `?` and `#` are escaped, deliberately; `encodeURIComponent` breaks every
   relative URL in a proxied page.
2. **`sync_to_r2.py --prune` deletes everything in the R2 bucket that is not in
   the local folder.** Dry-run first, read `prune-plan.txt`, and protect keys
   that have no local file via `prune-keep.txt`.

## Hard product rules

No `<iframe>` in Red Proxy. Everything runs in a blob tab. Nothing the proxy
needs is fetched from a third party.
