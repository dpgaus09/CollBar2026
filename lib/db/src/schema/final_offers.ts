import {
  pgTable,
  bigserial,
  bigint,
  integer,
  text,
  numeric,
  timestamp,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";
import { sourceDocumentsTable } from "./source_documents";

// ---------------------------------------------------------------------------
// IL ELRB public-posting final offers (board vs. union)
//
// When an Illinois school district and its union reach impasse in interest
// arbitration/mediation, both sides' "final offers" are publicly posted on the
// ELRB site. CollBar scrapes those postings (one per case), extracts each
// side's per-article position, and diffs them so customers can see exactly
// where the board and the union still disagree — and where they already agree.
//
//   final_offer_postings   one row per ELRB case (the district↔union dispute)
//   final_offer_items      one row per (case, side, topic) extracted position
//   final_offer_comparisons one row per (case, topic) board-vs-union diff
// ---------------------------------------------------------------------------

export const finalOfferPostingsTable = pgTable(
  "final_offer_postings",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
    // ELRB case number, e.g. "2026-IM-0007-C". Stable per dispute.
    caseNumber: text("case_number").notNull(),
    // Posting year (the ELRB archive page the case was found on).
    year: integer("year").notNull(),
    bargainingUnit: text("bargaining_unit").notNull().default("teachers"),
    // Raw names as printed on the ELRB page (kept for provenance/display even
    // when district matching fails).
    districtName: text("district_name"),
    unionName: text("union_name"),
    // ELRB-reported posting/modify date (from the page data layer).
    postedDate: timestamp("posted_date", { withTimezone: true }),
    // Direct links to the two posted offer PDFs.
    districtOfferUrl: text("district_offer_url"),
    unionOfferUrl: text("union_offer_url"),
    // source_documents rows for each stored PDF (doc_type 'final_offer').
    districtSourceDocId: bigint("district_source_doc_id", {
      mode: "bigint",
    }).references(() => sourceDocumentsTable.id),
    unionSourceDocId: bigint("union_source_doc_id", {
      mode: "bigint",
    }).references(() => sourceDocumentsTable.id),
    // The ELRB year-archive page this case was scraped from.
    pageUrl: text("page_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("final_offer_postings_case_number_unique").on(t.caseNumber),
    index("final_offer_postings_district_idx").on(t.districtId),
  ],
);

export const finalOfferItemsTable = pgTable(
  "final_offer_items",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    postingId: bigint("posting_id", { mode: "bigint" })
      .notNull()
      .references(() => finalOfferPostingsTable.id, { onDelete: "cascade" }),
    // Which party's offer this position came from.
    side: text("side").notNull(),
    // Normalized comparison key (e.g. 'salary', 'insurance', 'term').
    topic: text("topic").notNull(),
    // Human-readable topic label (e.g. 'Salary / Wages').
    topicLabel: text("topic_label"),
    // One-line summary of this side's position on the topic.
    summary: text("summary"),
    // Parsed numeric value when the position is quantitative (e.g. 4.0 for a
    // 4% raise, 1500 for a $1,500 stipend). NULL for purely-language items.
    numericValue: numeric("numeric_value", { precision: 14, scale: 4 }),
    // Unit for numericValue: 'percent' | 'usd' | 'years' | etc.
    numericUnit: text("numeric_unit"),
    // Verbatim excerpt from the offer PDF backing this item.
    rawText: text("raw_text"),
    sourceDocId: bigint("source_doc_id", { mode: "bigint" }).references(
      () => sourceDocumentsTable.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("final_offer_items_posting_side_topic_unique").on(
      t.postingId,
      t.side,
      t.topic,
    ),
    index("final_offer_items_posting_idx").on(t.postingId),
    check(
      "final_offer_items_side_check",
      sql`${t.side} IN ('district','union')`,
    ),
  ],
);

export const finalOfferComparisonsTable = pgTable(
  "final_offer_comparisons",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    postingId: bigint("posting_id", { mode: "bigint" })
      .notNull()
      .references(() => finalOfferPostingsTable.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    topicLabel: text("topic_label"),
    // 'aligned'        — both sides effectively agree on this topic
    // 'diff'           — both sides addressed it but disagree
    // 'district_only'  — only the board's offer addresses it
    // 'union_only'     — only the union's offer addresses it
    status: text("status").notNull(),
    districtItemId: bigint("district_item_id", { mode: "bigint" }).references(
      () => finalOfferItemsTable.id,
    ),
    unionItemId: bigint("union_item_id", { mode: "bigint" }).references(
      () => finalOfferItemsTable.id,
    ),
    districtSummary: text("district_summary"),
    unionSummary: text("union_summary"),
    // Signed numeric gap (union - district) when both sides are quantitative
    // and share a unit. NULL when not comparable numerically.
    numericGap: numeric("numeric_gap", { precision: 14, scale: 4 }),
    gapUnit: text("gap_unit"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("final_offer_comparisons_posting_topic_unique").on(
      t.postingId,
      t.topic,
    ),
    index("final_offer_comparisons_posting_idx").on(t.postingId),
    check(
      "final_offer_comparisons_status_check",
      sql`${t.status} IN ('aligned','diff','district_only','union_only')`,
    ),
  ],
);

export const insertFinalOfferPostingSchema = createInsertSchema(
  finalOfferPostingsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFinalOfferPosting = z.infer<
  typeof insertFinalOfferPostingSchema
>;
export type FinalOfferPosting = typeof finalOfferPostingsTable.$inferSelect;

export const insertFinalOfferItemSchema = createInsertSchema(
  finalOfferItemsTable,
).omit({ id: true, createdAt: true });
export type InsertFinalOfferItem = z.infer<typeof insertFinalOfferItemSchema>;
export type FinalOfferItem = typeof finalOfferItemsTable.$inferSelect;

export const insertFinalOfferComparisonSchema = createInsertSchema(
  finalOfferComparisonsTable,
).omit({ id: true, createdAt: true });
export type InsertFinalOfferComparison = z.infer<
  typeof insertFinalOfferComparisonSchema
>;
export type FinalOfferComparison =
  typeof finalOfferComparisonsTable.$inferSelect;
