import {
  pgTable,
  bigserial,
  bigint,
  text,
  numeric,
  integer,
  boolean,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { contractsTable } from "./contracts";

export const contractProvisionsTable = pgTable(
  "contract_provisions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    contractId: bigint("contract_id", { mode: "bigint" }).references(
      () => contractsTable.id,
    ),
    category: text("category"),
    provisionKey: text("provision_key"),
    valueNumeric: numeric("value_numeric", { precision: 12, scale: 2 }),
    valueText: text("value_text"),
    unit: text("unit"),
    clauseExcerpt: text("clause_excerpt"),
    pageRef: integer("page_ref"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    humanVerified: boolean("human_verified").default(false),
    isAuditSample: boolean("is_audit_sample").notNull().default(false),
    auditVerdict: text("audit_verdict"),
  },
  (t) => [
    check(
      "contract_provisions_category_check",
      sql`${t.category} IN ('compensation','insurance','retirement','leave','workday','evaluation','rif','grievance','other')`,
    ),
    check(
      "contract_provisions_audit_verdict_check",
      sql`${t.auditVerdict} IN ('agree','disagree')`,
    ),
  ],
);

export const insertContractProvisionSchema = createInsertSchema(
  contractProvisionsTable,
).omit({ id: true });
export type InsertContractProvision = z.infer<
  typeof insertContractProvisionSchema
>;
export type ContractProvision = typeof contractProvisionsTable.$inferSelect;
