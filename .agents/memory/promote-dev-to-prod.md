---
name: Promote dev CBA data to prod
description: How the "promote when ready" feature copies curated CBA data DEV->PROD by natural key, and the key-uniqueness invariant it depends on.
---

# Promote dev CBA data to prod

CBA reference data is curated in the DEV Postgres DB, then promoted into the PROD DB on
command. Two separate DBs; serial ids are never copied — FKs are remapped by natural key.

- Export: `pipeline/20_export_promotion_bundle.py` reads dev, denormalizes each child row's
  parent natural key into the JSON bundle (`pipeline/data/promotion_bundle.json`).
- Engine: `artifacts/api-server/src/lib/promote.ts` `runPromotion(pool, bundle, {dryRun})`.
  Single txn under `pg_advisory_xact_lock`; stages rows into a TEMP clone via
  `json_populate_recordset`; null-safe match (`IS NOT DISTINCT FROM`); backs up pre-images to
  `promotion_backups`; UPDATE-if-differs + INSERT-if-absent; records `promotion_runs` on apply.
  `contract_provisions` has no natural key -> delete-by-parent-contract then reinsert.
- Route: `POST /admin/promote` (admin session OR `Bearer ADMIN_TOKEN||ADMIN_PASSWORD`),
  raw gzip body, dryRun default, `?apply=true` commits. Runner: `pipeline/21_promote_to_prod.py`.

## Key invariant (the non-obvious gotcha)
**Every promotion natural key MUST be 1:1 in BOTH the staged bundle and the target table.**
`UPDATE ... FROM` with a null-safe key multi-matches and scrambles rows if the key collides.

**Why:** the contracts DB unique index is `(district_id, bargaining_unit, unit_scope,
effective_start)`, but `effective_start` is NULL for ~100 rows, so under `IS NOT DISTINCT FROM`
that 4-col key collapses NULLs and collides (district 10726 had dup groups of 69 + 3 rows).
A 4-col match would have corrupted data on UPDATE. Fix: the promotion natural key for
contracts is a 6-tuple — add `effective_end` and `union_name` (matching-only; NO schema/index
change). Verified 0 dup groups across all keyed tables.

**How to apply:** if you change which columns form a table's promotion key (the `naturalKey`
in the SPEC in promote.ts) or add a keyed table, re-verify 0 duplicate groups via
`SELECT count(*) FROM (SELECT 1 FROM <t> GROUP BY <key cols> HAVING count(*)>1) d` on dev.
The engine also enforces this at runtime: it aborts the whole txn if any key is non-unique in
`_promo_stage` or the target. Tradeoff: because `effective_end`/`union_name` are key fields,
editing those in dev then re-promoting INSERTS a new prod contract instead of updating the old
one — acceptable for first load; revisit if frequent in-place corrections are needed.

## Never promote / skip
NEVER: users, approved_customers, conversations, messages, peer_sets.
SKIP (cache/staging/log/derived): benchmarks, alerts, cdss_staging, tracker_stats_cache,
extraction_runs, factfinding_proposals.

## Prod deploy runs `db push-force` — runtime tables MUST be in the Drizzle schema
The api-server prod run command is `pnpm --filter db push-force && exec node ...`, so every
deploy reconciles PROD to the Drizzle schema. Any table created only at runtime (the promotion
bookkeeping `promotion_runs` / `promotion_backups` were created via `CREATE TABLE IF NOT EXISTS`
in promote.ts) is "unmanaged" and a later `push-force` can drop it (losing audit/backup history)
or, under a non-TTY, error and BLOCK the deploy.
**Fix applied:** declared both tables in `lib/db/src/schema/promotions.ts`, mirroring the runtime
DDL EXACTLY (uuid PK on runs; `promotion_backups` intentionally has NO primary key to match the
already-populated prod table — adding one would force a destructive ALTER). 
**Why:** keeps push-force a no-op for them.
**How to apply:** never leave a runtime-created table out of the Drizzle schema in this repo;
and keep promotions.ts in lockstep with the CREATE TABLE DDL in promote.ts. Do NOT run
`db push`/`push-force` against DEV to "test" — it can TRUNCATE the curated source tables.

## How to promote in the future (repeatable)
First deploy must include the promote endpoint (republish if `/api/admin/promote` 404s on prod).
Auth is `Authorization: Bearer $ADMIN_TOKEN || $ADMIN_PASSWORD` (ADMIN_TOKEN is unset, so
ADMIN_PASSWORD is used; it's a shared App Secret available to the prod deployment).
- Dry-run (shows diff, writes nothing): `cd pipeline && python3 21_promote_to_prod.py --base https://app.collbar.com`
- Apply after reviewing: add `--apply`.
The runner exports a fresh dev bundle each run, gzips, POSTs. Re-running is idempotent (keyed
tables show 0 ins/upd; contract_provisions show equal delete==insert churn by design).
