import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { firmScopeDistrictIds } from "./firm-scope.js";
import { CUSTOMER_STATE } from "./dashboard-query.js";

// ============================================================================
// Shared data model for firm clause retrieval (Phase 4).
//
// The single source of truth for the firm-scoped clause SQL: scope resolution +
// authorization, the "latest contract per district" anchor, the verbatim-clause
// row mapping, and the side-by-side clause-compare query. Both the live
// clause-search / clause-compare routes AND the Phase 5 clause-appendix export
// builder call these so a generated appendix renders byte-for-byte the same
// verbatim clauses and citations the UI shows — they cannot drift.
//
// Everything stays inside the firm's scope (roster ∪ matter districts) so every
// returned clause's source PDF is reachable. No clause language is ever
// invented; only stored contract_provisions.clause_excerpt rows with a citable
// source_url are returned.
// ============================================================================

export const MAX_DISTRICTS = 60;
export const MAX_KEY_LEN = 80;
// Upper bound on districts returned by the whole-state ("database") compare. The
// CUSTOMER_STATE corpus is well under this today (≈175 IL teacher districts); it
// exists only as future protection against an unbounded payload, never to
// silently truncate a realistic comparison.
export const DATABASE_MAX_CLAUSES = 500;

export type ClauseScope =
  | "matter"
  | "tracked"
  | "explicit"
  | "all"
  | "database";
export function parseScope(v: unknown): ClauseScope {
  return v === "matter" ||
    v === "tracked" ||
    v === "explicit" ||
    v === "all" ||
    v === "database"
    ? v
    : "all";
}

export function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function prettyKey(key: string | null): string {
  if (!key) return "";
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// A resolved clause scope is either a bounded set of district ids (matter /
// tracked / all / explicit — every district inside the firm's own workspace) or
// the whole customer-state corpus ("database"). The two are queried differently
// (district IN-list vs. d.state filter), so the discriminant is carried through
// to query construction; "database" is never represented as districtIds=[].
export type ScopeResult =
  | {
      kind: "districts";
      districtIds: number[];
      matterId: number | null;
      matterName: string | null;
    }
  | { kind: "state"; state: string; matterId: null; matterName: null };
export type ScopeOutcome =
  | { ok: true; scope: ScopeResult }
  | { ok: false; status: number; error: string };

// Resolve + AUTHORIZE the scope for a clause request. The workspace scopes
// (matter/tracked/all/explicit) stay inside the firm's own districts so every
// returned clause has a reachable source PDF. A cross-firm matter id is a 404
// (no existence leak); an explicit id outside the firm scope is a 403; the whole
// request is rejected rather than silently dropping ids (a silent drop would
// hide an authorization mistake). The "database" scope is the entire
// CUSTOMER_STATE corpus — authorized purely by firm membership (the caller is
// already past requireFirmSession) and bounded to CUSTOMER_STATE so the
// deliberately-hidden non-IL rows never surface.
export async function resolveScope(
  firmId: number,
  scope: ClauseScope,
  matterId: number | null,
  districtIds: number[] | null,
): Promise<ScopeOutcome> {
  if (scope === "matter") {
    if (matterId == null) {
      return {
        ok: false,
        status: 400,
        error: "matterId is required for the matter scope.",
      };
    }
    const m = await db.execute(sql`
      SELECT id, name FROM matters
      WHERE id = ${matterId} AND firm_id = ${firmId}
      LIMIT 1
    `);
    const row = m.rows[0] as { id: unknown; name: unknown } | undefined;
    if (!row) return { ok: false, status: 404, error: "Matter not found." };
    const d = await db.execute(sql`
      SELECT district_id FROM matter_districts WHERE matter_id = ${matterId}
    `);
    const ids = (d.rows as Array<{ district_id: unknown }>).map((r) =>
      Number(r.district_id),
    );
    return {
      ok: true,
      scope: {
        kind: "districts",
        districtIds: ids,
        matterId: Number(row.id),
        matterName: String(row.name),
      },
    };
  }

  if (scope === "tracked") {
    const r = await db.execute(sql`
      SELECT district_id FROM tracked_districts WHERE firm_id = ${firmId}
    `);
    const ids = (r.rows as Array<{ district_id: unknown }>).map((row) =>
      Number(row.district_id),
    );
    return {
      ok: true,
      scope: {
        kind: "districts",
        districtIds: ids,
        matterId: null,
        matterName: null,
      },
    };
  }

  if (scope === "all") {
    const all = await firmScopeDistrictIds(firmId);
    return {
      ok: true,
      scope: {
        kind: "districts",
        districtIds: [...all],
        matterId: null,
        matterName: null,
      },
    };
  }

  if (scope === "database") {
    return {
      ok: true,
      scope: {
        kind: "state",
        state: CUSTOMER_STATE,
        matterId: null,
        matterName: null,
      },
    };
  }

  // explicit
  if (!districtIds || districtIds.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "districtIds is required for the explicit scope.",
    };
  }
  const firmScope = await firmScopeDistrictIds(firmId);
  const outside = districtIds.filter((id) => !firmScope.has(id));
  if (outside.length > 0) {
    return {
      ok: false,
      status: 403,
      error: "One or more districts are outside your workspace.",
    };
  }
  return {
    ok: true,
    scope: {
      kind: "districts",
      districtIds,
      matterId: null,
      matterName: null,
    },
  };
}

export interface ClauseRow {
  provisionId: number;
  districtId: number;
  districtName: string;
  county: string | null;
  state: string;
  category: string | null;
  provisionKey: string | null;
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;
  clauseExcerpt: string;
  pageRef: number | null;
  confidence: number | null;
  humanVerified: boolean;
  sourceUrl: string | null;
  retrievedAt: string | null;
  rank?: number;
}

export function mapClauseRow(row: Record<string, unknown>): ClauseRow {
  return {
    provisionId: Number(row.provision_id),
    districtId: Number(row.district_id),
    districtName: String(row.district_name ?? ""),
    county: row.county == null ? null : String(row.county),
    state: String(row.state ?? ""),
    category: row.category == null ? null : String(row.category),
    provisionKey: row.provision_key == null ? null : String(row.provision_key),
    valueNumeric: row.value_numeric == null ? null : Number(row.value_numeric),
    valueText: row.value_text == null ? null : String(row.value_text),
    unit: row.unit == null ? null : String(row.unit),
    clauseExcerpt: String(row.clause_excerpt ?? ""),
    pageRef: row.page_ref == null ? null : Number(row.page_ref),
    confidence: row.confidence == null ? null : Number(row.confidence),
    humanVerified: row.human_verified === true,
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    retrievedAt: row.retrieved_at == null ? null : String(row.retrieved_at),
    rank: row.rank == null ? undefined : Number(row.rank),
  };
}

// The latest contract per district for a bargaining unit (the same precedence
// the comparison matrix uses): newest effective_end, then effective_start, then
// id. Anchors which contract_provisions rows we read so we never surface a stale
// prior contract's clause.
export function latestContractCte(
  idList: ReturnType<typeof sql>,
  unit: string,
) {
  return sql`
    SELECT DISTINCT ON (c.district_id)
      c.id, c.district_id, c.source_doc_id
    FROM contracts c
    WHERE c.district_id IN (${idList})
      AND c.bargaining_unit = ${unit}
    ORDER BY c.district_id,
             c.effective_end DESC NULLS LAST,
             c.effective_start DESC NULLS LAST,
             c.id DESC
  `;
}

// The whole-state variant of latestContractCte for the "database" scope: the
// latest contract per district across every district in `state`, with the exact
// same per-district precedence. Used instead of the district IN-list so the
// "Entire database" scope never has to enumerate (and cap at MAX_DISTRICTS) the
// full CUSTOMER_STATE corpus.
export function latestContractCteForState(unit: string, state: string) {
  return sql`
    SELECT DISTINCT ON (c.district_id)
      c.id, c.district_id, c.source_doc_id
    FROM contracts c
    JOIN districts d ON d.id = c.district_id
    WHERE d.state = ${state}
      AND c.bargaining_unit = ${unit}
    ORDER BY c.district_id,
             c.effective_end DESC NULLS LAST,
             c.effective_start DESC NULLS LAST,
             c.id DESC
  `;
}

export interface AvailableType {
  category: string | null;
  provisionKey: string;
  districtCount: number;
}

export interface ClauseCompareData {
  matterId: number | null;
  matterName: string | null;
  availableTypes: AvailableType[];
  clauses: ClauseRow[];
}

export type ClauseCompareResult =
  | { ok: true; data: ClauseCompareData }
  | { ok: false; status: number; error: string };

export interface BuildClauseCompareOpts {
  scope: ClauseScope;
  matterId: number | null;
  districtIds: number[] | null;
  unit: string;
  provisionKey: string | null;
}

// The data half of POST /firm/clause-compare (no LLM synthesis — that is a
// route-only, best-effort layer over this result). Always returns the provision
// types available in scope; when provisionKey is given, also the best (verbatim)
// clause per district with full provenance, ordered by district name.
export async function buildClauseCompare(
  firmId: number,
  opts: BuildClauseCompareOpts,
): Promise<ClauseCompareResult> {
  const outcome = await resolveScope(
    firmId,
    opts.scope,
    opts.matterId,
    opts.districtIds,
  );
  if (!outcome.ok) {
    return { ok: false, status: outcome.status, error: outcome.error };
  }
  const scope = outcome.scope;
  const matterId = scope.matterId;
  const matterName = scope.matterName;

  // The bounded workspace scopes carry an explicit id set, so they short-circuit
  // on an empty list and reject anything over MAX_DISTRICTS. The whole-state
  // "database" scope intentionally skips both: it spans the entire CUSTOMER_STATE
  // corpus and is bounded by DATABASE_MAX_CLAUSES on the compare query instead.
  if (scope.kind === "districts") {
    if (scope.districtIds.length === 0) {
      return {
        ok: true,
        data: { matterId, matterName, availableTypes: [], clauses: [] },
      };
    }
    if (scope.districtIds.length > MAX_DISTRICTS) {
      return {
        ok: false,
        status: 400,
        error: `Too many districts in scope (max ${MAX_DISTRICTS}).`,
      };
    }
  }

  const contractCte =
    scope.kind === "state"
      ? latestContractCteForState(opts.unit, scope.state)
      : latestContractCte(
          sql.join(
            scope.districtIds.map((id) => sql`${id}`),
            sql`, `,
          ),
          opts.unit,
        );

  // The provision types actually present across the scoped districts' latest
  // contracts (drives the picker). Count = districts carrying each type.
  const typesRes = await db.execute(sql`
    WITH latest_contract AS (${contractCte})
    SELECT cp.category, cp.provision_key,
           count(DISTINCT lc.district_id) AS district_count
    FROM latest_contract lc
    JOIN contract_provisions cp ON cp.contract_id = lc.id
    JOIN source_documents sd ON sd.id = lc.source_doc_id
    WHERE cp.provision_key IS NOT NULL
      AND cp.clause_excerpt IS NOT NULL
      AND btrim(cp.clause_excerpt) <> ''
      AND sd.source_url IS NOT NULL
    GROUP BY cp.category, cp.provision_key
    ORDER BY district_count DESC, cp.provision_key ASC
  `);
  const availableTypes: AvailableType[] = (
    typesRes.rows as Array<Record<string, unknown>>
  ).map((row) => ({
    category: row.category == null ? null : String(row.category),
    provisionKey: String(row.provision_key),
    districtCount: Number(row.district_count),
  }));

  let clauses: ClauseRow[] = [];
  if (opts.provisionKey) {
    const cmp = await db.execute(sql`
      WITH latest_contract AS (${contractCte})
      SELECT DISTINCT ON (lc.district_id)
        lc.district_id,
        d.name AS district_name,
        d.county,
        d.state,
        cp.id AS provision_id,
        cp.category,
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
      JOIN districts d ON d.id = lc.district_id
      JOIN source_documents sd ON sd.id = lc.source_doc_id
      WHERE cp.provision_key = ${opts.provisionKey}
        AND cp.clause_excerpt IS NOT NULL
        AND btrim(cp.clause_excerpt) <> ''
        AND sd.source_url IS NOT NULL
      ORDER BY lc.district_id,
               cp.human_verified DESC NULLS LAST,
               cp.confidence DESC NULLS LAST,
               cp.id DESC
      ${scope.kind === "state" ? sql`LIMIT ${DATABASE_MAX_CLAUSES}` : sql``}
    `);
    clauses = (cmp.rows as Array<Record<string, unknown>>).map(mapClauseRow);
    // Stable side-by-side order: by district name.
    clauses.sort((a, b) => a.districtName.localeCompare(b.districtName));
  }

  return {
    ok: true,
    data: { matterId, matterName, availableTypes, clauses },
  };
}
