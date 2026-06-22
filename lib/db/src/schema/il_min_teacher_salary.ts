import {
  pgTable,
  bigserial,
  text,
  integer,
  numeric,
  date,
  timestamp,
} from "drizzle-orm/pg-core";

// Illinois statutory minimum full-time teacher salary, certified annually by the
// Commission on Government Forecasting and Accountability (CGFA) under PA 103-515
// (amends Section 24-8 of the School Code). One row per certification, keyed by
// the school year the rate takes effect (e.g. "2026-2027"). State-level reference
// data — not tied to any district.
export const ilMinTeacherSalaryTable = pgTable("il_min_teacher_salary", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  // School year the certified rate is effective for, e.g. "2026-2027". Unique key.
  schoolYear: text("school_year").notNull().unique(),
  // Prior school year the increase is measured from, e.g. "2025-2026".
  priorYear: text("prior_year"),
  // Minimum rate for the prior school year (whole dollars).
  priorYearRate: integer("prior_year_rate"),
  // Applicable CPI-based percentage increase (not less than 0), e.g. 2.67.
  percentageIncrease: numeric("percentage_increase", { precision: 6, scale: 3 }),
  // Certified minimum rate for `schoolYear` (whole dollars), e.g. 43543.
  newYearRate: integer("new_year_rate").notNull(),
  // Date CGFA certified the rate (the certification letter date).
  certifiedDate: date("certified_date"),
  // Canonical CGFA source document URL.
  sourceUrl: text("source_url"),
  // SHA-256 of the source PDF for change detection (skip unchanged re-ingests).
  fileHash: text("file_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type IlMinTeacherSalary = typeof ilMinTeacherSalaryTable.$inferSelect;
