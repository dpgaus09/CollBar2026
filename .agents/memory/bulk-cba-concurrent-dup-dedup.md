---
name: Bulk-CBA in-batch concurrent duplicate dedup
description: Behavior + pitfalls when identical-content entries share one /admin/bulk-cba/ingest batch under concurrency, and how to test that suite reliably
---

## Behavior
When one bulk-ingest batch contains the same contract bytes twice (identical sha256, different Drive IDs, same unit) and mapLimit processes them concurrently, they collapse to exactly ONE source doc and ONE active job — enforced at the DB layer by unique indexes, not by app logic. Trust the DB uniqueness, not request ordering.

## Pitfall 1 — the concurrent loser is reported "failed", not "duplicate"
The ingest catch classifies a duplicate by matching the error MESSAGE (`/unique|duplicate/i`). Under true co-flight the pg driver surfaces the unique violation as a generic "Failed query: ..." string with no such token, so the loser is misreported "failed". Data integrity is fine; only the status is wrong.
**How to apply:** classify unique violations by SQLSTATE `23505`, not by message text.

## Pitfall 2 — latent contract double-insert (only after fixing #1)
The upload-path contract upsert dedups via an `ON CONFLICT` whose target includes a column that is NULL (`unit_scope`). Under `IS NOT DISTINCT FROM`, two NULL-scope rows can both insert, so the conflict never fires for concurrent same-doc inserts. Today this is masked because the loser fails before reaching contract creation; fixing Pitfall 1 unmasks it.
**How to apply:** make the contract insert race-safe (coalesced/non-NULL conflict key or a real partial unique index) in lockstep with the Pitfall 1 fix.

## Testing this suite (`admin-bulk-cba-ingest.test.ts`)
- The extraction worker does not run under `NODE_ENV=test`, so active-job counts are deterministic (no async drain).
- Assert PER-HASH counts, not district-wide before/after totals: sibling concurrent-group tests leak async writes into the shared throwaway district, making global deltas racy. Per-hash counts key on a fresh unique hash and are contamination-proof.
- The sibling concurrent-group tests ("one bad file does not block the rest", "a bad file mid-batch can't poison the concurrent group") are PRE-EXISTING flaky — they fail intermittently even with the dup test skipped.
