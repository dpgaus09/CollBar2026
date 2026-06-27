import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { firmScopeDistrictIds } from "./firm-scope.js";

// ============================================================================
// Shared data model for the firm comparison matrix (Phase 3).
//
// The single source of truth for "districts × curated metric columns, every
// cell cited". Both the live POST /api/firm/compare route AND the Phase 5
// work-product export builders call buildMatrix() so the figures and citations
// in a generated memo/exhibit are byte-for-byte the same as what the matrix UI
// shows — they cannot drift because there is one query.
//
// Every value is computed from STORED structured data (no LLM). A value is only
// ever returned when it can be cited (non-null value AND a source_url); an
// uncited or value-less metric is simply absent. Nothing is fabricated.
// ============================================================================

export type ColumnSource = "settlement" | "provision";
export type ColumnKind = "pct" | "money" | "count" | "years" | "bool" | "text";

export interface ColumnDef {
  id: string;
  label: string;
  source: ColumnSource;
  kind: ColumnKind;
  unit: string | null;
  // settlement: the snake_case DB column; provision: the provision_key.
  field: string;
  group: string;
}

export const COLUMN_CATALOG: ColumnDef[] = [
  {
    id: "settlement.base_increase_pct",
    label: "Base increase — yr 1",
    source: "settlement",
    kind: "pct",
    unit: "%",
    field: "base_increase_pct",
    group: "Salary settlement",
  },
  {
    id: "settlement.year2_pct",
    label: "Base increase — yr 2",
    source: "settlement",
    kind: "pct",
    unit: "%",
    field: "year2_pct",
    group: "Salary settlement",
  },
  {
    id: "settlement.year3_pct",
    label: "Base increase — yr 3",
    source: "settlement",
    kind: "pct",
    unit: "%",
    field: "year3_pct",
    group: "Salary settlement",
  },
  {
    id: "settlement.off_schedule_payment",
    label: "Off-schedule / lump sum",
    source: "settlement",
    kind: "money",
    unit: "$",
    field: "off_schedule_payment",
    group: "Salary settlement",
  },
  {
    id: "settlement.term_years",
    label: "Contract term",
    source: "settlement",
    kind: "years",
    unit: "yr",
    field: "term_years",
    group: "Salary settlement",
  },
  {
    id: "settlement.insurance_changed",
    label: "Insurance changed",
    source: "settlement",
    kind: "bool",
    unit: null,
    field: "insurance_changed",
    group: "Salary settlement",
  },
  {
    id: "settlement.method",
    label: "Settlement method",
    source: "settlement",
    kind: "text",
    unit: null,
    field: "method",
    group: "Salary settlement",
  },
  {
    id: "provision.ba_min_salary",
    label: "BA min salary",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "ba_min_salary",
    group: "Salary schedule",
  },
  {
    id: "provision.ba_max_salary",
    label: "BA max salary",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "ba_max_salary",
    group: "Salary schedule",
  },
  {
    id: "provision.ma_min_salary",
    label: "MA min salary",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "ma_min_salary",
    group: "Salary schedule",
  },
  {
    id: "provision.ma_max_salary",
    label: "MA max salary",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "ma_max_salary",
    group: "Salary schedule",
  },
  {
    id: "provision.salary_steps_count",
    label: "Salary steps",
    source: "provision",
    kind: "count",
    unit: null,
    field: "salary_steps_count",
    group: "Salary schedule",
  },
  {
    id: "provision.salary_lanes_count",
    label: "Salary lanes",
    source: "provision",
    kind: "count",
    unit: null,
    field: "salary_lanes_count",
    group: "Salary schedule",
  },
  {
    id: "provision.off_schedule_bonus_yr1",
    label: "Off-schedule bonus — yr 1",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "off_schedule_bonus_yr1",
    group: "Salary schedule",
  },
];

export const CATALOG_BY_ID = new Map(COLUMN_CATALOG.map((c) => [c.id, c]));

export const DEFAULT_COLUMN_IDS = [
  "settlement.base_increase_pct",
  "settlement.year2_pct",
  "settlement.year3_pct",
  "settlement.off_schedule_payment",
  "settlement.term_years",
  "provision.ba_min_salary",
  "provision.ma_min_salary",
  "provision.salary_steps_count",
];

// Bound the matrix so one request can't fan out into an unbounded scan.
export const MAX_DISTRICTS = 60;

export function publicColumn(c: ColumnDef) {
  return {
    id: c.id,
    label: c.label,
    source: c.source,
    kind: c.kind,
    unit: c.unit,
    group: c.group,
  };
}

export type PublicColumn = ReturnType<typeof publicColumn>;

export interface Cell {
  value: number | string | boolean;
  kind: ColumnKind;
  unit: string | null;
  confidence: number | null;
  humanVerified: boolean;
  verifiedBy: string | null;
  provisionId: number | null;
  settlementId: number | null;
  clauseExcerpt: string | null;
  pageRef: number | null;
  sourceUrl: string | null;
  retrievedAt: string | null;
}

export interface MatrixDistrict {
  districtId: number;
  name: string;
  county: string | null;
  districtType: string | null;
  enrollment: number | null;
  state: string;
  role: string | null;
}

export interface MatrixPayload {
  bargainingUnit: string;
  matterId: number | null;
  matterName: string | null;
  districts: MatrixDistrict[];
  columns: PublicColumn[];
  catalog: PublicColumn[];
  cells: Record<string, Record<string, Cell>>;
}

export type MatrixResult =
  | { ok: true; data: MatrixPayload }
  | { ok: false; status: number; error: string; message?: string };

export interface BuildMatrixOpts {
  // matterId XOR districtIds — exactly one must be provided.
  matterId?: number | null;
  districtIds?: number[] | null;
  unit: string;
  columnIds: string[];
}

// Resolve + authorize the district set and compute every cited cell. Auth lives
// here (not just in the route) so the export builders enforce the same firm
// scope: a cross-firm matter id is a 404 (no existence leak) and an explicit id
// outside the firm scope is a 403 (FORBIDDEN_DISTRICT).
export async function buildMatrix(
  firmId: number,
  opts: BuildMatrixOpts,
): Promise<MatrixResult> {
  const { unit } = opts;
  const columns = opts.columnIds.map((id) => CATALOG_BY_ID.get(id)!);

  // Resolve the district set + authorize it against the firm.
  const districtRoles = new Map<number, string | null>();
  let matterId: number | null = null;
  let matterName: string | null = null;

  if (opts.matterId != null) {
    const mid = opts.matterId;
    const m = await db.execute(sql`
      SELECT id, name FROM matters
      WHERE id = ${mid} AND firm_id = ${firmId}
      LIMIT 1
    `);
    if (m.rows.length === 0) {
      return { ok: false, status: 404, error: "Matter not found" };
    }
    matterId = mid;
    matterName = String((m.rows[0] as { name: unknown }).name);
    const r = await db.execute(sql`
      SELECT district_id, role FROM matter_districts WHERE matter_id = ${mid}
    `);
    for (const row of r.rows as Array<{ district_id: unknown; role: unknown }>) {
      districtRoles.set(Number(row.district_id), String(row.role));
    }
  } else if (opts.districtIds != null) {
    const ids = opts.districtIds;
    const scope = await firmScopeDistrictIds(firmId);
    for (const id of ids) {
      if (!scope.has(id)) {
        return {
          ok: false,
          status: 403,
          error: "FORBIDDEN_DISTRICT",
          message: "One or more districts are outside your workspace.",
        };
      }
      districtRoles.set(id, null);
    }
  } else {
    return { ok: false, status: 400, error: "Provide a matterId or districtIds." };
  }

  const districtIds = [...districtRoles.keys()];
  if (districtIds.length === 0) {
    return {
      ok: true,
      data: {
        bargainingUnit: unit,
        matterId,
        matterName,
        districts: [],
        columns: columns.map(publicColumn),
        catalog: COLUMN_CATALOG.map(publicColumn),
        cells: {},
      },
    };
  }
  if (districtIds.length > MAX_DISTRICTS) {
    return {
      ok: false,
      status: 400,
      error: `Too many districts (max ${MAX_DISTRICTS}).`,
    };
  }

  const idList = sql.join(
    districtIds.map((id) => sql`${id}`),
    sql`, `,
  );

  // District metadata for the rows. Ordered client → peer → alpha so the
  // matter's client district leads the matrix.
  const dmeta = await db.execute(sql`
    SELECT id, name, county, district_type, enrollment, state
    FROM districts WHERE id IN (${idList})
  `);
  const districts: MatrixDistrict[] = (
    dmeta.rows as Array<{
      id: unknown;
      name: unknown;
      county: unknown;
      district_type: unknown;
      enrollment: unknown;
      state: unknown;
    }>
  )
    .map((row) => ({
      districtId: Number(row.id),
      name: String(row.name),
      county: row.county == null ? null : String(row.county),
      districtType:
        row.district_type == null ? null : String(row.district_type),
      enrollment: row.enrollment == null ? null : Number(row.enrollment),
      state: String(row.state ?? ""),
      role: districtRoles.get(Number(row.id)) ?? null,
    }))
    .sort((a, b) => {
      const rank = (r: string | null) =>
        r === "client" ? 0 : r === "peer" ? 1 : 2;
      const rr = rank(a.role) - rank(b.role);
      return rr !== 0 ? rr : a.name.localeCompare(b.name);
    });

  const cells: Record<string, Record<string, Cell>> = {};

  // --- Provision cells ---------------------------------------------------
  const provColumns = columns.filter((c) => c.source === "provision");
  if (provColumns.length > 0) {
    const keyList = sql.join(
      provColumns.map((c) => sql`${c.field}`),
      sql`, `,
    );
    const r = await db.execute(sql`
      WITH latest_contract AS (
        SELECT DISTINCT ON (c.district_id)
          c.id, c.district_id, c.source_doc_id
        FROM contracts c
        WHERE c.district_id IN (${idList})
          AND c.bargaining_unit = ${unit}
        ORDER BY c.district_id,
                 c.effective_end DESC NULLS LAST,
                 c.effective_start DESC NULLS LAST,
                 c.id DESC
      )
      SELECT DISTINCT ON (lc.district_id, cp.provision_key)
        lc.district_id,
        cp.id AS provision_id,
        cp.provision_key,
        cp.value_numeric,
        cp.value_text,
        cp.unit,
        cp.clause_excerpt,
        cp.page_ref,
        cp.confidence,
        cp.human_verified,
        sd.source_url,
        sd.retrieved_at
      FROM latest_contract lc
      JOIN contract_provisions cp ON cp.contract_id = lc.id
      JOIN source_documents sd ON sd.id = lc.source_doc_id
      WHERE cp.provision_key IN (${keyList})
        AND (
          cp.value_numeric IS NOT NULL
          OR (cp.value_text IS NOT NULL AND btrim(cp.value_text) <> '')
        )
        AND sd.source_url IS NOT NULL
        AND cp.clause_excerpt IS NOT NULL
        AND btrim(cp.clause_excerpt) <> ''
      ORDER BY lc.district_id, cp.provision_key,
               cp.human_verified DESC NULLS LAST,
               cp.confidence DESC NULLS LAST,
               cp.id DESC
    `);
    const provByField = new Map(provColumns.map((c) => [c.field, c]));
    for (const row of r.rows as Array<Record<string, unknown>>) {
      const col = provByField.get(String(row.provision_key));
      if (!col) continue;
      const did = Number(row.district_id);
      const valueNumeric =
        row.value_numeric == null ? null : Number(row.value_numeric);
      const value =
        valueNumeric != null ? valueNumeric : String(row.value_text);
      const cell: Cell = {
        value,
        kind: col.kind,
        unit: col.unit,
        confidence: row.confidence == null ? null : Number(row.confidence),
        humanVerified: row.human_verified === true,
        verifiedBy: null,
        provisionId: Number(row.provision_id),
        settlementId: null,
        clauseExcerpt:
          row.clause_excerpt == null ? null : String(row.clause_excerpt),
        pageRef: row.page_ref == null ? null : Number(row.page_ref),
        sourceUrl: row.source_url == null ? null : String(row.source_url),
        retrievedAt:
          row.retrieved_at == null ? null : String(row.retrieved_at),
      };
      (cells[did] ??= {})[col.id] = cell;
    }
  }

  // --- Settlement cells --------------------------------------------------
  const setColumns = columns.filter((c) => c.source === "settlement");
  if (setColumns.length > 0) {
    const r = await db.execute(sql`
      WITH latest_settlement AS (
        SELECT DISTINCT ON (s.district_id)
          s.id, s.district_id,
          s.base_increase_pct, s.year2_pct, s.year3_pct,
          s.off_schedule_payment, s.term_years, s.insurance_changed, s.method,
          s.confidence, s.human_verified, s.verified_by, s.page_ref,
          s.source_doc_id
        FROM settlements s
        WHERE s.district_id IN (${idList})
          AND s.bargaining_unit = ${unit}
        ORDER BY s.district_id,
                 COALESCE(s.to_year, s.from_year) DESC NULLS LAST,
                 s.id DESC
      )
      SELECT
        ls.id, ls.district_id,
        ls.base_increase_pct, ls.year2_pct, ls.year3_pct,
        ls.off_schedule_payment, ls.term_years, ls.insurance_changed, ls.method,
        ls.confidence, ls.human_verified, ls.verified_by, ls.page_ref,
        sd.source_url, sd.retrieved_at
      FROM latest_settlement ls
      LEFT JOIN source_documents sd ON sd.id = ls.source_doc_id
    `);
    for (const row of r.rows as Array<Record<string, unknown>>) {
      const did = Number(row.district_id);
      const sourceUrl =
        row.source_url == null ? null : String(row.source_url);
      if (!sourceUrl) continue; // citation mandatory
      for (const col of setColumns) {
        const raw = row[col.field];
        if (raw == null) continue;
        let value: number | string | boolean;
        if (col.kind === "bool") {
          value = raw === true;
        } else if (col.kind === "text") {
          const s = String(raw).trim();
          if (!s) continue;
          value = s;
        } else {
          value = Number(raw);
        }
        const cell: Cell = {
          value,
          kind: col.kind,
          unit: col.unit,
          confidence: row.confidence == null ? null : Number(row.confidence),
          humanVerified: row.human_verified === true,
          verifiedBy: row.verified_by == null ? null : String(row.verified_by),
          provisionId: null,
          settlementId: Number(row.id),
          clauseExcerpt: null,
          pageRef: row.page_ref == null ? null : Number(row.page_ref),
          sourceUrl,
          retrievedAt:
            row.retrieved_at == null ? null : String(row.retrieved_at),
        };
        (cells[did] ??= {})[col.id] = cell;
      }
    }
  }

  return {
    ok: true,
    data: {
      bargainingUnit: unit,
      matterId,
      matterName,
      districts,
      columns: columns.map(publicColumn),
      catalog: COLUMN_CATALOG.map(publicColumn),
      cells,
    },
  };
}
