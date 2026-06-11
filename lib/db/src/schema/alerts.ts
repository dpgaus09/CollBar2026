import {
  pgTable,
  bigserial,
  bigint,
  text,
  char,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { districtsTable } from "./districts";
import { sourceDocumentsTable } from "./source_documents";

export const alertsTable = pgTable(
  "alerts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    sourceDocId: bigint("source_doc_id", { mode: "bigint" }).references(
      () => sourceDocumentsTable.id,
    ),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
    alertType: text("alert_type").notNull(),
    docName: text("doc_name"),
    sourceUrl: text("source_url"),
    fileHash: char("file_hash", { length: 64 }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow(),
    status: text("status").notNull().default("pending"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
    notes: text("notes"),
  },
  (t) => [
    check(
      "alerts_alert_type_check",
      sql`${t.alertType} IN ('new_doc', 'changed_doc', 'new_settlement')`,
    ),
    check(
      "alerts_status_check",
      sql`${t.status} IN ('pending', 'acknowledged')`,
    ),
  ],
);

export type Alert = typeof alertsTable.$inferSelect;
