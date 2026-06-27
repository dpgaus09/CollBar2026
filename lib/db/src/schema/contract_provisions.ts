import {
  pgTable,
  bigserial,
  bigint,
  text,
  numeric,
  integer,
  boolean,
  check,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { contractsTable } from "./contracts";

// A Postgres tsvector column. Drizzle has no native tsvector type, so we declare
// it via customType. Only the COLUMN NAME matters to the drift guard
// (lib/db/scripts/check-drift.ts compares column names, not types or generated
// expressions); the STORED generated expression and the GIN index are applied
// idempotently by the API server's runMigrations(). The column is GENERATED
// ALWAYS in the database and is never written through Drizzle (it is omitted
// from the insert schema below).
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

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
    // Full-text search vector over the verbatim clause language (Phase 4 clause
    // search). The STORED generated expression weights A=clause_excerpt (the
    // verbatim clause), B=value_text, C=provision_key + category so excerpt
    // matches outrank metadata matches; the column and its GIN index are created
    // by runMigrations() and must be kept in lockstep with that migration. Read
    // only via raw SQL (ts_rank / @@) — never written through Drizzle.
    clauseTsv: tsvector("clause_tsv"),
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
).omit({ id: true, clauseTsv: true });
export type InsertContractProvision = z.infer<
  typeof insertContractProvisionSchema
>;
export type ContractProvision = typeof contractProvisionsTable.$inferSelect;
