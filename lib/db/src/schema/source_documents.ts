import {
  pgTable,
  bigserial,
  bigint,
  text,
  char,
  varchar,
  timestamp,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";
import { BARGAINING_UNIT_SQL_LIST } from "./bargaining-units";

export const sourceDocumentsTable = pgTable(
  "source_documents",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
    docType: text("doc_type"),
    bargainingUnit: text("bargaining_unit").notNull().default("teachers"),
    sourceUrl: text("source_url").notNull(),
    fileHash: char("file_hash", { length: 64 }),
    storageKey: text("storage_key"),
    schoolYear: varchar("school_year", { length: 7 }),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique().on(t.sourceUrl, t.fileHash),
    unique("source_documents_district_unit_hash_unique").on(
      t.districtId,
      t.bargainingUnit,
      t.fileHash,
    ),
    index("source_documents_district_unit_idx").on(
      t.districtId,
      t.bargainingUnit,
    ),
    check(
      "source_documents_doc_type_check",
      sql`${t.docType} IN ('cba_pdf','mou','factfinding_report','wage_settlement_report','cdss_extract','directory','stats')`,
    ),
    check(
      "source_documents_bargaining_unit_check",
      sql.raw(`bargaining_unit IN (${BARGAINING_UNIT_SQL_LIST})`),
    ),
  ],
);

export const insertSourceDocumentSchema = createInsertSchema(
  sourceDocumentsTable,
).omit({ id: true, retrievedAt: true });
export type InsertSourceDocument = z.infer<typeof insertSourceDocumentSchema>;
export type SourceDocument = typeof sourceDocumentsTable.$inferSelect;
