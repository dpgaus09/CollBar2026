---
name: Drizzle schema sync rule
description: Any raw SQL migration must also update the Drizzle TS schema file and run pnpm --filter @workspace/db run push.
---

# Rule
When adding columns via raw SQL (psql or migration file), ALSO update the corresponding table file in `lib/db/src/schema/*.ts` and run `pnpm --filter @workspace/db run push` to sync.

**Why:** `pipeline/tests/test_schema.py::TestSchema::test_drizzle_schema_matches_db` runs drizzle-kit push and asserts "No changes detected". If the TS schema is out of sync with the DB, this test fails even if the DB is correct.

**How to apply:** After any raw ALTER TABLE, update the pgTable() definition in the matching `lib/db/src/schema/*.ts` file (add columns + any CHECK constraints), then push. The push will confirm "No changes detected" once in sync.

Note: `pnpm --filter @workspace/db run build` is not defined; just run push directly.
