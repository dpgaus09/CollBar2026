import {
  pgTable,
  bigserial,
  bigint,
  text,
  char,
  varchar,
  timestamp,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";

export const sourceDocumentsTable = pgTable(
  "source_documents",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
    docType: text("doc_type"),
    sourceUrl: text("source_url").notNull(),
    fileHash: char("file_hash", { length: 64 }),
    storageKey: text("storage_key"),
    schoolYear: varchar("school_year", { length: 7 }),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique().on(t.sourceUrl, t.fileHash),
    check(
      "source_documents_doc_type_check",
      sql`${t.docType} IN ('cba_pdf','mou','factfinding_report','wage_settlement_report','cdss_extract','directory','stats')`,
    ),
  ],
);

export const insertSourceDocumentSchema = createInsertSchema(
  sourceDocumentsTable,
).omit({ id: true, retrievedAt: true });
export type InsertSourceDocument = z.infer<typeof insertSourceDocumentSchema>;
export type SourceDocument = typeof sourceDocumentsTable.$inferSelect;
