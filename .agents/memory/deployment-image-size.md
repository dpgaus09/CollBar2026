---
name: Deployment image >8 GiB limit
description: What bloats the publish image and which dirs are safe to exclude via .replitignore
---

# Publish fails: "image size is over the limit of 8 GiB"

This is NOT a build/compile error — the build succeeds, then the final runtime image
upload is rejected for exceeding 8 GiB. The lever is `.replitignore` (same format as
`.dockerignore`); it trims what ships in the deployment image.

**Why it happens here:** the dev environment accumulates large artifacts that are not
needed by the production runtime. The repeat offenders (sizes drift, re-check with
`du -sh .git .cache pipeline/data .pythonlibs node_modules`):
- `.git` (~1.6G) — version history, never needed at runtime.
- `.cache` (~1.1G) — uv cache, Playwright browser binaries, etc.; regenerable.
- `pipeline/data` (~1.7G) — crawled CBA PDFs / CSVs.

**Why excluding `pipeline/data` is safe:** the deployment is `deploymentTarget = "autoscale"`
(see `.replit`). On autoscale the filesystem is ephemeral and the cron/pipeline jobs do
NOT run (cron needs a Reserved VM), so nothing regenerates or consumes those PDFs in prod.
The production api-server serves structured data from the Postgres DB; the only disk reads
it does from `pipeline/data` are `il_cba_unfound.csv` (has a DB-generated fallback) and the
`il_cba/*.pdf` files (written by admin upload with `local:` storage keys, read only by the
dev-side Python extraction pipeline — never streamed to customers by the prod server).

**How to apply:** when a publish fails on the 8 GiB limit, add the big non-runtime dirs to
`.replitignore`. Do NOT exclude `dist` (built app, needed) or `pipeline/state` (small; admin
crawl-status endpoint reads `il_cba_crawl.json`). `node_modules` is reinstalled at build time.
`.replitignore` only affects publish — no workflow restart needed; it takes effect next publish.
