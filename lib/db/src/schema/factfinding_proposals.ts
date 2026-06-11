import {
  pgTable,
  bigserial,
  bigint,
  text,
  date,
  numeric,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";
import { sourceDocumentsTable } from "./source_documents";

export const factfindingProposalsTable = pgTable("factfinding_proposals", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  districtId: bigint("district_id", { mode: "bigint" }).references(
    () => districtsTable.id,
  ),
  caseNumber: text("case_number"),
  reportDate: date("report_date", { mode: "string" }),
  unionName: text("union_name"),
  employerProposalPct: numeric("employer_proposal_pct", {
    precision: 5,
    scale: 2,
  }),
  unionProposalPct: numeric("union_proposal_pct", { precision: 5, scale: 2 }),
  factfinderRecommendationPct: numeric("factfinder_recommendation_pct", {
    precision: 5,
    scale: 2,
  }),
  yearCovered: varchar("year_covered", { length: 7 }),
  sourceDocId: bigint("source_doc_id", { mode: "bigint" }).references(
    () => sourceDocumentsTable.id,
  ),
});

export const insertFactfindingProposalSchema = createInsertSchema(
  factfindingProposalsTable,
).omit({ id: true });
export type InsertFactfindingProposal = z.infer<
  typeof insertFactfindingProposalSchema
>;
export type FactfindingProposal =
  typeof factfindingProposalsTable.$inferSelect;
