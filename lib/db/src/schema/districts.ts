import {
  pgTable,
  bigserial,
  char,
  text,
  integer,
  numeric,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const districtsTable = pgTable(
  "districts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    state: char("state", { length: 2 }).notNull().default("OH"),
    stateDistrictId: text("state_district_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug"),
    county: text("county"),
    districtType: text("district_type"),
    enrollment: integer("enrollment"),
    valuation: numeric("valuation", { precision: 15, scale: 2 }),
    avgTeacherSalary: numeric("avg_teacher_salary", { precision: 10, scale: 2 }),
    websiteUrl: text("website_url"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [unique().on(t.state, t.stateDistrictId)],
);

export const insertDistrictSchema = createInsertSchema(districtsTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertDistrict = z.infer<typeof insertDistrictSchema>;
export type District = typeof districtsTable.$inferSelect;
