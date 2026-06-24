import {
  pgTable,
  bigserial,
  bigint,
  varchar,
  numeric,
  integer,
  boolean,
  text,
  timestamp,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";
import { contractsTable } from "./contracts";
import { sourceDocumentsTable } from "./source_documents";
import { BARGAINING_UNIT_SQL_LIST } from "./bargaining-units";

export const settlementsTable = pgTable(
  "settlements",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
    bargainingUnit: text("bargaining_unit").notNull().default("teachers"),
    fromYear: varchar("from_year", { length: 7 }),
    toYear: varchar("to_year", { length: 7 }),
    baseIncreasePct: numeric("base_increase_pct", { precision: 5, scale: 2 }),
    year2Pct: numeric("year2_pct", { precision: 5, scale: 2 }),
    year3Pct: numeric("year3_pct", { precision: 5, scale: 2 }),
    offSchedulePayment: numeric("off_schedule_payment", {
      precision: 10,
      scale: 2,
    }),
    insuranceChanged: boolean("insurance_changed"),
    termYears: numeric("term_years", { precision: 3, scale: 1 }),
    method: text("method"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    humanVerified: boolean("human_verified").default(false),
    // Who confirmed the figure: 'district' (the district's own administrator
    // self-verified) or 'internal' (CollBar staff). NULL when unverified.
    verifiedBy: text("verified_by"),
    // The user account that performed the most recent verification, and when.
    verifiedByUserId: bigint("verified_by_user_id", { mode: "bigint" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    notes: text("notes"),
    pageRef: integer("page_ref"),
    contractId: bigint("contract_id", { mode: "bigint" }).references(
      () => contractsTable.id,
    ),
    sourceDocId: bigint("source_doc_id", { mode: "bigint" }).references(
      () => sourceDocumentsTable.id,
    ),
  },
  (t) => [
    unique("settlements_district_unit_year_unique").on(
      t.districtId,
      t.bargainingUnit,
      t.fromYear,
      t.toYear,
    ),
    index("settlements_bargaining_unit_idx").on(t.bargainingUnit),
    check(
      "settlements_bargaining_unit_check",
      sql.raw(`bargaining_unit IN (${BARGAINING_UNIT_SQL_LIST})`),
    ),
  ],
);

export const insertSettlementSchema = createInsertSchema(settlementsTable).omit(
  { id: true },
);
export type InsertSettlement = z.infer<typeof insertSettlementSchema>;
export type Settlement = typeof settlementsTable.$inferSelect;
