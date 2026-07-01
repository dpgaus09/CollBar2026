---
name: Replit publish dev→prod CHECK-constraint diff bug
description: Why a runtime-created table with a bare-boolean CHECK blocks the Publish flow, and the fix.
---

# Replit publish dev→prod diff mangles `CHECK (id)`

Publishing runs a **dev→prod database diff** that auto-generates migrations and
applies them to prod (separate from `runMigrations()`, which the app runs on
boot). For a table that exists in the dev DB but not prod, the diff emits a
`CREATE TABLE`, and it re-wraps the introspected constraint definition in
another `CHECK(...)`.

For a bare-boolean singleton constraint `CONSTRAINT ... CHECK (id)` this produces
the invalid `CHECK (CHECK (id))` → `syntax error at or near "CHECK"` → the
Publish step "Migrations failed validation" and the deploy is blocked.

**Why:** the failing SQL is NOT in the repo — the repo's `runMigrations()` DDL is
valid single `CHECK (id)`. The doubling happens only inside Replit's publish
generator. `CHECK (col IN (...))` constraints (firms/matters/etc.) publish fine
because those tables were already promoted to prod in earlier deploys; the bare
`CHECK (<bool col>)` form is the one that round-trips badly.

**How to apply:** don't put a bare-boolean `CHECK` on a runMigrations-only table
that will be newly diffed into prod. Drop it (`ALTER TABLE ... DROP CONSTRAINT
IF EXISTS ...` idempotently in `runMigrations()`) and let the boolean PRIMARY KEY
provide the single-row guarantee. Must also drop it from the LIVE dev DB (restart
the API server so runMigrations runs) or the diff still introspects the old
constraint. Never choose "Copy development database schema & data to production"
to escape this — it overwrites prod data.
