// Persist routed salary schedules into contract_salary_schedules (+cells), and
// orchestrate the full per-document salary domain (resolve PDF -> vision extract
// -> route -> store). Ported from pipeline/18_extract_salary_schedules.py
// (store_schedules / route_schedules / fetch_doc_units / process_doc_group).
//
// Each contract is rewritten as one delete-then-insert TRANSACTION — even when
// it routes to ZERO schedules, so stale/leaked rows clear. One bad contract is
// recorded and skipped, never poisoning the rest of the document's batch.

import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import type { SalarySchedule } from "../types";
import { routeSchedules } from "./salary-grid";
import {
  extractSalarySchedules,
  type SalaryExtractionResult,
} from "./salary";
import { loadSourceDoc, resolvePdfBuffer } from "../source-docs";

interface ContractTarget {
  contractId: string;
  districtId: string;
  sourceDocId: string | null;
  bargainingUnit: string;
  districtName: string | null;
}

export interface ContractResult {
  contractId: string;
  status: "ok" | "store_error";
  schedules: number;
  cells: number;
  flagged: number;
}

// All contracts that reference this source_doc, with their authoritative
// bargaining unit. Routing needs the FULL sibling set so it can decide e.g.
// whether a teachers contract exists to receive an education grid.
async function fetchContractTargets(
  sourceDocId: number | string,
): Promise<ContractTarget[]> {
  const res = await db.execute(sql`
    SELECT c.id::text              AS "contractId",
           c.district_id::text     AS "districtId",
           c.source_doc_id::text   AS "sourceDocId",
           COALESCE(c.bargaining_unit, 'teachers') AS "bargainingUnit",
           d.name                  AS "districtName"
    FROM contracts c
    JOIN districts d ON d.id = c.district_id
    WHERE c.source_doc_id = ${sourceDocId}
    ORDER BY c.id
  `);
  return res.rows.map((r) => r as unknown as ContractTarget);
}

const effectiveYear = (s: SalarySchedule): string =>
  s.schoolYear || `unknown-p${s.pageStart}`;

// Richness for dedupe tie-breaking: most cells, then confidence, then steps.
function richnessGt(a: SalarySchedule, b: SalarySchedule): boolean {
  const ra = [a.cells.length, a.confidence || 0, a.stepCount || 0];
  const rb = [b.cells.length, b.confidence || 0, b.stepCount || 0];
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i];
  }
  return false;
}

// Merge a review reason into an existing ";"-joined set (sorted, de-duped).
function mergeReasons(existing: string | null, add: string): string {
  const parts = new Set((existing ?? "").split(";"));
  parts.add(add);
  return [...parts].sort().join(";").replace(/^;+|;+$/g, "");
}

// Replace all salary schedules for one contract (delete-then-insert in a single
// transaction). Dedupes on the DB unique key (schedule_name, effective year)
// BEFORE inserting so a duplicated appendix can't violate the unique index and
// roll back the whole contract. Returns counts written.
async function storeSchedulesForContract(
  target: ContractTarget,
  schedules: SalarySchedule[],
  dryRun: boolean,
): Promise<{ nSched: number; nCells: number }> {
  // Dedupe by (schedule_name, effective year); keep the richest of each group.
  const deduped = new Map<string, SalarySchedule>();
  for (const s of schedules) {
    const key = `${s.scheduleName}\u0000${effectiveYear(s)}`;
    const prev = deduped.get(key);
    if (!prev || richnessGt(s, prev)) deduped.set(key, s);
  }
  const finalSchedules = [...deduped.values()];

  if (dryRun) {
    return {
      nSched: finalSchedules.length,
      nCells: finalSchedules.reduce((n, s) => n + s.cells.length, 0),
    };
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM contract_salary_schedules WHERE contract_id = ${target.contractId}`,
    );
    let nSched = 0;
    let nCells = 0;

    for (const s of finalSchedules) {
      let schoolYear = s.schoolYear;
      let needsReview = s.needsReview;
      let reviewReason = s.reviewReason;

      // raw_json mirrors the ORIGINAL schedule (pre year-synthesis), minus cells.
      const raw = {
        schedule_name: s.scheduleName,
        school_year: s.schoolYear,
        start_year: s.startYear,
        schedule_type: s.scheduleType,
        lane_labels: s.laneLabels,
        step_count: s.stepCount,
        lane_count: s.laneCount,
        page_start: s.pageStart,
        page_end: s.pageEnd,
        min_salary: s.minSalary,
        max_salary: s.maxSalary,
        confidence: s.confidence,
        needs_review: s.needsReview,
        review_reason: s.reviewReason,
        extraction_method: s.extractionMethod,
      };

      // school_year is NOT NULL and part of the unique key. If the parser could
      // not detect a year, synthesize a stable placeholder and flag for review
      // rather than dropping the schedule.
      if (!schoolYear) {
        schoolYear = `unknown-p${s.pageStart}`;
        needsReview = true;
        reviewReason = mergeReasons(reviewReason, "missing_year");
      }

      const laneLabelsJson =
        s.laneLabels && s.laneLabels.length ? JSON.stringify(s.laneLabels) : null;

      const ins = await tx.execute(sql`
        INSERT INTO contract_salary_schedules
          (contract_id, district_id, bargaining_unit, source_doc_id,
           schedule_name, school_year, start_year, schedule_type,
           lane_labels, step_count, lane_count, page_start, page_end,
           min_salary, max_salary, confidence, needs_review,
           review_reason, extraction_method, raw_json)
        VALUES
          (${target.contractId}, ${target.districtId}, ${target.bargainingUnit},
           ${target.sourceDocId}, ${s.scheduleName}, ${schoolYear}, ${s.startYear},
           ${s.scheduleType}, ${laneLabelsJson}::jsonb, ${s.stepCount},
           ${s.laneCount}, ${s.pageStart}, ${s.pageEnd}, ${s.minSalary},
           ${s.maxSalary}, ${s.confidence}, ${needsReview}, ${reviewReason},
           ${s.extractionMethod}, ${JSON.stringify(raw)}::jsonb)
        RETURNING id
      `);
      const sid = (ins.rows[0] as { id: string | number }).id;

      if (s.cells.length) {
        const values = sql.join(
          s.cells.map(
            (c) =>
              sql`(${sid}, ${c.stepLabel}, ${c.stepOrder}, ${c.laneLabel}, ${c.laneOrder}, ${c.salaryAmount}, ${c.pageRef})`,
          ),
          sql`, `,
        );
        await tx.execute(sql`
          INSERT INTO contract_salary_schedule_cells
            (schedule_id, step_label, step_order, lane_label, lane_order,
             salary_amount, page_ref)
          VALUES ${values}
        `);
      }
      nSched += 1;
      nCells += s.cells.length;
    }
    return { nSched, nCells };
  });
}

export interface StoreDocResult {
  results: ContractResult[];
  unattributed: number;
}

// Route a document's schedules to the bargaining units present on it and store
// each target contract's subset. `schedules` is the doc-level extraction result
// (pre-routing). Every target is rewritten so stale rows clear.
export async function storeSalaryForDoc(
  sourceDocId: number | string,
  schedules: SalarySchedule[],
  opts?: { dryRun?: boolean },
): Promise<StoreDocResult> {
  const dryRun = opts?.dryRun ?? false;
  const targets = await fetchContractTargets(sourceDocId);
  if (!targets.length) return { results: [], unattributed: 0 };

  const siblingUnits = new Set(targets.map((t) => t.bargainingUnit));
  const { routed, unattributed } = routeSchedules(schedules, siblingUnits);
  if (unattributed.length) {
    logger.info(
      { sourceDocId, unattributed: unattributed.length },
      "salary: schedule(s) unattributed — no matching unit contract; not stored",
    );
  }

  const results: ContractResult[] = [];
  for (const t of targets) {
    const subset = routed.get(t.bargainingUnit) ?? [];
    const flagged = subset.filter((s) => s.needsReview).length;
    try {
      const { nSched, nCells } = await storeSchedulesForContract(
        t,
        subset,
        dryRun,
      );
      results.push({
        contractId: t.contractId,
        status: "ok",
        schedules: nSched,
        cells: nCells,
        flagged,
      });
    } catch (err) {
      logger.error(
        { err, contractId: t.contractId },
        "salary store failed for contract",
      );
      results.push({
        contractId: t.contractId,
        status: "store_error",
        schedules: 0,
        cells: 0,
        flagged: 0,
      });
    }
  }
  return { results, unattributed: unattributed.length };
}

export interface RunSalaryResult {
  status: "ok" | "no_doc" | "no_pdf";
  sourceDocId: string;
  fileHash?: string;
  extraction?: SalaryExtractionResult;
  store?: StoreDocResult;
  dryRun?: boolean;
}

// Full salary domain for one source document: load row -> resolve PDF bytes ->
// vision extract -> route + store. The cache key is the content hash; if the row
// has no usable file_hash we hash the bytes ourselves.
export async function runSalaryForDoc(
  sourceDocId: number | string,
  opts?: {
    dryRun?: boolean;
    useCache?: boolean;
    model?: string;
    maxPages?: number;
  },
): Promise<RunSalaryResult> {
  const dryRun = opts?.dryRun ?? false;
  const doc = await loadSourceDoc(sourceDocId);
  if (!doc) return { status: "no_doc", sourceDocId: String(sourceDocId) };

  const buf = await resolvePdfBuffer(doc);
  if (!buf) {
    return { status: "no_pdf", sourceDocId: String(doc.id), fileHash: doc.fileHash ?? undefined };
  }

  const fileHash =
    doc.fileHash && /^[0-9a-f]{64}$/i.test(doc.fileHash)
      ? doc.fileHash.toLowerCase()
      : crypto.createHash("sha256").update(buf).digest("hex");

  const extraction = await extractSalarySchedules(buf, fileHash, {
    model: opts?.model,
    maxPages: opts?.maxPages,
    useCache: opts?.useCache,
  });

  const store = await storeSalaryForDoc(doc.id, extraction.schedules, { dryRun });

  return {
    status: "ok",
    sourceDocId: String(doc.id),
    fileHash,
    extraction,
    store,
    dryRun,
  };
}
