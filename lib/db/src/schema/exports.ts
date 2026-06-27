import {
  pgTable,
  bigserial,
  bigint,
  text,
  timestamp,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { firmsTable } from "./firms";
import { mattersTable } from "./matters";
import { usersTable } from "./users";

// ---------------------------------------------------------------------------
// Phase 5 — Work-product exports (firm workspace billable deliverables).
//
// One row per generated document (comparison memo / benchmark exhibit / clause
// appendix) rendered to PDF or DOCX. The rendered bytes live in object storage
// under `object_key`; this table is the durable index the firm uses to list and
// re-download prior exports. Firm-scoped: belongs to the firm_members /
// requireFirmSession entitlement system, NEVER the per-district CFO gate().
//
// matter_id is SET NULL (not CASCADE) and `matter_name` / `generated_by_name`
// are snapshots so a delivered, billed document is still listable and
// re-downloadable after the matter or the generating user is removed.
//
// Dual-declared: the matching idempotent DDL lives in the API server's
// runMigrations() (artifacts/api-server/src/app.ts). Keep both in sync — the
// drift guardrail (pnpm --filter @workspace/db run check-drift) compares the
// column sets of both.
// ---------------------------------------------------------------------------
export const firmExportsTable = pgTable(
  "firm_exports",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    firmId: bigint("firm_id", { mode: "bigint" })
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    matterId: bigint("matter_id", { mode: "bigint" }).references(
      () => mattersTable.id,
      { onDelete: "set null" },
    ),
    matterName: text("matter_name").notNull(),
    type: text("type").notNull(),
    format: text("format").notNull(),
    objectKey: text("object_key").notNull(),
    title: text("title").notNull(),
    bargainingUnit: text("bargaining_unit").notNull(),
    fileSize: bigint("file_size", { mode: "bigint" }).notNull(),
    generatedBy: bigint("generated_by", { mode: "bigint" }).references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    generatedByName: text("generated_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("firm_exports_object_key_unique").on(t.objectKey),
    check(
      "firm_exports_type_check",
      sql`${t.type} IN ('comparison_memo','benchmark_exhibit','clause_appendix')`,
    ),
    check("firm_exports_format_check", sql`${t.format} IN ('pdf','docx')`),
  ],
);

export type FirmExport = typeof firmExportsTable.$inferSelect;
