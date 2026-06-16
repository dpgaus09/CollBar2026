---
name: derive_settlements per-row SAVEPOINT
description: Every per-row DB write inside derive_settlements (unit reclassification AND settlement INSERTs) must use a SAVEPOINT or one bad row aborts the whole transaction and rolls back all derived settlements.
---

# Every per-row write in derive_settlements must use a SAVEPOINT

**Rule:** in `derive_settlements` / `backfill_contract_units`
(`pipeline/06_extract_contracts.py`), EVERY per-row DB write must be wrapped in
its own SAVEPOINT with ROLLBACK TO on error, then continue. This covers two
distinct failure modes seen in production:

1. **Unit reclassification UPDATEs** — `UniqueViolation` against
   `contracts_district_bargaining_unit_scope_start_unique`.
2. **Settlement INSERTs (both `stated` and `ba_min_delta` passes)** — a single
   `numeric field overflow` when an LLM-misread `base_increase_pct` exceeds
   `numeric(5,2)` range (≥1000). A plain try/except that logs a WARNING is NOT
   enough: the failed statement leaves the transaction aborted, so every later
   `cur.execute` raises `InFailedSqlTransaction`, the function crashes, and the
   final `conn.commit()` never runs — silently rolling back ALL otherwise-good
   settlements (observed as batch districts showing 0 `stated` rows).

**Rule:** any loop that UPDATEs `contracts.bargaining_unit` (reclassifying units
during `derive_settlements` / `backfill_contract_units` in
`pipeline/06_extract_contracts.py`) must wrap each row in its own SAVEPOINT and
ROLLBACK TO that savepoint on `psycopg2.errors.UniqueViolation`, then continue.

**Why:** reclassifying a contract's unit can collide with the existing
`contracts_district_bargaining_unit_scope_start_unique` constraint when another
contract for the same district/unit/scope/start already exists. In PostgreSQL a
constraint violation aborts the *entire* transaction, so without a per-row
savepoint a single conflict kills the whole derive run (observed as the
`derive_settlements` crash). The fix is not to drop the constraint — duplicates
should be skipped, not merged blindly.

**How to apply:** `import psycopg2` locally, `SAVEPOINT bf_unit` before each
UPDATE, `ROLLBACK TO SAVEPOINT bf_unit` on UniqueViolation, count and log
`skipped_conflict`. Validate with `06_extract_contracts.py --derive-only` (should
report settlements with no crash).
