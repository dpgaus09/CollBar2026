---
name: Settlement derive vs. unit reclassification conflict
description: Why backfill_contract_units must wrap each row in a SAVEPOINT or it aborts the whole settlement-derivation transaction.
---

# backfill_contract_units must use per-row SAVEPOINT

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
