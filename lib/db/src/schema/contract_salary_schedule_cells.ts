import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { contractSalarySchedulesTable } from "./contract_salary_schedules";

/**
 * One dollar amount in a salary schedule grid. For lane_grid schedules a cell
 * is (step x lane); for single_column schedules laneLabel is null and
 * laneOrder is 0. Grids are ragged — not every (step, lane) combination has a
 * cell — so missing combinations simply have no row.
 */
export const contractSalaryScheduleCellsTable = pgTable(
  "contract_salary_schedule_cells",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    scheduleId: bigint("schedule_id", { mode: "bigint" })
      .notNull()
      .references(() => contractSalarySchedulesTable.id, {
        onDelete: "cascade",
      }),
    // Verbatim step label, e.g. "0", "1", "Step 1".
    stepLabel: text("step_label").notNull(),
    // Numeric ordering of the step within the schedule.
    stepOrder: integer("step_order").notNull(),
    // Lane label, e.g. "BA", "BA+15", "MA or 36". Null for single_column.
    laneLabel: text("lane_label"),
    // Column ordering of the lane (0 for single_column).
    laneOrder: integer("lane_order").notNull().default(0),
    salaryAmount: numeric("salary_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),
    pageRef: integer("page_ref"),
  },
  (t) => [
    uniqueIndex("contract_salary_schedule_cells_uniq").on(
      t.scheduleId,
      t.stepOrder,
      t.laneOrder,
    ),
    index("contract_salary_schedule_cells_lane_step_idx").on(
      t.laneLabel,
      t.stepOrder,
    ),
  ],
);

export const insertContractSalaryScheduleCellSchema = createInsertSchema(
  contractSalaryScheduleCellsTable,
).omit({ id: true });
export type InsertContractSalaryScheduleCell = z.infer<
  typeof insertContractSalaryScheduleCellSchema
>;
export type ContractSalaryScheduleCell =
  typeof contractSalaryScheduleCellsTable.$inferSelect;
