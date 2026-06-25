---
name: Dev pipeline workflows are on-demand only (not auto-start)
description: The IL crawl/extraction/audit pipeline workflows were removed from the workspace because they auto-started and starved dev; run them on-demand via admin endpoints.
---

The three heavy pipeline jobs — IL CBA crawl, IL+OH extraction, stored-CBA audit — are NOT workspace workflows anymore. They were removed because they auto-started on every workspace Run and starved the container (multiple headless Chromium + OCR + full re-extraction), pinning CPU/RAM and crashing the api-server + web dev processes (the upload progress card then looks "stuck" because the dead server can't be polled).

**Why making them run-once did NOT fix it:** Replit's "Project" Run aggregate auto-includes AND auto-restarts every agent leaf workflow. Making the pipeline workflows run-once (removing `sleep infinity`) did not stop them auto-starting on Run, and killing their processes just made the supervisor relaunch them. The only durable fix was `removeWorkflow` to delete the definitions from `.replit` entirely.

**How to run them now (on-demand, no capability lost):** admin panel "Run Now" buttons → POST endpoints, which call the spawn* helpers in `artifacts/api-server/src/routes/admin.ts` directly (child_process, not workflows):
- ISBE directory refresh → `POST /admin/run-directory-refresh`
- Extraction → `POST /admin/run-extraction-cron`
- IL CBA crawl → `POST /admin/start-il-crawl`
- Min-salary sync → `POST /admin/run-min-salary-sync`

**How to apply:** if dev is slow/unresponsive, check `ps`/load for crawl chromium or `06_extract`/`14_audit`/`11_crawl` python; stop them and do NOT re-add these as workflows. Production is unaffected (prod runs the api-server only; no workflows, and no cron after the on-demand refactor).
