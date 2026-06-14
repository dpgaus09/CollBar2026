import {
  pgTable,
  bigserial,
  bigint,
  text,
  timestamp,
  boolean,
  numeric,
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
  // OCR provenance: whether the document's text came from OCR (scanned /
  // image-only PDF) rather than an embedded text layer.
  usedOcr: boolean("used_ocr").notNull().default(false),
  // Mean tesseract word confidence (0-100) over recognized words on OCR'd docs.
  // NULL for non-OCR docs or when no words were recognized.
  ocrConfidence: numeric("ocr_confidence", { precision: 5, scale: 2 }),
  // True when an OCR'd document's quality is below OCR_MIN_CONFIDENCE and the
  // extracted text should be treated as low-trust (flagged for human review).
  ocrLowQuality: boolean("ocr_low_quality").notNull().default(false),
});

export const insertExtractionRunSchema = createInsertSchema(
  extractionRunsTable,
).omit({ id: true, runAt: true });
export type InsertExtractionRun = z.infer<typeof insertExtractionRunSchema>;
export type ExtractionRun = typeof extractionRunsTable.$inferSelect;
