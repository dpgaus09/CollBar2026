---
name: Bulk-CBA in-batch concurrent duplicate dedup
description: How identical-content entries in one /admin/bulk-cba/ingest batch behave under mapLimit co-flight, plus test-writing caveats for that suite
---

- Two entries in ONE `/admin/bulk-cba/ingest` batch with identical bytes (same sha256), different driveFileId, same unit, processed concurrently under mapLimit, dedup at the DB layer: `source_documents` unique `(district_id, bargaining_unit, file_hash)` collapses to ONE doc; `enqueueJob` `ON CONFLICT (source_doc_id) WHERE status IN ('queued','running')` collapses to ONE job.
- CURRENT loser status is `"failed"`, NOT `"duplicate"`: under true co-flight the pg driver wraps the unique violation as a generic `"Failed query: ..."` string with no unique/duplicate token, so admin.ts's `/unique|duplicate/i` catch misses it and returns `fail()`. Data integrity is unaffected. Reporting it cleanly as `"duplicate"` is a known follow-up.
- Latent contract race: `ensureContractForUpload`'s `ON CONFLICT` target is `(district, unit, unit_scope, effective_start)` but `unit_scope` is NULL, so `IS NOT DISTINCT FROM` does NOT dedup concurrent same-doc inserts. Only exposed IF the loser ever proceeds past `source_documents` (it doesn't today because it fails first). Fixing the loser→"duplicate" status would expose this.

**Why:** these are non-obvious runtime/driver behaviors invisible from reading the happy path; the two bugs are causally linked (fix #1 → must also fix #2).

**Test caveats (`admin-bulk-cba-ingest.test.ts`):**
- The extraction worker is OFF under `NODE_ENV=test` (worker.ts isEnabled guard), so active-job counts are deterministic in tests (no async drain).
- District-WIDE aggregate counts (`districtCounts()` before/after) are RACY: sibling concurrent-group tests can leak async writes into the shared throwaway district. Assert PER-HASH counts (`docCountForHash`/`contractCountForHash`/`activeJobCountForHash`) instead — they key on a unique fresh hash and are contamination-proof.
- The sibling concurrent-group tests ("one bad file does not block the rest", "a bad file mid-batch can't poison the concurrent group") are PRE-EXISTING flaky — they fail intermittently even with the in-batch dup test skipped. Not caused by the dup test.
