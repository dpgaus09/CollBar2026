import {
  pgTable,
  bigserial,
  bigint,
  varchar,
  numeric,
  boolean,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";

export const settlementsTable = pgTable(
  "settlements",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
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
    notes: text("notes"),
  },
  (t) => [unique().on(t.districtId, t.fromYear, t.toYear)],
);

export const insertSettlementSchema = createInsertSchema(settlementsTable).omit(
  { id: true },
);
export type InsertSettlement = z.infer<typeof insertSettlementSchema>;
export type Settlement = typeof settlementsTable.$inferSelect;
