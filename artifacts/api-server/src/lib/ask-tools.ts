import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { parseUnit } from "../routes/bargaining-units.js";
import { CUSTOMER_STATE, bandSql, buildWhere } from "./dashboard-query.js";

// ---------------------------------------------------------------------------
// AI "ask" retrieval tools.
//
// These are the ONLY way the assistant can read data. Each executor runs real,
// parameterised SQL scoped to the customer-facing state (Illinois) and returns
// two things:
//   - `data`: trimmed real rows handed back to the model so it can compose a
//     grounded prose answer (it must never invent figures).
//   - `results`: typed, clickable result cards assembled SERVER-SIDE from those
//     same rows, each with a deep link into the dashboard. The model never
//     produces ids or links, so every card points at a real record.
// ---------------------------------------------------------------------------

export type AskResultType =
  | "district"
  | "settlement"
  | "clause"
  | "comparables"
  | "factfinding"
  | "final_offer";

export interface AskResult {
  type: AskResultType;
  /** District id the card resolves to (used for the deep link). */
  id: number;
  label: string;
  snippet: string;
  path: string;
}

export interface ToolOutput {
  /** Compact rows the model uses to write the answer. */
  data: unknown;
  /** Clickable, grounded result cards assembled from the rows. */
  results: AskResult[];
}

const PROVISION_CATEGORIES = new Set([
  "compensation",
  "insurance",
  "retirement",
  "leave",
  "workday",
  "evaluation",
  "rif",
  "grievance",
  "other",
]);
const BANDS = new Set(["tiny", "small", "medium", "large", "xlarge"]);

const MAX_TOOL_LIMIT = 10;

function clampLimit(raw: unknown, fallback = 8): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_TOOL_LIMIT, Math.max(1, Math.floor(n)));
}

function asTrimmedString(raw: unknown, maxLen = 120): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

function asYear(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1990 || n > 2100) return null;
  return Math.floor(n);
}

function asPct(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n) || n < -50 || n > 100) return null;
  return n;
}

function likePattern(raw: unknown): string | null {
  const s = asTrimmedString(raw, 80);
  if (!s) return null;
  return `%${s}%`;
}

// ---------------------------------------------------------------------------
// Tool definitions handed to the Anthropic API (input_schema is JSON Schema).
// ---------------------------------------------------------------------------
export const ASK_TOOL_DEFS = [
  {
    name: "search_districts",
    description:
      "Find Illinois school districts by name or county, optionally filtered by enrollment size band, district type, or by the calendar year a current contract expires. Use for questions like 'who has a contract expiring in 2026?' or 'find districts in Cook county'.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Substring match on district name or county." },
        county: { type: "string", description: "Exact county name." },
        band: {
          type: "string",
          enum: ["tiny", "small", "medium", "large", "xlarge"],
          description: "Enrollment size band: tiny <500, small 500-999, medium 1000-2499, large 2500-4999, xlarge >=5000.",
        },
        district_type: { type: "string", description: "Exact district type (e.g. 'Unit', 'Elementary', 'High School')." },
        contract_expires_year: { type: "integer", description: "4-digit year a contract's effective_end falls in." },
        limit: { type: "integer", description: "Max rows (1-10, default 8)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_settlements",
    description:
      "Find specific salary settlement records (base increase % by year) across Illinois districts, filtered by county, enrollment band, district type, bargaining unit, settlement start year range, and base increase percentage range. Use for 'which districts settled above 4% last year?'.",
    input_schema: {
      type: "object" as const,
      properties: {
        district_name: { type: "string", description: "Substring match on district name." },
        county: { type: "string", description: "Exact county name." },
        band: { type: "string", enum: ["tiny", "small", "medium", "large", "xlarge"] },
        district_type: { type: "string" },
        bargaining_unit: { type: "string", description: "e.g. 'teachers' (default), 'support_staff'." },
        min_base_pct: { type: "number", description: "Minimum first-year base increase %." },
        max_base_pct: { type: "number", description: "Maximum first-year base increase %." },
        start_year_min: { type: "integer", description: "Earliest 4-digit settlement start year." },
        start_year_max: { type: "integer", description: "Latest 4-digit settlement start year." },
        limit: { type: "integer", description: "Max rows (1-10, default 8)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_provisions",
    description:
      "Find contract clauses/provisions (e.g. TRS pickup, insurance contributions, leave days) across Illinois districts by category and/or keyword. Use for 'show me teacher contracts with TRS pickup'.",
    input_schema: {
      type: "object" as const,
      properties: {
        keyword: { type: "string", description: "Substring match on provision key, clause text, or value text (e.g. 'TRS pickup')." },
        category: {
          type: "string",
          enum: ["compensation", "insurance", "retirement", "leave", "workday", "evaluation", "rif", "grievance", "other"],
        },
        county: { type: "string", description: "Exact county name." },
        district_name: { type: "string", description: "Substring match on district name." },
        limit: { type: "integer", description: "Max rows (1-10, default 8)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_comparables",
    description:
      "Compute median and average teacher (or other unit) base increase across a peer group of Illinois districts defined by county, enrollment band, district type, and start year range. Returns aggregate statistics plus the matching districts. Use for 'what's the median settlement for large suburban districts?'.",
    input_schema: {
      type: "object" as const,
      properties: {
        county: { type: "string" },
        band: { type: "string", enum: ["tiny", "small", "medium", "large", "xlarge"] },
        district_type: { type: "string" },
        bargaining_unit: { type: "string", description: "Default 'teachers'." },
        start_year_min: { type: "integer" },
        start_year_max: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_factfinding",
    description:
      "Find fact-finding / interest-arbitration reports (employer vs union proposals and the fact-finder's recommended %) across Illinois districts, filtered by district name or county. Use for questions about fact-finding cases or arbitration recommendations.",
    input_schema: {
      type: "object" as const,
      properties: {
        district_name: { type: "string", description: "Substring match on district name." },
        county: { type: "string", description: "Exact county name." },
        limit: { type: "integer", description: "Max rows (1-10, default 8)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_final_offers",
    description:
      "Find ELRB interest-arbitration final-offer cases where an Illinois district and its union posted competing 'final offers', then surface where the board and the union still DISAGREE (and where they already agree), topic by topic. Each topic shows the board position, the union position, and the numeric gap (union minus district) when both are quantitative. Use for 'where do Rockford's board and union still disagree?', 'what's the salary gap in the latest final offers?', or 'which districts have open final-offer disputes on insurance?'.",
    input_schema: {
      type: "object" as const,
      properties: {
        district_name: { type: "string", description: "Substring match on district name." },
        county: { type: "string", description: "Exact county name." },
        topic: {
          type: "string",
          enum: [
            "salary", "insurance", "retirement", "stipends", "leave", "workday",
            "work_year", "class_size", "evaluation", "grievance", "layoff_rif",
            "seniority", "term", "other",
          ],
          description: "Restrict to one bargaining topic (e.g. 'salary', 'insurance').",
        },
        diffs_only: { type: "boolean", description: "If true, only return topics where the sides disagree." },
        limit: { type: "integer", description: "Max cases (1-10, default 8)." },
      },
      additionalProperties: false,
    },
  },
];

export const ASK_TOOL_NAMES = new Set(ASK_TOOL_DEFS.map((t) => t.name));

// Plain-English labels for the step indicator the client shows while a tool is
// running. Keyed by the real tool name so the UI describes the actual work in
// progress (e.g. "Looking up settlements…") instead of a generic spinner.
export const ASK_TOOL_LABELS: Record<string, string> = {
  search_districts: "Searching districts…",
  search_settlements: "Looking up settlements…",
  search_provisions: "Checking contract clauses…",
  get_comparables: "Comparing peer districts…",
  search_factfinding: "Reviewing fact-finding reports…",
  search_final_offers: "Comparing board vs union final offers…",
};

// ---------------------------------------------------------------------------
// Deep-link builders. Paths are relative to the SPA base; the frontend feeds
// them straight to wouter's navigation (which is mounted at BASE_URL).
// ---------------------------------------------------------------------------
function qs(params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") p.set(k, v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

function districtPath(id: number): string {
  return `/dashboard/${id}`;
}
function clausesPath(id: number, category: string | null, keyword: string | null): string {
  return `/dashboard/${id}/clauses${qs({ category, q: keyword })}`;
}
function comparablesPath(
  id: number,
  filters: {
    county?: string | null;
    band?: string | null;
    districtType?: string | null;
    yearFrom?: number | null;
    yearTo?: number | null;
  },
): string {
  return `/dashboard/${id}/comparables${qs({
    county: filters.county ?? null,
    band: filters.band ?? null,
    districtType: filters.districtType ?? null,
    yearFrom: filters.yearFrom != null ? String(filters.yearFrom) : null,
    yearTo: filters.yearTo != null ? String(filters.yearTo) : null,
  })}`;
}
function factfindingPath(id: number): string {
  return `/dashboard/${id}/ask-vs-got`;
}
function finalOffersPath(id: number): string {
  return `/dashboard/${id}/final-offers`;
}

// Status labels used in the data handed to the model so it can describe the
// state of each topic in plain English.
const FINAL_OFFER_STATUS_LABEL: Record<string, string> = {
  diff: "still in dispute",
  aligned: "agreed",
  district_only: "raised only by the board",
  union_only: "raised only by the union",
};

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

type Input = Record<string, unknown>;

async function searchDistricts(input: Input): Promise<ToolOutput> {
  const limit = clampLimit(input.limit);
  const query = likePattern(input.query);
  const county = asTrimmedString(input.county);
  const band = asTrimmedString(input.band);
  const districtType = asTrimmedString(input.district_type);
  const expiresYear = asYear(input.contract_expires_year);

  const conds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    query ? sql`(d.name ILIKE ${query} OR d.county ILIKE ${query})` : null,
    county ? sql`d.county = ${county}` : null,
    districtType ? sql`d.district_type = ${districtType}` : null,
    band && BANDS.has(band) ? bandSql(band) : null,
  ];

  if (expiresYear != null) {
    conds.push(sql`DATE_PART('year', c.effective_end::date) = ${expiresYear}`);
    const where = buildWhere(conds);
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (d.id)
        d.id, d.name, d.county, d.district_type, d.enrollment,
        c.union_name, c.effective_end
      FROM districts d
      JOIN contracts c ON c.district_id = d.id
      WHERE ${where} AND c.effective_end IS NOT NULL
      ORDER BY d.id, c.effective_end DESC
      LIMIT ${limit}
    `);
    const data = rows.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        district_id: Number(row.id),
        name: row.name,
        county: row.county,
        district_type: row.district_type,
        enrollment: row.enrollment,
        union_name: row.union_name,
        contract_expires: row.effective_end,
      };
    });
    const results: AskResult[] = data.map((d) => ({
      type: "district" as const,
      id: d.district_id,
      label: String(d.name),
      snippet: `${d.county ? d.county + " County · " : ""}contract expires ${d.contract_expires}`,
      path: districtPath(d.district_id),
    }));
    return { data, results };
  }

  const where = buildWhere(conds);
  const rows = await db.execute(sql`
    SELECT d.id, d.name, d.county, d.district_type, d.enrollment
    FROM districts d
    WHERE ${where}
    ORDER BY d.name
    LIMIT ${limit}
  `);
  const data = rows.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      district_id: Number(row.id),
      name: row.name,
      county: row.county,
      district_type: row.district_type,
      enrollment: row.enrollment,
    };
  });
  const results: AskResult[] = data.map((d) => ({
    type: "district" as const,
    id: d.district_id,
    label: String(d.name),
    snippet: `${d.county ? d.county + " County" : "Illinois"}${d.district_type ? " · " + d.district_type : ""}${d.enrollment ? " · " + Number(d.enrollment).toLocaleString() + " students" : ""}`,
    path: districtPath(d.district_id),
  }));
  return { data, results };
}

async function searchSettlements(input: Input): Promise<ToolOutput> {
  const limit = clampLimit(input.limit);
  const unit = parseUnit(input.bargaining_unit);
  const districtName = likePattern(input.district_name);
  const county = asTrimmedString(input.county);
  const band = asTrimmedString(input.band);
  const districtType = asTrimmedString(input.district_type);
  const minPct = asPct(input.min_base_pct);
  const maxPct = asPct(input.max_base_pct);
  const yearMin = asYear(input.start_year_min);
  const yearMax = asYear(input.start_year_max);

  const conds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    sql`s.bargaining_unit = ${unit}`,
    sql`s.base_increase_pct IS NOT NULL`,
    districtName ? sql`d.name ILIKE ${districtName}` : null,
    county ? sql`d.county = ${county}` : null,
    districtType ? sql`d.district_type = ${districtType}` : null,
    band && BANDS.has(band) ? bandSql(band) : null,
    minPct != null ? sql`s.base_increase_pct >= ${minPct}` : null,
    maxPct != null ? sql`s.base_increase_pct <= ${maxPct}` : null,
    yearMin != null ? sql`CAST(LEFT(s.from_year, 4) AS INT) >= ${yearMin}` : null,
    yearMax != null ? sql`CAST(LEFT(s.from_year, 4) AS INT) <= ${yearMax}` : null,
  ];
  const where = buildWhere(conds);

  const rows = await db.execute(sql`
    SELECT s.id, s.from_year, s.to_year, s.base_increase_pct, s.year2_pct, s.year3_pct,
           s.bargaining_unit, s.term_years,
           d.id AS district_id, d.name AS district_name, d.county, d.district_type, d.enrollment
    FROM settlements s
    JOIN districts d ON s.district_id = d.id
    WHERE ${where}
    ORDER BY s.base_increase_pct DESC, s.from_year DESC, d.name
    LIMIT ${limit}
  `);
  const data = rows.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      settlement_id: Number(row.id),
      district_id: Number(row.district_id),
      district_name: row.district_name,
      county: row.county,
      bargaining_unit: row.bargaining_unit,
      from_year: row.from_year,
      to_year: row.to_year,
      base_increase_pct: row.base_increase_pct,
      year2_pct: row.year2_pct,
      year3_pct: row.year3_pct,
    };
  });
  const results: AskResult[] = data.map((s) => ({
    type: "settlement" as const,
    id: s.district_id,
    label: `${s.district_name} — ${s.from_year ?? "?"} settlement`,
    snippet: `${s.base_increase_pct}% base (${s.bargaining_unit})${s.county ? " · " + s.county + " County" : ""}`,
    path: districtPath(s.district_id),
  }));
  return { data, results };
}

async function searchProvisions(input: Input): Promise<ToolOutput> {
  const limit = clampLimit(input.limit);
  const keyword = likePattern(input.keyword);
  const keywordRaw = asTrimmedString(input.keyword, 80);
  const categoryRaw = asTrimmedString(input.category);
  const category = categoryRaw && PROVISION_CATEGORIES.has(categoryRaw) ? categoryRaw : null;
  const county = asTrimmedString(input.county);
  const districtName = likePattern(input.district_name);

  const conds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    category ? sql`cp.category = ${category}` : null,
    keyword
      ? sql`(cp.provision_key ILIKE ${keyword} OR cp.clause_excerpt ILIKE ${keyword} OR cp.value_text ILIKE ${keyword})`
      : null,
    county ? sql`d.county = ${county}` : null,
    districtName ? sql`d.name ILIKE ${districtName}` : null,
  ];
  const where = buildWhere(conds);

  const rows = await db.execute(sql`
    SELECT cp.id, cp.category, cp.provision_key, cp.value_numeric, cp.value_text, cp.unit,
           cp.clause_excerpt, cp.confidence,
           d.id AS district_id, d.name AS district_name, d.county
    FROM contract_provisions cp
    JOIN contracts c ON cp.contract_id = c.id
    JOIN districts d ON c.district_id = d.id
    WHERE ${where}
    ORDER BY d.name, cp.category, cp.provision_key
    LIMIT ${limit}
  `);
  const data = rows.rows.map((r) => {
    const row = r as Record<string, unknown>;
    const valueText =
      row.value_numeric != null
        ? `${row.value_numeric}${row.unit ? " " + row.unit : ""}`
        : (asTrimmedString(row.value_text, 160) ?? null);
    return {
      provision_id: Number(row.id),
      district_id: Number(row.district_id),
      district_name: row.district_name,
      category: row.category,
      provision_key: row.provision_key,
      value: valueText,
      excerpt: asTrimmedString(row.clause_excerpt, 200),
    };
  });
  const results: AskResult[] = data.map((p) => ({
    type: "clause" as const,
    id: p.district_id,
    label: `${p.district_name} — ${String(p.provision_key ?? "").replace(/_/g, " ")}`,
    snippet: `${p.category ?? "clause"}${p.value ? ": " + p.value : ""}`,
    path: clausesPath(p.district_id, (p.category as string) ?? null, keywordRaw),
  }));
  return { data, results };
}

async function getComparables(input: Input): Promise<ToolOutput> {
  const unit = parseUnit(input.bargaining_unit);
  const county = asTrimmedString(input.county);
  const band = asTrimmedString(input.band);
  const districtType = asTrimmedString(input.district_type);
  const yearMin = asYear(input.start_year_min);
  const yearMax = asYear(input.start_year_max);
  const bandValid = band && BANDS.has(band) ? band : null;

  const conds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    sql`s.bargaining_unit = ${unit}`,
    sql`s.base_increase_pct IS NOT NULL`,
    county ? sql`d.county = ${county}` : null,
    districtType ? sql`d.district_type = ${districtType}` : null,
    bandValid ? bandSql(bandValid) : null,
    yearMin != null ? sql`CAST(LEFT(s.from_year, 4) AS INT) >= ${yearMin}` : null,
    yearMax != null ? sql`CAST(LEFT(s.from_year, 4) AS INT) <= ${yearMax}` : null,
  ];
  const where = buildWhere(conds);

  const aggRows = await db.execute(sql`
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY s.base_increase_pct) AS median_base,
      AVG(s.base_increase_pct)::numeric(10,4) AS avg_base,
      MIN(s.base_increase_pct) AS min_base,
      MAX(s.base_increase_pct) AS max_base,
      COUNT(*)::int AS n,
      COUNT(DISTINCT s.district_id)::int AS district_count
    FROM settlements s
    JOIN districts d ON s.district_id = d.id
    WHERE ${where}
  `);
  const agg = (aggRows.rows[0] ?? {}) as Record<string, unknown>;

  // A handful of matching districts, each linking to its comparables view with
  // the same peer filters carried in the query string.
  const distRows = await db.execute(sql`
    SELECT DISTINCT d.id, d.name, d.county, d.district_type, d.enrollment
    FROM settlements s
    JOIN districts d ON s.district_id = d.id
    WHERE ${where}
    ORDER BY d.name
    LIMIT ${MAX_TOOL_LIMIT}
  `);

  const results: AskResult[] = (distRows.rows as Record<string, unknown>[]).map((row) => {
    const id = Number(row.id);
    return {
      type: "comparables" as const,
      id,
      label: `${row.name} — peer comparison`,
      snippet: `Compare in ${[county, bandValid ? bandValid + " size" : null, districtType].filter(Boolean).join(" · ") || "Illinois"} peer group`,
      path: comparablesPath(id, { county, band: bandValid, districtType, yearFrom: yearMin, yearTo: yearMax }),
    };
  });

  const data = {
    filters: { county, band: bandValid, district_type: districtType, bargaining_unit: unit, start_year_min: yearMin, start_year_max: yearMax },
    median_base_pct: agg.median_base ?? null,
    avg_base_pct: agg.avg_base ?? null,
    min_base_pct: agg.min_base ?? null,
    max_base_pct: agg.max_base ?? null,
    settlement_count: Number(agg.n ?? 0),
    district_count: Number(agg.district_count ?? 0),
  };
  return { data, results };
}

async function searchFactfinding(input: Input): Promise<ToolOutput> {
  const limit = clampLimit(input.limit);
  const districtName = likePattern(input.district_name);
  const county = asTrimmedString(input.county);

  const conds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    districtName ? sql`d.name ILIKE ${districtName}` : null,
    county ? sql`d.county = ${county}` : null,
  ];
  const where = buildWhere(conds);

  const rows = await db.execute(sql`
    SELECT fp.id, fp.case_number, fp.report_date, fp.union_name, fp.year_covered,
           fp.employer_proposal_pct, fp.union_proposal_pct, fp.factfinder_recommendation_pct,
           d.id AS district_id, d.name AS district_name, d.county
    FROM factfinding_proposals fp
    JOIN districts d ON fp.district_id = d.id
    WHERE ${where}
    ORDER BY fp.report_date DESC NULLS LAST
    LIMIT ${limit}
  `);
  const data = rows.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      factfinding_id: Number(row.id),
      district_id: Number(row.district_id),
      district_name: row.district_name,
      county: row.county,
      case_number: row.case_number,
      report_date: row.report_date,
      year_covered: row.year_covered,
      employer_proposal_pct: row.employer_proposal_pct,
      union_proposal_pct: row.union_proposal_pct,
      factfinder_recommendation_pct: row.factfinder_recommendation_pct,
    };
  });
  const results: AskResult[] = data.map((f) => ({
    type: "factfinding" as const,
    id: f.district_id,
    label: `${f.district_name} — fact-finding ${f.year_covered ?? f.report_date ?? ""}`.trim(),
    snippet: `employer ${f.employer_proposal_pct ?? "?"}% vs union ${f.union_proposal_pct ?? "?"}% · recommended ${f.factfinder_recommendation_pct ?? "?"}%`,
    path: factfindingPath(f.district_id),
  }));
  return { data, results };
}

const FINAL_OFFER_TOPICS = new Set([
  "salary", "insurance", "retirement", "stipends", "leave", "workday",
  "work_year", "class_size", "evaluation", "grievance", "layoff_rif",
  "seniority", "term", "other",
]);

async function searchFinalOffers(input: Input): Promise<ToolOutput> {
  const limit = clampLimit(input.limit);
  const districtName = likePattern(input.district_name);
  const county = asTrimmedString(input.county);
  const topicRaw = asTrimmedString(input.topic);
  const topic = topicRaw && FINAL_OFFER_TOPICS.has(topicRaw.toLowerCase())
    ? topicRaw.toLowerCase()
    : null;
  const diffsOnly = input.diffs_only === true || input.diffs_only === "true";

  const conds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    districtName ? sql`d.name ILIKE ${districtName}` : null,
    county ? sql`d.county = ${county}` : null,
    topic ? sql`c.topic = ${topic}` : null,
    diffsOnly ? sql`c.status = 'diff'` : null,
  ];
  const where = buildWhere(conds);

  // One row per (case, topic). We over-fetch comparison rows and group the
  // top `limit` cases in JS so each card carries its topic-level diffs.
  const rows = await db.execute(sql`
    SELECT p.id AS posting_id, p.case_number, p.year, p.bargaining_unit,
           p.union_name, p.posted_date,
           d.id AS district_id, d.name AS district_name, d.county,
           c.topic, c.topic_label, c.status, c.numeric_gap, c.gap_unit,
           c.district_summary, c.union_summary
    FROM final_offer_postings p
    JOIN districts d ON p.district_id = d.id
    JOIN final_offer_comparisons c ON c.posting_id = p.id
    WHERE ${where}
    ORDER BY p.year DESC, p.id DESC,
      CASE c.status WHEN 'diff' THEN 0 WHEN 'union_only' THEN 1 WHEN 'district_only' THEN 2 ELSE 3 END,
      c.topic
  `);

  type Case = {
    district_id: number;
    district_name: string;
    county: string | null;
    case_number: string | null;
    year: number | null;
    bargaining_unit: string | null;
    union_name: string | null;
    posted_date: unknown;
    diff_count: number;
    aligned_count: number;
    topics: Array<{
      topic: string;
      topic_label: string | null;
      status: string;
      status_label: string;
      numeric_gap: number | null;
      gap_unit: string | null;
      district_position: string | null;
      union_position: string | null;
    }>;
  };

  const byPosting = new Map<number, Case>();
  for (const r of rows.rows as Record<string, unknown>[]) {
    const pid = Number(r.posting_id);
    let c = byPosting.get(pid);
    if (!c) {
      if (byPosting.size >= limit) continue;
      c = {
        district_id: Number(r.district_id),
        district_name: String(r.district_name),
        county: (r.county as string) ?? null,
        case_number: (r.case_number as string) ?? null,
        year: r.year != null ? Number(r.year) : null,
        bargaining_unit: (r.bargaining_unit as string) ?? null,
        union_name: (r.union_name as string) ?? null,
        posted_date: r.posted_date ?? null,
        diff_count: 0,
        aligned_count: 0,
        topics: [],
      };
      byPosting.set(pid, c);
    }
    const status = String(r.status);
    if (status === "diff") c.diff_count++;
    if (status === "aligned") c.aligned_count++;
    if (c.topics.length < 14) {
      c.topics.push({
        topic: String(r.topic),
        topic_label: (r.topic_label as string) ?? null,
        status,
        status_label: FINAL_OFFER_STATUS_LABEL[status] ?? status,
        numeric_gap: r.numeric_gap != null ? Number(r.numeric_gap) : null,
        gap_unit: (r.gap_unit as string) ?? null,
        district_position: (r.district_summary as string) ?? null,
        union_position: (r.union_summary as string) ?? null,
      });
    }
  }

  const data = Array.from(byPosting.values());
  const results: AskResult[] = data.map((c) => {
    const bits = [
      c.diff_count > 0 ? `${c.diff_count} open disagreement${c.diff_count !== 1 ? "s" : ""}` : null,
      c.aligned_count > 0 ? `${c.aligned_count} agreed` : null,
    ].filter(Boolean);
    return {
      type: "final_offer" as const,
      id: c.district_id,
      label: `${c.district_name} — board vs union ${c.year ?? ""}`.trim(),
      snippet: `${c.case_number ? c.case_number + " · " : ""}${bits.join(" · ") || "final offers posted"}`,
      path: finalOffersPath(c.district_id),
    };
  });
  return { data, results };
}

export async function executeAskTool(name: string, input: unknown): Promise<ToolOutput> {
  const safeInput = (input && typeof input === "object" ? input : {}) as Input;
  switch (name) {
    case "search_districts":
      return searchDistricts(safeInput);
    case "search_settlements":
      return searchSettlements(safeInput);
    case "search_provisions":
      return searchProvisions(safeInput);
    case "get_comparables":
      return getComparables(safeInput);
    case "search_factfinding":
      return searchFactfinding(safeInput);
    case "search_final_offers":
      return searchFinalOffers(safeInput);
    default:
      return { data: { error: `Unknown tool: ${name}` }, results: [] };
  }
}
