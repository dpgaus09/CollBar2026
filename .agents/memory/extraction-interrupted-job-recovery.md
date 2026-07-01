---
name: Interrupted extraction-job recovery
description: Why deploys/restarts falsely fail in-flight Vision jobs and the refund+recovery_count fix (not a max_attempts bump).
---

# Interrupted extraction-job recovery

Single-concurrency extraction queue. `enqueueJob` defaults `maxAttempts=1`;
`claimNextJob` does `attempts = attempts+1` at claim time; the worker runs
`recoverStaleJobs()` at startup (after EVERY deploy/restart). A Vision job takes
~5 min, far longer than the graceful-shutdown grace window, so any restart leaves
an in-flight row in `status='running'` — and the old logic failed it once
`attempts >= max_attempts`. Result: a big bulk import produces dozens of jobs
falsely `failed` with `error='recovered from interrupted run'`.

## The rule
Do NOT bump `max_attempts` to survive restarts. That would also let GENUINE
content/logic failures retry and burn paid Vision calls on deterministically
broken docs.

Instead, treat a restart as a non-attempt:
- `recoverStaleJobs` REFUNDS the claim-time increment (`attempts = GREATEST(attempts-1,0)`),
  increments a separate `recovery_count`, and RE-QUEUES the row (clearing
  error/leased_at/started_at/finished_at) while `recovery_count <= MAX_RECOVERIES`
  (10); past the cap it fails with `'exceeded interrupted-run recovery limit'` so a
  process-crash-looping poison doc can't wedge the single worker forever.

**Why:** the attempt budget must count real processing attempts, not platform
interruptions; the cap keeps the refund from becoming an infinite loop.

## Constraints that bite
- `recovery_count` is a non-Drizzle operational column: added via runtime DDL in
  app.ts (CREATE + idempotent `ALTER ... ADD COLUMN IF NOT EXISTS`). app.ts
  migrations run un-awaited (setImmediate), so the worker must call
  `ensureQueueRecoverySchema()` BEFORE `recoverStaleJobs()` or it references a
  missing column on a cold boot.
- `recoverStaleJobs` is a GLOBAL update on all `running` rows with no age/lease
  threshold. Correct ONLY under the single always-on Reserved VM model (any
  `running` row at boot is necessarily orphaned). Would need lease ownership /
  heartbeat / age gate before it is safe under overlapping rolling deploys or
  multiple app instances.

## Backlog recovery (already-failed rows)
Admin endpoint `POST /admin/extraction/requeue-interrupted` (logic in
`requeueInterruptedJobs()` in queue.ts) recovers the historical backlog: re-queues
at most ONE failed row per `source_doc_id` (row_number rn=1), only when no active
(queued|running) job exists for that doc (respects `extraction_jobs_active_doc_uniq`),
matching `error='recovered from interrupted run' OR error LIKE 'Failed query:%'`
(transient DB read failures — cache/versions/contracts SELECTs — also produced no
output and are safe to retry). Genuine descriptive content failures are left
`failed`. This must be run in PROD after deploy (dev has no real backlog).

**Note:** `LIKE 'Failed query:%'` is broader than "transient read" semantically; a
future deterministic DB bug would also match (it would just re-fail, no corruption).
Narrow to observed signatures if this button becomes permanent.
