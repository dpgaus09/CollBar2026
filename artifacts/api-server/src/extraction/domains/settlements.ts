// Settlement derivation — 'stated' method (Task #176).
//
// Unlike salary/provisions/final_offer, settlements are NOT vision-extracted from
// a PDF. They are DERIVED from a contract's already-extracted compensation
// provisions. This module re-derives just ONE document's 'stated' settlement
// rows (one per attached contract that carries a base_salary_increase_yr1
// provision), so the extraction engine can version + diff + promote them like
// every other domain.
//
// This is a faithful TS port of the 'stated' pass of pipeline/06_extract_contracts.py
// `derive_settlements`. The 'ba_min_delta' (consecutive-pair) and 'tss_diff'
// (district-level TSS) methods are cross-document and do NOT fit a per-doc job;
// they remain in the Python pipeline.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import type { DerivedSettlement } from "../types";

export const SETTLEMENT_DERIVE_VERSION = "settlement-stated-v1";

// An LLM occasionally misreads a dollar figure as a percentage (e.g. a $4,500
// base salary read as 4500%). Any |base %| beyond this is implausible for a K-12
// settlement, so we flag it for review instead of inserting bad data (mirrors the
// Python MAX_PLAUSIBLE_BASE_PCT guard, which also protects numeric(5,2)).
const MAX_PLAUSIBLE_BASE_PCT = 50.0;

const COMP_KEYS = [
  "base_salary_increase_yr1",
  "base_salary_increase_yr2",
  "base_salary_increase_yr3",
  "ba_min_salary",
  "off_schedule_bonus_yr1",
] as const;

// Convert a date (YYYY-MM-DD) to a 'YYYY-YY' school year. School year starts in
// July: an Aug 2022 start → 2022-23; a Jun 2025 end → 2024-25 (is_end shifts the
// year back when the month is in the first half). Exact port of `_school_year`.
export function schoolYear(
  dateStr: string | null | undefined,
  isEnd = false,
): string | null {
  if (!dateStr) return null;
  const s = String(dateStr);
  const y = parseInt(s.slice(0, 4), 10);
  if (!Number.isFinite(y)) return null;
  const m = s.length >= 7 ? parseInt(s.slice(5, 7), 10) : 7;
  let yy = y;
  if (isEnd && m <= 6) yy -= 1;
  return `${yy}-${String(yy + 1).slice(2)}`;
}

interface ProvVal {
  val: number;
  conf: number;
}

async function loadCompProvisions(
  contractId: string,
): Promise<Record<string, ProvVal>> {
  const res = await db.execute(sql`
    SELECT provision_key      AS "key",
           value_numeric::float AS "val",
           confidence::float    AS "conf"
    FROM contract_provisions
    WHERE contract_id = ${contractId}
      AND category = 'compensation'
      AND provision_key IN (${sql.join(
        COMP_KEYS.map((k) => sql`${k}`),
        sql`, `,
      )})
      AND value_numeric IS NOT NULL
  `);
  const map: Record<string, ProvVal> = {};
  for (const r of res.rows as Array<{ key: string; val: number; conf: number }>) {
    map[r.key] = { val: r.val, conf: r.conf };
  }
  return map;
}

export interface DeriveResult {
  settlements: DerivedSettlement[];
  // reason → count, for the version summary (e.g. "stated:no_yr1_provision")
  skipped: Record<string, number>;
  flaggedOutOfRange: Array<{ contractId: string; basePct: number }>;
}

// Re-derive the 'stated' settlement rows for every contract attached to one
// source document. Read-only: returns the derived rows; the store fn writes them
// on promote. A contract emits at most one row.
export async function deriveStatedSettlements(
  sourceDocId: number | string,
): Promise<DeriveResult> {
  const skipped: Record<string, number> = {};
  const flagged: Array<{ contractId: string; basePct: number }> = [];
  const out: DerivedSettlement[] = [];
  const skip = (r: string) => {
    skipped[r] = (skipped[r] ?? 0) + 1;
  };

  const res = await db.execute(sql`
    SELECT id::text              AS "id",
           district_id::text     AS "districtId",
           bargaining_unit       AS "bargainingUnit",
           effective_start::text AS "effectiveStart",
           effective_end::text   AS "effectiveEnd",
           term_years::float     AS "termYears"
    FROM contracts
    WHERE source_doc_id = ${sourceDocId}
    ORDER BY id
  `);
  const contracts = res.rows as Array<{
    id: string;
    districtId: string | null;
    bargainingUnit: string | null;
    effectiveStart: string | null;
    effectiveEnd: string | null;
    termYears: number | null;
  }>;

  for (const c of contracts) {
    if (!c.districtId) {
      skip("no_district_id");
      continue;
    }
    const prov = await loadCompProvisions(c.id);
    const yr1 = prov["base_salary_increase_yr1"];
    if (!yr1) {
      skip("stated:no_yr1_provision");
      continue;
    }
    if (!c.effectiveStart) {
      skip("stated:no_effective_start");
      continue;
    }
    const fromYear = schoolYear(c.effectiveStart);
    if (!fromYear) {
      skip("stated:unparseable_date");
      continue;
    }

    const basePct = yr1.val;
    if (Math.abs(basePct) > MAX_PLAUSIBLE_BASE_PCT) {
      flagged.push({ contractId: c.id, basePct });
      skip("stated:base_pct_out_of_range");
      logger.warn(
        { contractId: c.id, districtId: c.districtId, basePct },
        "settlement [stated]: base % out of plausible range — flagged, not derived",
      );
      continue;
    }

    const toYear = c.effectiveEnd ? schoolYear(c.effectiveEnd, true) : null;
    out.push({
      districtId: c.districtId,
      bargainingUnit: c.bargainingUnit ?? "teachers",
      fromYear,
      toYear: toYear ?? fromYear,
      baseIncreasePct: basePct,
      year2Pct: prov["base_salary_increase_yr2"]?.val ?? null,
      year3Pct: prov["base_salary_increase_yr3"]?.val ?? null,
      offSchedulePayment: prov["off_schedule_bonus_yr1"]?.val ?? null,
      termYears: c.termYears ?? null,
      confidence: yr1.conf,
      contractId: c.id,
    });
  }

  return { settlements: out, skipped, flaggedOutOfRange: flagged };
}
