import {
  pgTable,
  bigserial,
  bigint,
  text,
  date,
  numeric,
  boolean,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";
import { sourceDocumentsTable } from "./source_documents";
import { BARGAINING_UNIT_SQL_LIST } from "./bargaining-units";

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
    bargainingUnit: text("bargaining_unit").notNull().default("teachers"),
    // True when an admin manually corrected the bargaining unit. Pins the value
    // so the pipeline's auto-classifier (backfill_contract_units) won't revert
    // it back to the text-derived guess. Additive column applied via the API
    // server runMigrations() — see artifacts/api-server/src/app.ts.
    unitOverride: boolean("unit_override").notNull().default(false),
    effectiveStart: date("effective_start", { mode: "string" }),
    effectiveEnd: date("effective_end", { mode: "string" }),
    termYears: numeric("term_years", { precision: 3, scale: 1 }),
    hasReopener: boolean("has_reopener"),
    reopenerTerms: text("reopener_terms"),
    sourceDocId: bigint("source_doc_id", { mode: "bigint" }).references(
      () => sourceDocumentsTable.id,
    ),
  },
  (t) => [
    unique("contracts_district_bargaining_unit_scope_start_unique").on(
      t.districtId,
      t.bargainingUnit,
      t.unitScope,
      t.effectiveStart,
    ),
    index("contracts_district_unit_idx").on(t.districtId, t.bargainingUnit),
    check(
      "contracts_bargaining_unit_check",
      sql.raw(`bargaining_unit IN (${BARGAINING_UNIT_SQL_LIST})`),
    ),
  ],
);

export const insertContractSchema = createInsertSchema(contractsTable).omit({
  id: true,
});
export type InsertContract = z.infer<typeof insertContractSchema>;
export type Contract = typeof contractsTable.$inferSelect;
