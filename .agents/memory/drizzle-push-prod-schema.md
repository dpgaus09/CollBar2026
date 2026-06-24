---
name: Dev schema apply + prod publish flow (Drizzle)
description: How to add columns to the dev DB without triggering an unrelated destructive push, and how schema reaches prod.
---

**Prod schema rule:** never DDL the production DB directly (it is read-only via the
tools). Schema reaches prod only through Replit's **Publish** flow, which diffs the
dev DB against prod and applies additive/backward-compatible changes. So: make the
change in the Drizzle schema (source of truth), apply it to the **dev** DB, verify,
then tell the user to **re-publish**.

**Push gotcha (this repo):** `pnpm --filter @workspace/db run push` is NOT safe to
run blindly — it wants to DROP tables Drizzle doesn't manage and prompts to
**truncate the contracts table** to re-add its already-present unique key. The
`push-force` script is now **neutered** (exits 1). To verify the schema matches
the DB use the read-only `pnpm --filter @workspace/db run check-drift` instead.
See `drizzle-push-unique-constraints.md` for the full hybrid-management story.

**How to apply (additive columns):** for a targeted additive change, skip push and
run a surgical `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` against the dev DB only.
The publish flow introspects the live dev DB schema, so the new columns still
propagate to prod on re-publish. Example that bit us: `extraction_runs` was missing
`used_ocr` / `ocr_confidence` / `ocr_low_quality` (defined in the Drizzle schema but
never pushed), crashing `06_extract_contracts.py` with `UndefinedColumn`.
