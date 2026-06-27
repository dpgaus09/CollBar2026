---
name: Bulk CBA import (Drive → prod)
description: Non-obvious invariants for the admin "Bulk CBA Import" feature that loads a Drive folder of district CBA PDFs into prod and enqueues extraction.
---

Admin-driven bulk loader: point at a Google Drive folder (PDFs + a mapping CSV/Sheet),
dry-run preview the row→file match, then ingest in client-batched POSTs; the Reserved-VM
worker drains the `cba` extraction queue one doc at a time. Ledger table `bulk_cba_imports`
keyed `(run_id, drive_file_id)`.

**Dev paid-job safety (hard rule).** Real Claude extraction jobs cost money and the
in-process/Reserved-VM worker runs them. ALL enqueue paths must be gated by one helper
(prod OR an explicit `BULK_IMPORT_ALLOW_DEV_ENQUEUE=1` override). Both ingest and retry
go through it; preview and ingest themselves write/enqueue nothing extra in dev.
**Why:** an un-gated enqueue in dev silently burns API budget.
**How to apply:** any new bulk path that could create extraction jobs must call the same
gate, never inline a `NODE_ENV` check that drifts.

**Object Storage must be written for BOTH new AND duplicate source-doc paths.** Prod fs is
ephemeral and `resolvePdfBuffer` reads `il_cba/<hash>.pdf` by hash FIRST. A content-dedup
hit (`source_documents` by `(district_id, bargaining_unit, file_hash)`) may point at a row
created by an older local-only path with no object — marking it `duplicate` and enqueuing
then yields "Document file missing" in prod. Upload the downloaded bytes (idempotent by
key) before branching on existing-vs-new, fail-closed if the upload fails.

**Progress/retry job SQL must scope `extraction_jobs` to `domain = 'cba'`.** One
`source_doc_id` can carry jobs of other domains (salary, provisions, etc.). Without the
filter, a non-cba done/active job distorts the progress rollup and the retry `NOT EXISTS`
guard can wrongly block a needed CBA re-enqueue. `extraction_runs` has NO domain column, so
its success check stays per-doc (acceptable: a successful cba run is what we want anyway).

**Resumability.** Same-run resume keys on the ledger `(run_id, drive_file_id)` + Drive md5;
a new runId relies on `source_documents` content dedup + `enqueueJob` active-job dedup. Any
failure AFTER the source doc is created records a `failed` ledger row that still carries the
`source_doc_id`, so a re-run self-heals (content-dedup → duplicate → re-drive) instead of
losing the row.
