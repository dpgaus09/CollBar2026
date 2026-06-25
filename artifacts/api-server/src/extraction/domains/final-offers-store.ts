// Persist ELRB final-offer extractions and rebuild the board-vs-union diff.
// Ported from pipeline/19_extract_final_offers.py (replace_items, classify_pair,
// _text_aligned, compute_comparisons).
//
// Writes two tables:
//   final_offer_items       — one party's per-topic positions (delete-then-insert
//                             per (posting_id, side); deduped to one row/topic).
//   final_offer_comparisons — the per-topic district-vs-union diff (delete-then-
//                             insert per posting_id; rebuilt from the items).
//
// numeric_gap is union_value - district_value (positive = union asks more), only
// when both sides give a number in the SAME unit. Otherwise alignment falls back
// to conservative qualitative text matching.

import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import type { OfferItem, OfferSide } from "../types";
import {
  extractFinalOffer,
  type OfferExtractionResult,
} from "./final-offers";
import { loadSourceDoc, resolvePdfBuffer } from "../source-docs";

// Per-unit tolerance below which two numeric positions count as "aligned" rather
// than a genuine difference (mirrors ALIGN_TOLERANCE in 19_extract_final_offers).
const ALIGN_TOLERANCE: Record<string, number> = {
  percent: 0.05,
  usd: 1.0,
  years: 0.0,
  days: 0.0,
  ratio: 0.01,
};

// Side-framing words dropped before qualitative comparison so two PDFs that
// reproduce the same agreed clause from each side's voice still match.
const SIDE_FRAMING_WORDS = new Set([
  "board", "boards", "union", "unions", "district", "districts",
  "employer", "association", "proposes", "proposal", "proposed",
  "offer", "offers", "position", "shall", "will",
]);

const TEXT_ALIGN_MIN_LEN = 16;
const TEXT_ALIGN_RATIO = 0.9;

export function normalizeText(s: string | null | undefined): string {
  if (!s) return "";
  const lowered = s.toLowerCase().replace(/[^a-z0-9%$./\- ]+/g, " ");
  return lowered
    .split(/\s+/)
    .filter((t) => t && !SIDE_FRAMING_WORDS.has(t))
    .join(" ");
}

function digits(s: string): string[] {
  return s.match(/\d+(?:\.\d+)?/g) ?? [];
}

function arrEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// difflib.SequenceMatcher.ratio() — Ratcliff/Obershelp on the two strings.
// Autojunk is not modeled (it only affects sequences >= 200 chars; offer
// summaries and excerpts are short), so this matches difflib for our inputs.
function matchingBlocksTotal(a: string, b: string): number {
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const arr = b2j.get(b[j]);
    if (arr) arr.push(j);
    else b2j.set(b[j], [j]);
  }

  function findLongest(
    alo: number,
    ahi: number,
    blo: number,
    bhi: number,
  ): { besti: number; bestj: number; bestsize: number } {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const js = b2j.get(a[i]);
      if (js) {
        for (const j of js) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    return { besti, bestj, bestsize };
  }

  let matches = 0;
  const stack: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop()!;
    const { besti, bestj, bestsize } = findLongest(alo, ahi, blo, bhi);
    if (bestsize > 0) {
      matches += bestsize;
      if (alo < besti && blo < bestj) stack.push([alo, besti, blo, bestj]);
      if (besti + bestsize < ahi && bestj + bestsize < bhi) {
        stack.push([besti + bestsize, ahi, bestj + bestsize, bhi]);
      }
    }
  }
  return matches;
}

function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * matchingBlocksTotal(a, b)) / total;
}

// True when two qualitative positions express materially the same term.
// Conservative: differing embedded numbers never align, very short strings are
// not fuzzily matched, and the fuzzy threshold is high.
export function textAligned(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (!arrEq(digits(na), digits(nb))) return false;
  if (na === nb) return true;
  if (na.length < TEXT_ALIGN_MIN_LEN || nb.length < TEXT_ALIGN_MIN_LEN) return false;
  return ratio(na, nb) >= TEXT_ALIGN_RATIO;
}

export interface CompareSide {
  value: number | null;
  unit: string | null;
  summary: string | null;
  rawText: string | null;
}

export type ComparisonStatus = "aligned" | "diff" | "district_only" | "union_only";

// Classify a district-vs-union position pair for one topic.
// - both sides numeric in the same unit -> numeric alignment (a real gap is never
//   overridden by language similarity);
// - otherwise -> conservative qualitative text alignment.
export function classifyPair(
  d: CompareSide,
  u: CompareSide,
): { status: "aligned" | "diff"; gap: number | null; gapUnit: string | null } {
  const dv = d.value;
  const uv = u.value;
  const du = (d.unit ?? "").trim().toLowerCase() || null;
  const uu = (u.unit ?? "").trim().toLowerCase() || null;
  if (dv !== null && uv !== null && du && du === uu) {
    const gap = uv - dv;
    const tol = ALIGN_TOLERANCE[du] ?? 0;
    return { status: Math.abs(gap) <= tol ? "aligned" : "diff", gap, gapUnit: du };
  }
  if (textAligned(d.rawText, u.rawText) || textAligned(d.summary, u.summary)) {
    return { status: "aligned", gap: null, gapUnit: null };
  }
  return { status: "diff", gap: null, gapUnit: null };
}

export interface OfferItemRow {
  id: string | null;
  side: OfferSide;
  topic: string;
  topicLabel: string | null;
  summary: string | null;
  numericValue: number | null;
  numericUnit: string | null;
  rawText: string | null;
}

export interface ComparisonRow {
  topic: string;
  topicLabel: string | null;
  status: ComparisonStatus;
  districtItemId: string | null;
  unionItemId: string | null;
  districtSummary: string | null;
  unionSummary: string | null;
  numericGap: number | null;
  gapUnit: string | null;
}

function toCompareSide(r: OfferItemRow): CompareSide {
  return {
    value: r.numericValue,
    unit: (r.numericUnit ?? "").trim().toLowerCase() || null,
    summary: r.summary,
    rawText: r.rawText,
  };
}

// Pair district vs union items by topic and produce the comparison rows.
// Pure (no DB) so it is unit-testable. Topic order follows first appearance.
export function buildComparisons(rows: OfferItemRow[]): ComparisonRow[] {
  interface Slot {
    label: string | null;
    district?: OfferItemRow;
    union?: OfferItemRow;
  }
  const byTopic = new Map<string, Slot>();
  for (const r of rows) {
    let slot = byTopic.get(r.topic);
    if (!slot) {
      slot = { label: r.topicLabel ?? null };
      byTopic.set(r.topic, slot);
    }
    if (!slot.label && r.topicLabel) slot.label = r.topicLabel;
    slot[r.side] = r;
  }

  const out: ComparisonRow[] = [];
  for (const [topic, slot] of byTopic) {
    const d = slot.district;
    const u = slot.union;
    const label = slot.label ?? d?.topicLabel ?? u?.topicLabel ?? null;
    if (d && u) {
      const { status, gap, gapUnit } = classifyPair(toCompareSide(d), toCompareSide(u));
      out.push({
        topic,
        topicLabel: label,
        status,
        districtItemId: d.id,
        unionItemId: u.id,
        districtSummary: d.summary,
        unionSummary: u.summary,
        numericGap: gap,
        gapUnit,
      });
    } else if (d) {
      out.push({
        topic,
        topicLabel: label,
        status: "district_only",
        districtItemId: d.id,
        unionItemId: null,
        districtSummary: d.summary,
        unionSummary: null,
        numericGap: null,
        gapUnit: null,
      });
    } else if (u) {
      out.push({
        topic,
        topicLabel: label,
        status: "union_only",
        districtItemId: null,
        unionItemId: u.id,
        districtSummary: null,
        unionSummary: u.summary,
        numericGap: null,
        gapUnit: null,
      });
    }
  }
  return out;
}

// Replace one side's items for a posting (delete-then-insert). Items are already
// deduped to one per topic by normalizeOfferItems.
export async function storeOfferItems(
  postingId: number | string,
  side: OfferSide,
  sourceDocId: number | string | null,
  items: OfferItem[],
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return items.length;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM final_offer_items WHERE posting_id = ${postingId} AND side = ${side}`,
    );
    if (!items.length) return 0;
    const values = sql.join(
      items.map(
        (it) =>
          sql`(${postingId}, ${side}, ${it.topic}, ${it.topicLabel}, ${it.summary}, ${it.numericValue}, ${it.numericUnit}, ${it.rawText}, ${sourceDocId})`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      INSERT INTO final_offer_items
        (posting_id, side, topic, topic_label, summary,
         numeric_value, numeric_unit, raw_text, source_doc_id)
      VALUES ${values}
    `);
    return items.length;
  });
}

async function loadOfferItems(postingId: number | string): Promise<OfferItemRow[]> {
  const res = await db.execute(sql`
    SELECT id::text               AS "id",
           side,
           topic,
           topic_label            AS "topicLabel",
           summary,
           numeric_value::float    AS "numericValue",
           numeric_unit           AS "numericUnit",
           raw_text               AS "rawText"
    FROM final_offer_items
    WHERE posting_id = ${postingId}
    ORDER BY id
  `);
  return res.rows.map((r) => r as unknown as OfferItemRow);
}

// Rebuild final_offer_comparisons for a posting from its stored items.
export async function computeComparisons(
  postingId: number | string,
  dryRun: boolean,
): Promise<number> {
  const rows = await loadOfferItems(postingId);
  const comparisons = buildComparisons(rows);
  if (dryRun) return comparisons.length;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM final_offer_comparisons WHERE posting_id = ${postingId}`,
    );
    if (!comparisons.length) return;
    const values = sql.join(
      comparisons.map(
        (c) =>
          sql`(${postingId}, ${c.topic}, ${c.topicLabel}, ${c.status}, ${c.districtItemId}, ${c.unionItemId}, ${c.districtSummary}, ${c.unionSummary}, ${c.numericGap}, ${c.gapUnit})`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      INSERT INTO final_offer_comparisons
        (posting_id, topic, topic_label, status, district_item_id,
         union_item_id, district_summary, union_summary, numeric_gap, gap_unit)
      VALUES ${values}
    `);
  });
  return comparisons.length;
}

interface PostingRow {
  id: string;
  caseNumber: string;
  districtSourceDocId: string | null;
  unionSourceDocId: string | null;
}

async function loadPosting(postingId: number | string): Promise<PostingRow | null> {
  const res = await db.execute(sql`
    SELECT id::text                     AS "id",
           case_number                  AS "caseNumber",
           district_source_doc_id::text AS "districtSourceDocId",
           union_source_doc_id::text    AS "unionSourceDocId"
    FROM final_offer_postings
    WHERE id = ${postingId}
  `);
  return (res.rows[0] as unknown as PostingRow | undefined) ?? null;
}

export interface SideRunResult {
  side: OfferSide;
  status: "ok" | "no_doc" | "no_pdf" | "extract_failed";
  sourceDocId: string | null;
  items?: number;
  extraction?: OfferExtractionResult;
}

async function runSide(
  postingId: string,
  side: OfferSide,
  sourceDocId: string | null,
  opts: { dryRun: boolean; useCache?: boolean; model?: string; maxPages?: number },
): Promise<SideRunResult> {
  if (!sourceDocId) return { side, status: "no_doc", sourceDocId: null };
  const doc = await loadSourceDoc(sourceDocId);
  if (!doc) return { side, status: "no_doc", sourceDocId };
  const buf = await resolvePdfBuffer(doc);
  if (!buf) return { side, status: "no_pdf", sourceDocId };

  const fileHash =
    doc.fileHash && /^[0-9a-f]{64}$/i.test(doc.fileHash)
      ? doc.fileHash.toLowerCase()
      : crypto.createHash("sha256").update(buf).digest("hex");

  const extraction = await extractFinalOffer(buf, fileHash, {
    model: opts.model,
    maxPages: opts.maxPages,
    useCache: opts.useCache,
  });
  // Fail-closed: a truncated/unparseable extraction must NOT replace this side's
  // stored items — storeOfferItems is delete-then-insert, so storing [] would
  // wipe the side's existing rows. Skip the store and leave existing rows intact.
  if (!extraction.ok) {
    logger.warn(
      { postingId, side, sourceDocId, status: extraction.status },
      "final-offers: extraction not ok; preserving existing items (no store)",
    );
    return { side, status: "extract_failed", sourceDocId, extraction };
  }
  const items = await storeOfferItems(
    postingId,
    side,
    sourceDocId,
    extraction.items,
    opts.dryRun,
  );
  return { side, status: "ok", sourceDocId, items, extraction };
}

export interface RunFinalOffersResult {
  status: "ok" | "no_posting";
  postingId: string;
  caseNumber?: string;
  sides?: SideRunResult[];
  comparisons?: number;
  dryRun?: boolean;
}

// Full final-offer domain for one posting: extract + store each side, then
// rebuild the comparison diff.
export async function runFinalOffersForPosting(
  postingId: number | string,
  opts?: { dryRun?: boolean; useCache?: boolean; model?: string; maxPages?: number },
): Promise<RunFinalOffersResult> {
  const dryRun = opts?.dryRun ?? false;
  const posting = await loadPosting(postingId);
  if (!posting) return { status: "no_posting", postingId: String(postingId) };

  const sides: SideRunResult[] = [];
  sides.push(
    await runSide(posting.id, "district", posting.districtSourceDocId, {
      dryRun,
      useCache: opts?.useCache,
      model: opts?.model,
      maxPages: opts?.maxPages,
    }),
  );
  sides.push(
    await runSide(posting.id, "union", posting.unionSourceDocId, {
      dryRun,
      useCache: opts?.useCache,
      model: opts?.model,
      maxPages: opts?.maxPages,
    }),
  );

  const comparisons = await computeComparisons(posting.id, dryRun);
  logger.info(
    { postingId: posting.id, caseNumber: posting.caseNumber, comparisons, dryRun },
    "final-offers: posting processed",
  );

  return {
    status: "ok",
    postingId: posting.id,
    caseNumber: posting.caseNumber,
    sides,
    comparisons,
    dryRun,
  };
}
