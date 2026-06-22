import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

// Audit + rollback bookkeeping for the dev -> prod data promotion (see
// artifacts/api-server/src/lib/promote.ts). The promotion engine creates these
// tables at runtime with `CREATE TABLE IF NOT EXISTS`; they are declared here so
// the production deploy's `drizzle-kit push-force` treats them as managed and
// in-sync, and never drops them between promotions. Keep these definitions in
// lockstep with the runtime DDL in promote.ts or push could try to alter them.

// One row per promotion attempt (dry-run or applied), with the full per-table summary.
export const promotionRunsTable = pgTable("promotion_runs", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  dryRun: boolean("dry_run").notNull(),
  summary: jsonb("summary"),
});

// Pre-image snapshot of every row an applied promotion mutates, for rollback.
export const promotionBackupsTable = pgTable("promotion_backups", {
  runId: uuid("run_id").notNull(),
  tableName: text("table_name").notNull(),
  op: text("op").notNull(),
  rowData: jsonb("row_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PromotionRun = typeof promotionRunsTable.$inferSelect;
export type PromotionBackup = typeof promotionBackupsTable.$inferSelect;
