import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  numeric,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { contractsTable } from "./contracts";
import { districtsTable } from "./districts";
import { sourceDocumentsTable } from "./source_documents";

/**
 * One row per distinct salary schedule found in a contract: a (job-family,
 * school-year) pair. A single teacher contract typically yields several rows —
 * e.g. "Teachers" 2025-2026/2026-2027/2027-2028 plus separate
 * "Counselors/Social Workers" and "Psychologists/Speech Pathologists"
 * schedules, each repeated per year. The actual dollar amounts live in
 * contract_salary_schedule_cells.
 */
export const contractSalarySchedulesTable = pgTable(
  "contract_salary_schedules",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    contractId: bigint("contract_id", { mode: "bigint" })
      .notNull()
      .references(() => contractsTable.id, { onDelete: "cascade" }),
    districtId: bigint("district_id", { mode: "bigint" })
      .notNull()
      .references(() => districtsTable.id),
    bargainingUnit: text("bargaining_unit").notNull().default("teachers"),
    sourceDocId: bigint("source_doc_id", { mode: "bigint" }).references(
      () => sourceDocumentsTable.id,
    ),
    // Job family / sub-schedule label, e.g. "Teachers",
    // "Counselors/Social Workers". Verbatim from the appendix heading.
    scheduleName: text("schedule_name").notNull(),
    // Human-readable school year, e.g. "2025-2026".
    schoolYear: text("school_year").notNull(),
    // Sortable starting year (e.g. 2025) for range filters / comparisons.
    startYear: integer("start_year"),
    // lane_grid = steps x education lanes (teachers); single_column = step->salary;
    // hourly/stipend = rate tables; unknown = could not classify.
    scheduleType: text("schedule_type").notNull().default("unknown"),
    // Ordered array of lane labels (column order), null for single_column.
    laneLabels: jsonb("lane_labels"),
    stepCount: integer("step_count"),
    laneCount: integer("lane_count"),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    minSalary: numeric("min_salary", { precision: 12, scale: 2 }),
    maxSalary: numeric("max_salary", { precision: 12, scale: 2 }),
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: text("review_reason"),
    // pdfplumber | ocr | llm | vision
    extractionMethod: text("extraction_method"),
    rawJson: jsonb("raw_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("contract_salary_schedules_uniq").on(
      t.contractId,
      t.scheduleName,
      t.schoolYear,
    ),
    index("contract_salary_schedules_unit_year_idx").on(
      t.bargainingUnit,
      t.startYear,
    ),
    check(
      "contract_salary_schedules_type_check",
      sql`${t.scheduleType} IN ('lane_grid','single_column','hourly','stipend','unknown')`,
    ),
  ],
);

export const insertContractSalaryScheduleSchema = createInsertSchema(
  contractSalarySchedulesTable,
).omit({ id: true, createdAt: true });
export type InsertContractSalarySchedule = z.infer<
  typeof insertContractSalaryScheduleSchema
>;
export type ContractSalarySchedule =
  typeof contractSalarySchedulesTable.$inferSelect;
