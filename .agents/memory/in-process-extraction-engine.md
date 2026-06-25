---
name: In-process extraction engine (admin upload + re-run in prod)
description: Durable job queue + immutable versions + diff/promote for running Claude Vision extraction in-process in live prod; the non-obvious rules and why.
---

# In-process extraction engine

Admins can upload a CBA PDF or re-run an extraction directly in LIVE prod; Claude
Vision runs IN-PROCESS (no Python shell-out, no detached child, no dev→prod copy).
Backed by a durable DB job queue + a single-concurrency in-process worker started
after `app.listen`. v1 scope: salary + provisions for CBA docs only.

## Live tables are a PROMOTED PROJECTION — not extraction output
- A new extraction is persisted ONLY as an immutable version row. It does NOT
  touch the live customer tables (salary schedules / provisions).
- The live tables are written ONLY by PROMOTE, which re-projects a chosen version
  through the EXISTING store fns (delete-then-insert) under a pg advisory lock.
- **Why:** customer reads stay completely unchanged; a re-run is invisible to
  customers until an admin promotes it. This is what makes "re-run in prod" safe.
- **How to apply:** never write extraction output straight to live tables. Add a
  new domain by producing a version + a promote projection, never a direct store.

## Auto-promote ONLY on first extraction of a (doc, domain)
- The worker auto-promotes a successful version ONLY when that (doc, domain) has
  no promotion pointer yet. So a brand-new upload appears for customers
  automatically, but every later re-run requires a manual promote in the admin UI.
- **Why:** first upload should "just work"; re-runs must be human-reviewed via diff
  before overwriting an already-published projection.

## Fail-closed
- A failed / unparseable / truncated extraction records NO version and does NOT
  promote — existing live rows are left intact. Only a clean extraction becomes a
  version eligible for promotion.

## Requires an ALWAYS-ON deployment (Reserved VM) — not Autoscale
- The worker is an in-process background loop. On Autoscale the instance scales to
  zero when idle (queued jobs never drain) and can be killed right after a request
  returns (in-flight extraction orphaned; boot-recovery re-queues but it churns).
- Deployment type CANNOT be set programmatically — the user must pick Reserved VM
  in the Deployments/Publishing pane (the deployment skill is authoritative on
  this; do NOT try to flip `.replit` deploymentTarget to make it stick).
- **How to apply:** when shipping this feature to prod, tell the user to switch the
  deployment to Reserved VM / always-on first.

## The dev worker RUNS — do not enqueue real jobs in dev
- The worker is disabled only when `NODE_ENV==='test'` or `EXTRACTION_WORKER_DISABLED=1`.
  In normal dev it polls and will process any queued job with a REAL paid Claude
  call. Read-only GET admin endpoints are safe; hitting upload / re-run-flagged in
  dev enqueues real paid extractions.

## Contract-row gap
- The store fns ATTACH extracted data to existing `contracts` rows (matched by
  source_doc_id); the extracted payload carries no contract metadata. Python used
  to create those rows. For NEW uploads a minimal contracts row is ensured first
  (district_id, bargaining_unit, unit_scope, effective_start-from-school_year).
- A promote that resolves to ZERO target contracts is reported as needs_review,
  never as success.
