import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import {
  CUSTOMER_STATE,
  enrollmentBand,
  daysUntil,
  buildWhere,
} from "./dashboard-query.js";
import { coerceId, coerceIds } from "./coerce.js";
import { getRediscoveriesForDistrict, rediscoveryKey } from "./crawl-state.js";

// ---------------------------------------------------------------------------
// Shared district read helpers.
//
// Pure, IL-scoped read logic extracted verbatim from the customer dashboard
// routes so that BOTH the per-district CFO dashboard (lib/access.ts gate()) and
// the firm workspace (firm-access.ts requireFirmSession) read identical data
// from one place — no forked SQL. These helpers contain NO entitlement logic:
// callers own auth (gate vs requireFirmSession), the isCustomerDistrict() / 404
// existence guard, and (for the dashboard) the free-tier excerpt stripping
// (queryDistrictProvisions takes an explicit includeExcerpt flag instead).
//
// Every helper independently anchors to CUSTOMER_STATE so a non-IL district id
// can never leak data through these reads.
// ---------------------------------------------------------------------------

// All districts in the customer-facing state, optionally filtered by a name /
// county search. Ids are coerced from node-postgres bigint strings to numbers.
export async function queryDistrictList(q: string): Promise<Record<string, unknown>[]> {
  const conditions: Array<SQL | null> = [];
  if (CUSTOMER_STATE) {
    conditions.push(sql`state = ${CUSTOMER_STATE}`);
  }
  if (q) {
    const pattern = `%${q}%`;
    conditions.push(sql`(name ILIKE ${pattern} OR county ILIKE ${pattern})`);
  }
  const where = buildWhere(conditions);
  const rows = await db.execute(sql`
    SELECT id, name, county, district_type, enrollment, state, updated_at
    FROM districts
    WHERE ${where}
    ORDER BY name
    LIMIT 5000
  `);
  return coerceIds(rows.rows);
}

// One district's overview: facts plus the most recent contracts for the given
// bargaining unit (default teachers). Returns null when the district does not
// exist in the customer-facing state (caller turns that into a 404).
export async function queryDistrictDetail(
  districtId: number,
  unit: string,
): Promise<Record<string, unknown> | null> {
  const distRows = await db.execute(sql`
    SELECT id, name, county, district_type, enrollment, state, avg_teacher_salary, valuation, website_url, updated_at, state_district_id
    FROM districts
    WHERE id = ${districtId} AND state = ${CUSTOMER_STATE}
  `);
  if (!distRows.rows.length) return null;

  const district = distRows.rows[0] as {
    id: number; name: string; county: string | null; district_type: string | null;
    enrollment: number | null; state: string; avg_teacher_salary: string | null; updated_at: string;
    state_district_id: string | null;
  };

  const contractRows = await db.execute(sql`
    SELECT c.id, c.union_name, c.affiliation, c.unit_scope, c.bargaining_unit,
           c.effective_start, c.effective_end, c.term_years,
           c.has_reopener, c.reopener_terms,
           c.source_doc_id, sd.source_url
    FROM contracts c
    LEFT JOIN source_documents sd ON c.source_doc_id = sd.id
    WHERE c.district_id = ${districtId}
      AND c.bargaining_unit = ${unit}
    ORDER BY c.effective_start DESC NULLS LAST, c.effective_end DESC NULLS LAST, c.id DESC
    LIMIT 5
  `);

  // Surface contracts that were auto-refreshed from a relocated successor URL
  // (the crawler's "rediscovered_new_version" recheck outcome). Derived purely
  // from existing crawl-state — no scraping.
  const rediscoveries = getRediscoveriesForDistrict(district.state_district_id);

  const contracts = (contractRows.rows as {
    id: number; union_name: string | null; effective_start: string | null;
    effective_end: string | null; term_years: string | null;
    has_reopener: boolean | null; source_url: string | null;
    unit_scope: string | null; affiliation: string | null; bargaining_unit: string | null;
    source_doc_id: number | null; reopener_terms: string | null;
  }[]).map((c) => {
    const rd = rediscoveries[rediscoveryKey(c.bargaining_unit, c.unit_scope)];
    return {
      ...c,
      daysUntilExpiration: daysUntil(c.effective_end),
      rediscovered: rd
        ? { checkedAt: rd.checkedAt, sourceUrl: c.source_url }
        : null,
    };
  });

  return {
    ...coerceId(district),
    enrollmentBand: enrollmentBand(district.enrollment),
    currentContract: contracts[0] ?? null,
    recentContracts: contracts,
  };
}

// Settlement history for one district + bargaining unit, with the teacher-only
// cost-impact and EIS cross-check columns. Also returns the available bargaining
// units (drives the unit selector). Assumes the caller already verified the
// district is in the customer-facing state.
export async function queryDistrictSettlements(
  districtId: number,
  unit: string,
): Promise<{
  settlements: Record<string, unknown>[];
  bargainingUnit: string;
  availableUnits: Record<string, unknown>[];
}> {
  const rows = await db.execute(sql`
    SELECT s.id, s.from_year, s.to_year, s.base_increase_pct, s.year2_pct, s.year3_pct,
           s.off_schedule_payment, s.insurance_changed, s.term_years,
           s.method, s.confidence, s.human_verified, s.page_ref, s.notes,
           s.bargaining_unit, s.verified_by, s.verified_at,
           sd.source_url, sd.retrieved_at,
           -- Cost impact: EIS real salary preferred; TSS midpoint as fallback
           CASE
             WHEN d.state = 'IL' AND s.bargaining_unit = 'teachers' AND s.base_increase_pct IS NOT NULL
                  AND fte.teacher_fte IS NOT NULL AND eis.avg_teacher_salary IS NOT NULL
             THEN ROUND((s.base_increase_pct / 100.0) * fte.teacher_fte * eis.avg_teacher_salary, 0)
             WHEN d.state = 'IL' AND s.bargaining_unit = 'teachers' AND s.base_increase_pct IS NOT NULL
                  AND fte.teacher_fte IS NOT NULL
                  AND tss.ba_begin IS NOT NULL AND tss.highest_scheduled_salary IS NOT NULL
             THEN ROUND(
               (s.base_increase_pct / 100.0) * fte.teacher_fte *
               ((tss.ba_begin + tss.highest_scheduled_salary) / 2.0), 0
             )
             ELSE NULL
           END AS est_annual_cost_impact,
           -- Salary source label for the footnote
           CASE
             WHEN d.state = 'IL' AND s.bargaining_unit = 'teachers' AND eis.avg_teacher_salary IS NOT NULL
                  AND fte.teacher_fte IS NOT NULL THEN 'eis'
             WHEN d.state = 'IL' AND s.bargaining_unit = 'teachers' AND tss.ba_begin IS NOT NULL
                  AND fte.teacher_fte IS NOT NULL THEN 'tss'
             ELSE NULL
           END AS cost_impact_source,
           -- EIS cross-check: YoY change in district avg teacher salary from EIS data
           CASE
             WHEN d.state = 'IL' AND s.bargaining_unit = 'teachers' AND eis.avg_teacher_salary IS NOT NULL
                  AND eis_prev.avg_teacher_salary > 0
             THEN ROUND(
               ((eis.avg_teacher_salary - eis_prev.avg_teacher_salary)
                / eis_prev.avg_teacher_salary) * 100, 2
             )
             ELSE NULL
           END AS eis_observed_change_pct,
           -- Flag when settlement pct and EIS-observed change differ by > 2pp
           CASE
             WHEN d.state = 'IL' AND s.bargaining_unit = 'teachers' AND s.base_increase_pct IS NOT NULL
                  AND eis.avg_teacher_salary IS NOT NULL
                  AND eis_prev.avg_teacher_salary > 0
                  AND ABS(
                    s.base_increase_pct -
                    ROUND(((eis.avg_teacher_salary - eis_prev.avg_teacher_salary)
                           / eis_prev.avg_teacher_salary) * 100, 2)
                  ) > 2
             THEN true
             ELSE false
           END AS eis_flag
    FROM settlements s
    JOIN districts d ON d.id = s.district_id
    LEFT JOIN LATERAL (
      SELECT c2.source_doc_id
      FROM contracts c2
      WHERE c2.district_id = s.district_id
        AND c2.bargaining_unit = s.bargaining_unit
      ORDER BY c2.effective_end DESC NULLS LAST
      LIMIT 1
    ) lc ON true
    LEFT JOIN source_documents sd ON COALESCE(s.source_doc_id, lc.source_doc_id) = sd.id
    LEFT JOIN il_district_fte fte
      ON fte.state_district_id = d.state_district_id
      AND fte.school_year = s.from_year
    LEFT JOIN tss_annual tss
      ON tss.state_district_id = d.state_district_id
      AND tss.school_year = s.from_year AND tss.state = 'IL'
    LEFT JOIN il_eis_district eis
      ON eis.state_district_id = d.state_district_id
      AND eis.school_year = s.from_year
    LEFT JOIN il_eis_district eis_prev
      ON eis_prev.state_district_id = d.state_district_id
      AND eis_prev.school_year =
        (CAST(LEFT(s.from_year, 4) AS INT) - 1)::TEXT
        || '-' ||
        RIGHT(CAST(LEFT(s.from_year, 4) AS INT)::TEXT, 2)
    WHERE s.district_id = ${districtId}
      AND d.state = ${CUSTOMER_STATE}
      AND s.bargaining_unit = ${unit}
    ORDER BY s.from_year DESC
  `);

  // Which bargaining units does this district have? Drives the unit selector.
  // Lists every unit that has EITHER a contract or settlements; teachers first.
  const unitRows = await db.execute(sql`
    WITH units AS (
      SELECT bargaining_unit FROM settlements
      WHERE district_id = ${districtId} AND bargaining_unit IS NOT NULL
      UNION
      SELECT bargaining_unit FROM contracts
      WHERE district_id = ${districtId} AND bargaining_unit IS NOT NULL
    )
    SELECT u.bargaining_unit,
           (SELECT COUNT(*)::int FROM settlements s
            WHERE s.district_id = ${districtId}
              AND s.bargaining_unit = u.bargaining_unit) AS n
    FROM units u
    ORDER BY (u.bargaining_unit = 'teachers') DESC, n DESC, u.bargaining_unit
  `);

  return {
    settlements: rows.rows,
    bargainingUnit: unit,
    availableUnits: unitRows.rows,
  };
}

// Full salary-schedule grids for the most recent (district, unit) contract that
// has display-quality grids (implausible-magnitude rows are withheld). Assumes
// the caller already verified the district is in the customer-facing state.
export async function queryDistrictSalarySchedules(
  districtId: number,
  unit: string,
): Promise<{
  bargainingUnit: string;
  contractId: number | null;
  schedules: Record<string, unknown>[];
  jobFamilies: string[];
  schoolYears: string[];
  summary: {
    scheduleName: string; schoolYear: string;
    baseSalary: number | null; maBaseSalary: number | null; maxSalary: number | null;
  } | null;
  availableUnits: string[];
}> {
  // Units that have a CBA, for the selector (teachers first).
  const availUnits = await db.execute(sql`
    SELECT bargaining_unit FROM contracts
    WHERE district_id = ${districtId} AND bargaining_unit IS NOT NULL
    GROUP BY bargaining_unit
    ORDER BY (bargaining_unit = 'teachers') DESC, bargaining_unit
  `);
  const availableUnits = (availUnits.rows as { bargaining_unit: string }[]).map((r) => r.bargaining_unit);

  // Most recent (district, unit) contract that actually has display-quality
  // schedules. Schedules flagged with an implausible salary magnitude are
  // withheld from the customer view (they remain for the human-review queue).
  const targetRows = await db.execute(sql`
    SELECT s.contract_id
    FROM contract_salary_schedules s
    JOIN contracts c ON c.id = s.contract_id
    WHERE c.district_id = ${districtId} AND c.bargaining_unit = ${unit}
      AND (s.review_reason IS NULL
           OR s.review_reason NOT LIKE '%implausible_salary_magnitude%')
    ORDER BY c.effective_start DESC NULLS LAST, c.id DESC
    LIMIT 1
  `);
  if (!targetRows.rows.length) {
    return { bargainingUnit: unit, contractId: null, schedules: [], jobFamilies: [], schoolYears: [], summary: null, availableUnits };
  }
  const contractId = Number((targetRows.rows[0] as { contract_id: number | string }).contract_id);

  const schedRows = await db.execute(sql`
    SELECT s.id, s.schedule_name, s.school_year, s.start_year, s.schedule_type,
           s.lane_labels, s.step_count, s.lane_count, s.page_start, s.page_end,
           s.min_salary, s.max_salary, s.confidence, s.needs_review,
           s.review_reason, s.extraction_method,
           sd.source_url
    FROM contract_salary_schedules s
    LEFT JOIN source_documents sd ON sd.id = s.source_doc_id
    WHERE s.contract_id = ${contractId}
      AND (s.review_reason IS NULL
           OR s.review_reason NOT LIKE '%implausible_salary_magnitude%')
    ORDER BY s.schedule_name, s.start_year NULLS LAST, s.school_year
  `);

  const cellRows = await db.execute(sql`
    SELECT cell.schedule_id, cell.step_label, cell.step_order, cell.lane_label,
           cell.lane_order, cell.salary_amount, cell.page_ref
    FROM contract_salary_schedule_cells cell
    JOIN contract_salary_schedules s ON s.id = cell.schedule_id
    WHERE s.contract_id = ${contractId}
      AND (s.review_reason IS NULL
           OR s.review_reason NOT LIKE '%implausible_salary_magnitude%')
    ORDER BY cell.step_order, cell.lane_order
  `);

  type CellOut = { stepLabel: string; stepOrder: number; laneLabel: string | null; laneOrder: number; salary: number; pageRef: number | null };
  const cellsBySched = new Map<number, CellOut[]>();
  for (const r of cellRows.rows as Array<Record<string, unknown>>) {
    const sid = Number(r.schedule_id);
    const arr = cellsBySched.get(sid) ?? [];
    arr.push({
      stepLabel: String(r.step_label),
      stepOrder: Number(r.step_order),
      laneLabel: r.lane_label == null ? null : String(r.lane_label),
      laneOrder: Number(r.lane_order),
      salary: Number(r.salary_amount),
      pageRef: r.page_ref == null ? null : Number(r.page_ref),
    });
    cellsBySched.set(sid, arr);
  }

  const schedules = (schedRows.rows as Array<Record<string, unknown>>).map((s) => {
    const id = Number(s.id);
    const laneLabels = (s.lane_labels as string[] | null) ?? null;
    // laneKind tells the UI how to render columns WITHOUT assuming education
    // lanes: 'education' only for BA/MA/BS/MS degree lanes, 'columns' for any
    // other multi-column grid (e.g. custodial job classes), null otherwise.
    const laneKind: "education" | "columns" | null =
      laneLabels && laneLabels.length
        ? (laneLabels.some((l) => /^\s*(BA|MA|BS|MS|B\.A|M\.A)\b/i.test(String(l)))
            ? "education"
            : "columns")
        : null;
    return {
      id,
      scheduleName: String(s.schedule_name),
      schoolYear: String(s.school_year),
      startYear: s.start_year == null ? null : Number(s.start_year),
      scheduleType: String(s.schedule_type),
      laneLabels,
      laneKind,
      stepCount: s.step_count == null ? null : Number(s.step_count),
      laneCount: s.lane_count == null ? null : Number(s.lane_count),
      pageStart: s.page_start == null ? null : Number(s.page_start),
      pageEnd: s.page_end == null ? null : Number(s.page_end),
      minSalary: s.min_salary == null ? null : Number(s.min_salary),
      maxSalary: s.max_salary == null ? null : Number(s.max_salary),
      confidence: s.confidence == null ? null : Number(s.confidence),
      needsReview: Boolean(s.needs_review),
      reviewReason: (s.review_reason as string | null) ?? null,
      extractionMethod: (s.extraction_method as string | null) ?? null,
      sourceUrl: (s.source_url as string | null) ?? null,
      cells: cellsBySched.get(id) ?? [],
    };
  });

  const jobFamilies = [...new Set(schedules.map((s) => s.scheduleName))];
  const schoolYears = [...new Set(schedules.map((s) => s.schoolYear))].sort();

  // Derived scalar anchors for the default job family's latest year.
  const defaultFamily = jobFamilies.includes("Teachers") ? "Teachers" : jobFamilies[0];
  const fam = schedules
    .filter((s) => s.scheduleName === defaultFamily)
    .sort((a, b) => (b.startYear ?? 0) - (a.startYear ?? 0));
  const latest = fam[0] ?? null;
  let summary: {
    scheduleName: string; schoolYear: string;
    baseSalary: number | null; maBaseSalary: number | null; maxSalary: number | null;
  } | null = null;
  if (latest && latest.cells.length) {
    const step0 = Math.min(...latest.cells.map((c) => c.stepOrder));
    const baCell =
      latest.cells.find((c) => c.stepOrder === step0 && /^BA\b/i.test(c.laneLabel ?? "")) ??
      latest.cells.find((c) => c.stepOrder === step0 && c.laneOrder === 0);
    const maCell = latest.cells.find((c) => c.stepOrder === step0 && /^MA\b/i.test(c.laneLabel ?? ""));
    summary = {
      scheduleName: defaultFamily,
      schoolYear: latest.schoolYear,
      baseSalary: baCell ? baCell.salary : null,
      maBaseSalary: maCell ? maCell.salary : null,
      maxSalary: latest.maxSalary,
    };
  }

  return { bargainingUnit: unit, contractId, schedules, jobFamilies, schoolYears, summary, availableUnits };
}

// Overview-style provisions for one district + bargaining unit. The verbatim
// clause_excerpt is the signature content of the paid Key Clauses feature, so
// the caller decides whether to include it: the dashboard passes
// includeExcerpt=false for free users; the firm workspace (full access) passes
// includeExcerpt=true. Category must be pre-validated by the caller.
export async function queryDistrictProvisions(
  districtId: number,
  unit: string,
  category: string | null,
  opts: { includeExcerpt: boolean },
): Promise<{ provisions: Record<string, unknown>[] }> {
  const catCondition = category ? sql`AND cp.category = ${category}` : sql``;
  const rows = await db.execute(sql`
    SELECT cp.id, cp.category, cp.provision_key, cp.value_numeric, cp.value_text,
           cp.unit, cp.clause_excerpt, cp.page_ref, cp.confidence, cp.human_verified,
           c.id AS contract_id, c.effective_start, c.effective_end,
           c.source_doc_id, sd.source_url, sd.retrieved_at
    FROM contract_provisions cp
    JOIN contracts c ON cp.contract_id = c.id
    LEFT JOIN source_documents sd ON c.source_doc_id = sd.id
    WHERE c.district_id = ${districtId}
      AND c.bargaining_unit = ${unit}
    ${catCondition}
    ORDER BY c.effective_start DESC NULLS LAST, cp.category, cp.provision_key
    LIMIT 200
  `);
  const provisions = opts.includeExcerpt
    ? rows.rows
    : rows.rows.map((r) => ({ ...(r as Record<string, unknown>), clause_excerpt: null }));
  return { provisions };
}
