import {
  pgTable,
  bigserial,
  bigint,
  text,
  date,
  numeric,
  boolean,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";
import { sourceDocumentsTable } from "./source_documents";

export const contractsTable = pgTable(
  "contracts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
    unionName: text("union_name"),
    affiliation: text("affiliation"),
    unitScope: text("unit_scope"),
    effectiveStart: date("effective_start", { mode: "string" }),
    effectiveEnd: date("effective_end", { mode: "string" }),
    termYears: numeric("term_years", { precision: 3, scale: 1 }),
    hasReopener: boolean("has_reopener"),
    reopenerTerms: text("reopener_terms"),
    sourceDocId: bigint("source_doc_id", { mode: "bigint" }).references(
      () => sourceDocumentsTable.id,
    ),
  },
  (t) => [unique().on(t.districtId, t.unitScope, t.effectiveStart)],
);

export const insertContractSchema = createInsertSchema(contractsTable).omit({
  id: true,
});
export type InsertContract = z.infer<typeof insertContractSchema>;
export type Contract = typeof contractsTable.$inferSelect;
