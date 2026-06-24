---
name: Schema apply + drift guardrail (hybrid-managed DB)
description: Why drizzle-kit push/push-force are unusable on this DB, how schema actually reaches the DB, and how drift is now verified.
---

# Schema apply + drift guardrail

This database is **hybrid-managed**, NOT owned end-to-end by Drizzle:
- versioned migration files in `db/migrations` (for fresh-DB provisioning), plus
- idempotent `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` ALTERs in
  the API server's `runMigrations()` (`artifacts/api-server/src/app.ts`), run on
  every API server boot, plus
- several tables that intentionally exist in the DB with **no Drizzle
  declaration**: `login_events`, `sync_run_status`, `directory_refresh_log`,
  `il_district_fte`, `il_eis_district`, `tss_annual`, and the Python pipeline's
  tables.

**Consequence:** `drizzle-kit push` ALWAYS wants to DROP the non-Drizzle tables,
so it can never report "No changes detected"; `push --force` would silently DROP
them AND tries to TRUNCATE the populated `contracts` table to (re)apply its
already-present composite unique key. push introspection is also slow and can
hang under concurrent pipeline DB load.

**Why this matters:** a red "schema drift" test, a hanging/failed post-merge, and
a truncate landmine were all inevitable side-effects of pointing push/push-force
at a DB it doesn't fully own. The fix is to stop using push as a guardrail/apply
tool, not to fight it.

**How to apply / verify schema now:**
- Additive schema changes: declare in `lib/db/src/schema/*.ts` AND add the
  idempotent ALTER to `runMigrations()`. The change reaches the dev DB when the
  API server restarts (post-merge reconciliation restarts running workflows), and
  reaches prod via the Publish flow (prod is **autoscale**; its postBuild only
  runs `pnpm store prune` — it does NOT run push-force; the old promotions.ts
  comment claiming otherwise was stale).
- `push-force` is **neutered** in `lib/db/package.json` (the script now prints a
  refusal and exits 1). Interactive `push` is kept for human investigation only.
- Verify schema/DB sync with `pnpm --filter @workspace/db run check-drift`
  (`lib/db/scripts/check-drift.ts`): read-only, issues NO DDL, compares declared
  columns vs `information_schema.columns` in BOTH directions, scoped to the
  ~24 Drizzle-owned tables. `pipeline/tests/test_schema.py` runs it as a test.
- check-drift deliberately checks **column presence only** (not types/nullability/
  defaults/indexes) to avoid false positives from drizzle→pg type mapping. The
  one constraint that bit us — the `contracts` composite unique key
  `(district_id, bargaining_unit, unit_scope, effective_start)`, **NULLS
  DISTINCT** — is guarded by a dedicated test (`pg_constraint` joined to
  `pg_index.indnullsnotdistinct`; note `pg_constraint` has no nulls-distinct
  column in PG16, it lives on the backing index).
