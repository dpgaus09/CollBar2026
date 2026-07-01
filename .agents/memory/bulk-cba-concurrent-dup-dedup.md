---
name: Bulk-CBA in-batch concurrent duplicate dedup
description: Behavior + pitfalls when identical-content entries share one /admin/bulk-cba/ingest batch under concurrency, and how to test that suite reliably
---

## Behavior
When one bulk-ingest batch contains the same contract bytes twice (identical sha256, different Drive IDs, same unit) and mapLimit processes them concurrently, they collapse to exactly ONE source doc and ONE active job — enforced at the DB layer by unique indexes, not by app logic. Trust the DB uniqueness, not request ordering.

## Pitfall 1 — the concurrent loser is reported "failed", not "duplicate" (FIXED)
The ingest catch classifies a duplicate by matching the error MESSAGE (`/unique|duplicate/i`). Under true co-flight the pg driver surfaces the unique violation as a generic "Failed query: ..." string with no such token, so the loser is misreported "failed".
**How to apply:** classify unique violations by SQLSTATE `23505`. The wrapped-drizzle error puts pg fields (`code`/`constraint`) on the `.cause` chain, not the top-level error — walk the chain (helpers `pgErrorInfo`/`isUniqueViolation` in `admin.ts`). Message-sniffing alone is insufficient under co-flight.

## Pitfall 2 — latent contract double-insert, unmasked by fixing #1 (FIXED)
The upload-path contract upsert dedups via an `ON CONFLICT (district_id, bargaining_unit, unit_scope, effective_start)` whose target column `unit_scope` is NULL for uploads. Postgres treats NULLs as DISTINCT in a plain unique index, so two concurrent same-doc inserts both succeed → two contracts for one doc. Was masked while the loser failed before reaching contract creation; fixing Pitfall 1 lets the loser reach it and unmasks the race.
**How to apply:** `ensureContractForUpload` now serialises the SELECT+INSERT per source doc with `pg_advisory_xact_lock(ns, sourceDocId)` inside a `db.transaction`, so the second caller sees the first's row. Don't try to fix this with `ON CONFLICT` alone — the NULL column defeats it.

## Testing this suite (`admin-bulk-cba-ingest.test.ts`)
- The extraction worker does not run under `NODE_ENV=test`, so active-job counts are deterministic (no async drain).
- Assert PER-HASH counts, not district-wide before/after totals: sibling concurrent-group tests leak async writes into the shared throwaway district, making global deltas racy. Per-hash counts key on a fresh unique hash and are contamination-proof.
- The sibling concurrent-group tests ("one bad file does not block the rest", "a bad file mid-batch can't poison the concurrent group") are PRE-EXISTING flaky — they fail intermittently even with the dup test skipped.
