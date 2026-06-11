---
name: Drizzle schema sync with raw ALTER TABLE
description: Any column added via raw SQL ALTER TABLE must be added to the .ts schema file before the next drizzle-kit push, or Drizzle will try to drop the column as a data-loss change.
---

# Drizzle schema sync with raw ALTER TABLE

**Rule:** Every column in the live DB must have a matching definition in `lib/db/src/schema/<table>.ts`. If a column was added via raw `ALTER TABLE` (e.g. in a pipeline migration or REPL session), it must be backfilled into the Drizzle schema file before the next `pnpm --filter @workspace/db run push`, or Drizzle will detect the column as "extra" and stage a destructive drop.

**Why:** Drizzle-kit compares the schema files against the live DB and emits DDL to make them match — in both directions. A column that exists only in the DB looks like user-added noise that needs removing.

**How to apply:**
- When a raw `ALTER TABLE … ADD COLUMN` is run outside Drizzle, immediately add the matching column definition to the `.ts` schema file.
- The `drizzle-kit push` dry-run will list planned changes; review them before accepting.
- Affected tables in this project (Phase 4/5): `settlements` (added `page_ref`), `factfinding_proposals` (added `page_ref`, `human_verified`, `confidence`).
