---
name: extraction_runs is append-per-attempt
description: How to compute true/current extraction status from the extraction_runs table without overcounting retries.
---

`extraction_runs` stores ONE row per extraction attempt, not one row per document. A
single CBA PDF is retried across nightly runs, so it can have many `failed` rows and
later a `success` row. Example observed: 663 rows / 183 distinct docs; raw
`COUNT(*) WHERE status='failed'` = 460, but only **2** documents are actually failing
right now.

**Rule:** any metric about a *document's* current extraction status must collapse to the
latest run per doc first:
`SELECT DISTINCT ON (source_doc_id) ... FROM extraction_runs ORDER BY source_doc_id, run_at DESC, id DESC`.
Never aggregate `status` over all rows — it counts stale retry history.

**Why:** raw status counts conflate retry history with current state and wildly
overstate failures (460 vs 2). The admin "Extraction Failures" panel and the
`processedDocs`/success-coverage metric both rely on de-duped latest-per-doc counts.

**How to apply:** when adding any extraction reporting (counts, coverage %, failure
reasons) in `admin.ts`, use the latest-per-doc CTE. The existing success-coverage code
already de-dupes via `COUNT(DISTINCT source_doc_id) WHERE status='success'`; match that
intent. Include `id DESC` in the ordering as a deterministic tie-break for same-timestamp runs.
