---
name: drizzle-kit push-force breaks on unique constraints over populated tables
description: Why post-merge push-force fails for any UNIQUE constraint on a table with rows, and how to apply such constraints safely.
---

# drizzle-kit push-force + unique constraints on populated tables

`pnpm --filter db push-force` (drizzle-kit 0.31.10, run by `scripts/post-merge.sh`)
**cannot** be relied on to apply or re-detect a UNIQUE constraint on a table that
already has rows.

Two compounding problems observed:
1. drizzle-kit 0.31.10 does **not** detect existing explicit-named *composite*
   unique CONSTRAINTS during `push` introspection, so every run it wants to
   re-`ADD` them.
2. Adding a unique constraint to a non-empty table triggers an interactive
   "Do you want to truncate <table>?" prompt. `--force` does **not** auto-confirm
   *this specific* prompt — under closed stdin (CI / post-merge) it errors with
   "Interactive prompts require a TTY terminal" and exits non-zero.

**Why this matters / data-safety:** `--force` is documented as "auto-approve all
data loss statements … may truncate your tables." If push-force were ever given a
TTY here, it would answer the prompt and **TRUNCATE the table** (delete all rows).
So the post-merge erroring out is actually the *data-safe* failure mode. Never feed
push-force a pseudo-tty (e.g. `script`) to "get past" the prompt — it will wipe data.

**Scope:** pre-existing, not specific to one table. Verified to fire on every
populated table that got a unique key this way: `settlements` (~7.3k rows),
`source_documents` (~180 rows) from migration 0008, and `contracts` from 0009.

**How to apply a unique constraint change here (the working pattern):**
- Apply it to the dev DB directly via raw SQL (`DROP CONSTRAINT IF EXISTS old;
  ADD CONSTRAINT new UNIQUE (...)`). Adding a column to an existing unique key is
  strictly more permissive, so the ADD can never fail on duplicates.
- Update the Drizzle schema (`lib/db/src/schema/*.ts`) with an explicit-named
  `unique("...")` matching the DB, plus a hand-written `db/migrations/NNNN_*.sql`
  and a `meta/_journal.json` entry, for documentation / fresh-DB provisioning.
- Expect the post-merge `push-force` step to FAIL on these tables. That failure is
  pre-existing and is a migration-tooling gap, not a defect in the constraint change.

**Open follow-up (affects production deploys & "keep pipeline running" work):** the
post-merge / production migration path should stop using `push-force` for unique
constraints — options: apply the hand-written SQL migrations via `drizzle-orm`
`migrate()` (needs a `__drizzle_migrations` bootstrap), switch these constraints to
`uniqueIndex` if push detects indexes more reliably, or upgrade drizzle-kit.
