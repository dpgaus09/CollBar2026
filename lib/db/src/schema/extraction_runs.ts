import {
  pgTable,
  bigserial,
  bigint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sourceDocumentsTable } from "./source_documents";

export const extractionRunsTable = pgTable("extraction_runs", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  sourceDocId: bigint("source_doc_id", { mode: "bigint" }).references(
    () => sourceDocumentsTable.id,
  ),
  model: text("model"),
  promptVersion: text("prompt_version"),
  runAt: timestamp("run_at", { withTimezone: true }).defaultNow(),
  status: text("status").default("pending"),
  error: text("error"),
});

export const insertExtractionRunSchema = createInsertSchema(
  extractionRunsTable,
).omit({ id: true, runAt: true });
export type InsertExtractionRun = z.infer<typeof insertExtractionRunSchema>;
export type ExtractionRun = typeof extractionRunsTable.$inferSelect;
