---
name: Extraction-engine domain CHECK constraints drift
description: Adding a new VersionDomain requires widening 3 DB CHECK constraints in lockstep; live constraints were narrower than the code's domain type.
---

# Extraction-engine domain CHECK constraints

The versioned extraction engine has three tables guarded by a `domain` CHECK
constraint: `extraction_jobs`, `extraction_versions`, `extraction_promotions`
(constraints `extraction_*_domain_check`).

**The trap:** the live DB CHECKs drift behind the code's `VersionDomain` union.
When a new domain was added, the live dev+prod constraints still only allowed
`salary` + `provisions` (and `cba` on the `jobs` table only) — they were already
missing `settlement` and `final_offer` even though those domains shipped. A new
domain insert fails at runtime with Postgres `23514` (check_violation), not at
typecheck/build.

**The rule:** adding any new `VersionDomain` requires, in lockstep:
1. Widen ALL THREE CHECKs (`jobs` keeps the extra `cba` orchestration value;
   `versions`/`promotions` take the real domain set only) via an idempotent
   `ALTER ... DROP CONSTRAINT IF EXISTS ... ; ADD CONSTRAINT ... CHECK (...)`
   inside `app.ts` `runMigrations` — runs on every boot, applies to dev on
   workflow restart and to prod on publish.
2. Update the `CREATE TABLE` defs in the same file so fresh DBs match.

**Why:** the `VersionDomain` TS type is not enforced by the DB; the CHECK is the
only DB-level guard, and it had silently fallen behind. Tests that hit the real
dev DB (e.g. `promote-e2e.test.ts`) fail with `23514` until the dev constraint is
widened — restart the API Server workflow (runs the migration) before re-running
the suite.

**How to apply:** any time you extend `VersionDomain`, grep for
`_domain_check` in `app.ts`, add the value to all three ALTERs + CREATE defs,
restart the API Server workflow, then verify with
`SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname LIKE 'extraction_%domain_check'`.
