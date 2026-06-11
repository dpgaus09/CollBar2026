import {
  pgTable,
  bigserial,
  bigint,
  integer,
  text,
  date,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";

export const benchmarksTable = pgTable("benchmarks", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  districtId: bigint("district_id", { mode: "bigint" }).references(
    () => districtsTable.id,
  ),
  docYear: integer("doc_year"),
  sourceUrl: text("source_url"),
  rawText: text("raw_text"),
  effectiveDate: date("effective_date", { mode: "string" }),
  expiryDate: date("expiry_date", { mode: "string" }),
  wageSchedule: jsonb("wage_schedule"),
  parsedAt: timestamp("parsed_at", { withTimezone: true }).defaultNow(),
});

export const insertBenchmarkSchema = createInsertSchema(benchmarksTable).omit({
  id: true,
  parsedAt: true,
});
export type InsertBenchmark = z.infer<typeof insertBenchmarkSchema>;
export type Benchmark = typeof benchmarksTable.$inferSelect;
