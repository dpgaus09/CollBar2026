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
  | "final_offer"
  | "salary";

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

// School year as the ISBE stores it: 'YYYY-YY' (e.g. '2024-25'). Returns the
// validated string or null so it can be bound as a parameter (never raw text).
function asSchoolYear(raw: unknown): string | null {
  const s = asTrimmedString(raw, 7);
  if (!s) return null;
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
}

// Coerce a possibly-string numeric DB value (drizzle returns NUMERIC as string)
// to a finite number, or null.
function asNum(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
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
  {
    name: "get_salary_schedule",
    description:
      "Retrieve the extracted salary-schedule grid (actual compensation DOLLAR amounts by education lane and experience step) for Illinois districts. Returns the most recent contract's schedule for the bargaining unit (default teachers), with the starting/base salary, the MA-lane base, the schedule maximum, plus the lane labels and step count. Optionally look up a specific cell by step and/or education lane. Use for compensation-amount questions like 'what is MA step 1 in Naperville?', 'what's the starting teacher salary?', or 'what does the BA lane top out at?'. (For base-increase PERCENTAGES use search_settlements instead.)",
    input_schema: {
      type: "object" as const,
      properties: {
        district_name: { type: "string", description: "Substring match on district name. Salary grids are district-specific, so name a district (or county) to scope the lookup." },
        county: { type: "string", description: "Exact county name (to disambiguate districts)." },
        bargaining_unit: { type: "string", description: "e.g. 'teachers' (default), 'support_staff'. CBAs never mix units." },
        step: { type: "integer", description: "Experience step to look up (e.g. 1 for the first step). Combine with lane for a single cell." },
        lane: { type: "string", description: "Education lane to look up, e.g. 'BA', 'MA', 'MA+30'. Matched against the grid's lane labels." },
        limit: { type: "integer", description: "Max districts (1-10, default 3)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_baseline_benefits",
    description:
      "Retrieve the ISBE BASELINE teacher salary-schedule and benefits profile (from the state Teacher Salary Study) for Illinois districts — the official annual baseline, distinct from negotiated CBA figures. For each matched district's most recent reported year it returns: salary-schedule lanes (BA/MA/MA+30 beginning, maximum and years-to-max; highest scheduled salary; masters-10th-year), board-paid TRS percentage, insurance premiums and the employer-paid share % for health, dental, vision, life, prescription and disability (employee-only and family tiers), severance, early-retirement, sick-leave bank, fair-share, longevity pay (and longevity maxes by lane), leave days (sick/personal), union affiliation, enrollment range, and contract expiration. Use for baseline questions like 'what is the board-paid TRS percentage in district X', 'what is the employee health-insurance premium in Naperville', 'which districts offer a sick-leave bank', or 'what does the BA lane start at per the state salary study'. (For the NEGOTIATED salary GRID from the CBA use get_salary_schedule; for base-increase PERCENTAGES use search_settlements.)",
    input_schema: {
      type: "object" as const,
      properties: {
        district_name: { type: "string", description: "Substring match on district name. Name a district (or county) to scope the lookup." },
        county: { type: "string", description: "Exact county name (to disambiguate or scope)." },
        school_year: { type: "string", description: "Specific year as 'YYYY-YY' (e.g. '2024-25'). Defaults to each district's most recent reported year." },
        limit: { type: "integer", description: "Max districts (1-10, default 5)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_eis_salary_stats",
    description:
      "Retrieve ACTUAL teacher/staff salary statistics from the state EIS employment records (what districts actually paid, aggregated — never individual names) for Illinois districts. For each matched district's most recent year it returns: average and median teacher salary, 25th/75th-percentile salary, teacher headcount and FTE, total teacher base payroll, and average sick days. Optionally break down BY POSITION (e.g. principals, superintendents, deans): supply a position keyword or a position group ('teacher'/'administrator'/'other') to also get per-position average/median salary, headcount, FTE and benefit totals (bonuses, annuities, retirement enhancements, other). Use for 'what is the average teacher salary in district X', 'median principal salary', 'how many administrators does X employ', or 'what did X actually pay teachers last year'. (These are ACTUAL paid figures; for the negotiated salary GRID use get_salary_schedule, for the state salary-study baseline use get_baseline_benefits.)",
    input_schema: {
      type: "object" as const,
      properties: {
        district_name: { type: "string", description: "Substring match on district name." },
        county: { type: "string", description: "Exact county name." },
        school_year: { type: "string", description: "Specific year as 'YYYY-YY' (e.g. '2020-21'). Defaults to each district's most recent reported year." },
        position: { type: "string", description: "Substring match on a position description (e.g. 'principal', 'superintendent'). Triggers a per-position breakdown." },
        position_group: {
          type: "string",
          enum: ["teacher", "administrator", "other"],
          description: "Coarse position group to break down by. Triggers a per-position breakdown.",
        },
        limit: { type: "integer", description: "Max districts (1-10, default 5)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "compare_to_peers",
    description:
      "Compare ONE Illinois district's baseline salary or benefits figure against a peer group, returning the district's own value alongside the peer median, average, minimum and maximum. Peers default to the same county; narrow further with an enrollment band and/or district type. Metrics span the state salary-study baseline (BA/MA beginning & maximum salary, highest scheduled salary, board-paid TRS %, employee/family health/dental/vision/life/prescription insurance premiums, sick & personal days) and the EIS actual-pay figures (average & median teacher salary, teacher headcount, teacher FTE). Use for 'how does Naperville's employee health premium compare to peers', 'is this district's average teacher salary above or below the county', or 'how does the board-paid TRS percentage stack up against similar-size districts'.",
    input_schema: {
      type: "object" as const,
      properties: {
        district_name: { type: "string", description: "Substring match on the focal district's name (required to identify the district)." },
        metric: {
          type: "string",
          enum: [
            "ba_begin", "ba_max", "ma_begin", "ma_max", "highest_scheduled_salary",
            "trs_board_paid_pct",
            "health_premium_employee", "health_premium_family",
            "dental_premium_employee", "vision_premium_employee",
            "life_premium_employee", "prescription_premium_employee",
            "sick_days", "personal_days",
            "avg_teacher_salary", "median_teacher_salary",
            "teacher_headcount", "teacher_fte",
          ],
          description: "Which figure to compare. Defaults to average teacher salary.",
        },
        county: { type: "string", description: "Peer-group county. Defaults to the focal district's own county." },
        band: { type: "string", enum: ["tiny", "small", "medium", "large", "xlarge"], description: "Restrict peers to an enrollment size band." },
        district_type: { type: "string", description: "Restrict peers to an exact district type (e.g. 'Unit')." },
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
  get_salary_schedule: "Looking up salary schedules…",
  get_baseline_benefits: "Reading state salary-study benefits…",
  get_eis_salary_stats: "Reading state salary statistics…",
  compare_to_peers: "Comparing against peer districts…",
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
// The salary grid lives on the district overview page; the selected bargaining
// unit is carried in `?unit=` (teachers is the default and needs no param, so
// the URL stays clean and matches the dashboard's own unit-switcher behaviour).
function salaryPath(id: number, unit: string): string {
  return `/dashboard/${id}${unit && unit !== "teachers" ? qs({ unit }) : ""}`;
}

// Format a dollar amount for the human-readable result-card snippet.
function asSalary(val: number | null): string | null {
  if (val == null || !Number.isFinite(val)) return null;
  return `$${Math.round(val).toLocaleString("en-US")}`;
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

// Marker some extraction passes left on schedules that were mis-parsed (e.g. a
// stipend/differential table read as a base grid). The customer dashboard hides
// these, so the assistant must too — they would surface implausible figures.
const IMPLAUSIBLE_MAGNITUDE = "%implausible_salary_magnitude%";

interface SalaryCell {
  stepLabel: string;
  stepOrder: number;
  laneLabel: string | null;
  laneOrder: number;
  salary: number;
}

async function getSalarySchedule(input: Input): Promise<ToolOutput> {
  const limit = clampLimit(input.limit, 3);
  const unit = parseUnit(input.bargaining_unit);
  const districtName = likePattern(input.district_name);
  const county = asTrimmedString(input.county);

  // Optional single-cell lookup: a step number (digits only) and/or an
  // education lane token (e.g. "MA", "BA+15"), normalised for matching.
  const stepRaw = asTrimmedString(input.step, 12);
  const stepNum = stepRaw != null ? parseInt(stepRaw.replace(/\D/g, ""), 10) : NaN;
  const laneRaw = asTrimmedString(input.lane, 20);
  const laneNorm = laneRaw ? laneRaw.toUpperCase().replace(/\s+/g, "") : null;

  // Phase 1: the matching IL districts and their MOST RECENT contract that has
  // display-quality schedules for this unit. DISTINCT ON keeps one (latest)
  // contract per district; the implausible-magnitude exclusion mirrors the
  // dashboard salary view exactly so the assistant never cites withheld grids.
  const conds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    sql`c.bargaining_unit = ${unit}`,
    sql`(s.review_reason IS NULL OR s.review_reason NOT LIKE ${IMPLAUSIBLE_MAGNITUDE})`,
    districtName ? sql`d.name ILIKE ${districtName}` : null,
    county ? sql`d.county = ${county}` : null,
  ];
  const where = buildWhere(conds);

  const targetRows = await db.execute(sql`
    SELECT DISTINCT ON (d.id)
      d.id AS district_id, d.name AS district_name, d.county, c.id AS contract_id
    FROM districts d
    JOIN contracts c ON c.district_id = d.id
    JOIN contract_salary_schedules s ON s.contract_id = c.id
    WHERE ${where}
    ORDER BY d.id, c.effective_start DESC NULLS LAST, c.id DESC
    LIMIT ${limit}
  `);

  const targets = (targetRows.rows as Record<string, unknown>[]).map((r) => ({
    districtId: Number(r.district_id),
    districtName: String(r.district_name),
    county: (r.county as string) ?? null,
    contractId: Number(r.contract_id),
  }));
  if (!targets.length) return { data: [], results: [] };

  const idList = sql.join(targets.map((t) => sql`${t.contractId}`), sql`, `);

  // Phase 2: the display-quality schedules and their cells for those contracts.
  // Both queries re-join districts and re-assert the IL state filter so each
  // query is independently scoped (no cross-state leak even if Phase 1 changes).
  const schedRows = await db.execute(sql`
    SELECT s.id, s.contract_id, s.schedule_name, s.school_year, s.start_year,
           s.lane_labels, s.step_count, s.lane_count, s.min_salary, s.max_salary
    FROM contract_salary_schedules s
    JOIN contracts c ON c.id = s.contract_id
    JOIN districts d ON d.id = c.district_id
    WHERE s.contract_id IN (${idList})
      AND d.state = ${CUSTOMER_STATE}
      AND c.bargaining_unit = ${unit}
      AND (s.review_reason IS NULL OR s.review_reason NOT LIKE ${IMPLAUSIBLE_MAGNITUDE})
    ORDER BY s.contract_id, s.start_year DESC NULLS LAST, s.school_year DESC
  `);

  const cellRows = await db.execute(sql`
    SELECT cell.schedule_id, cell.step_label, cell.step_order,
           cell.lane_label, cell.lane_order, cell.salary_amount
    FROM contract_salary_schedule_cells cell
    JOIN contract_salary_schedules s ON s.id = cell.schedule_id
    JOIN contracts c ON c.id = s.contract_id
    JOIN districts d ON d.id = c.district_id
    WHERE s.contract_id IN (${idList})
      AND d.state = ${CUSTOMER_STATE}
      AND c.bargaining_unit = ${unit}
      AND (s.review_reason IS NULL OR s.review_reason NOT LIKE ${IMPLAUSIBLE_MAGNITUDE})
    ORDER BY cell.step_order, cell.lane_order
  `);

  const cellsBySched = new Map<number, SalaryCell[]>();
  for (const r of cellRows.rows as Record<string, unknown>[]) {
    const sid = Number(r.schedule_id);
    const arr = cellsBySched.get(sid) ?? [];
    arr.push({
      stepLabel: String(r.step_label),
      stepOrder: Number(r.step_order),
      laneLabel: r.lane_label == null ? null : String(r.lane_label),
      laneOrder: Number(r.lane_order),
      salary: Number(r.salary_amount),
    });
    cellsBySched.set(sid, arr);
  }

  interface Sched {
    id: number;
    contractId: number;
    scheduleName: string;
    schoolYear: string;
    startYear: number | null;
    laneLabels: string[] | null;
    stepCount: number | null;
    laneCount: number | null;
    minSalary: number | null;
    maxSalary: number | null;
    cells: SalaryCell[];
  }
  const schedsByContract = new Map<number, Sched[]>();
  for (const r of schedRows.rows as Record<string, unknown>[]) {
    const cid = Number(r.contract_id);
    const id = Number(r.id);
    const arr = schedsByContract.get(cid) ?? [];
    arr.push({
      id,
      contractId: cid,
      scheduleName: String(r.schedule_name),
      schoolYear: String(r.school_year),
      startYear: r.start_year == null ? null : Number(r.start_year),
      laneLabels: (r.lane_labels as string[] | null) ?? null,
      stepCount: r.step_count == null ? null : Number(r.step_count),
      laneCount: r.lane_count == null ? null : Number(r.lane_count),
      minSalary: r.min_salary == null ? null : Number(r.min_salary),
      maxSalary: r.max_salary == null ? null : Number(r.max_salary),
      cells: cellsBySched.get(id) ?? [],
    });
    schedsByContract.set(cid, arr);
  }

  const data: unknown[] = [];
  const results: AskResult[] = [];
  for (const t of targets) {
    const scheds = schedsByContract.get(t.contractId) ?? [];
    if (!scheds.length) continue;

    // Default job family + latest school year, mirroring the dashboard summary.
    const families = [...new Set(scheds.map((s) => s.scheduleName))];
    const defaultFamily = families.includes("Teachers") ? "Teachers" : families[0];
    const latest = scheds
      .filter((s) => s.scheduleName === defaultFamily)
      .sort((a, b) => (b.startYear ?? 0) - (a.startYear ?? 0))[0];
    if (!latest) continue;

    // Anchor figures: base = first step's BA (or first) lane; MA base = first
    // step's MA lane; max = schedule maximum (same derivation as the UI).
    let baseSalary: number | null = null;
    let maBaseSalary: number | null = null;
    if (latest.cells.length) {
      const step0 = Math.min(...latest.cells.map((c) => c.stepOrder));
      const baCell =
        latest.cells.find((c) => c.stepOrder === step0 && /^BA\b/i.test(c.laneLabel ?? "")) ??
        latest.cells.find((c) => c.stepOrder === step0 && c.laneOrder === 0);
      const maCell = latest.cells.find(
        (c) => c.stepOrder === step0 && /^MA\b/i.test(c.laneLabel ?? ""),
      );
      baseSalary = baCell ? baCell.salary : null;
      maBaseSalary = maCell ? maCell.salary : null;
    }
    const maxSalary = latest.maxSalary;

    // Optional specific-cell lookup against the latest schedule. Step matches on
    // the numeric part of the step label; lane matches a case-insensitive prefix
    // of the lane label (so "MA" finds "MA", "MA+15", …). Capped to keep the
    // payload small.
    let matchedCells:
      | Array<{ step: string; lane: string | null; salary: number }>
      | undefined;
    if (!Number.isNaN(stepNum) || laneNorm) {
      matchedCells = latest.cells
        .filter((c) => {
          const stepOk = Number.isNaN(stepNum)
            ? true
            : parseInt(String(c.stepLabel).replace(/\D/g, ""), 10) === stepNum;
          const laneOk = !laneNorm
            ? true
            : (c.laneLabel ?? "").toUpperCase().replace(/\s+/g, "").startsWith(laneNorm);
          return stepOk && laneOk;
        })
        .slice(0, 12)
        .map((c) => ({ step: c.stepLabel, lane: c.laneLabel, salary: c.salary }));
    }

    data.push({
      district_id: t.districtId,
      district_name: t.districtName,
      county: t.county,
      bargaining_unit: unit,
      job_family: defaultFamily,
      school_year: latest.schoolYear,
      step_count: latest.stepCount,
      lane_labels: latest.laneLabels,
      base_salary: baseSalary,
      ma_base_salary: maBaseSalary,
      max_salary: maxSalary,
      ...(matchedCells ? { matched_cells: matchedCells } : {}),
    });

    const snippet =
      [
        latest.schoolYear,
        baseSalary != null ? `base ${asSalary(baseSalary)}` : null,
        maBaseSalary != null ? `MA base ${asSalary(maBaseSalary)}` : null,
        maxSalary != null ? `max ${asSalary(maxSalary)}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || `${defaultFamily} salary schedule`;
    results.push({
      type: "salary",
      id: t.districtId,
      label: `${t.districtName} — ${defaultFamily} salary schedule`,
      snippet,
      path: salaryPath(t.districtId, unit),
    });
  }

  return { data, results };
}

// ---------------------------------------------------------------------------
// get_baseline_benefits — ISBE Teacher Salary Study baseline (tss_annual).
//
// One snapshot per matched IL district, its MOST RECENT reported year. These
// are the state's official baseline figures (distinct from negotiated CBA
// grids). tss_annual is keyed by (state, state_district_id, school_year), so we
// join `districts` on state_district_id and re-assert d.state = CUSTOMER_STATE
// (and tss.state) to keep the query independently IL-scoped.
// ---------------------------------------------------------------------------
async function getBaselineBenefits(input: Input): Promise<ToolOutput> {
  const limit = clampLimit(input.limit, 5);
  const districtName = likePattern(input.district_name);
  const county = asTrimmedString(input.county);
  const schoolYear = asSchoolYear(input.school_year);

  const conds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    sql`tss.state = ${CUSTOMER_STATE}`,
    districtName ? sql`d.name ILIKE ${districtName}` : null,
    county ? sql`d.county = ${county}` : null,
    schoolYear ? sql`tss.school_year = ${schoolYear}` : null,
  ];
  const where = buildWhere(conds);

  const rows = await db.execute(sql`
    SELECT DISTINCT ON (d.id)
      d.id AS district_id, d.name AS district_name, d.county, d.district_type,
      d.enrollment, tss.school_year, tss.affiliation, tss.enrollment_range,
      tss.contract_expires, tss.salary_program, tss.education_level_required,
      tss.ba_begin, tss.ba_max, tss.ba_years_to_max,
      tss.ma_begin, tss.ma_max, tss.ma_years_to_max,
      tss.ma30_begin, tss.ma30_max, tss.ma30_years_to_max,
      tss.highest_scheduled_salary, tss.hss_years_to_max, tss.masters_10th_year_salary,
      tss.trs_board_paid_pct, tss.trs_included_in_salary,
      tss.personal_days, tss.sick_days, tss.sick_leave_bank,
      tss.severance_pay, tss.early_retirement_program, tss.fair_share_provision,
      tss.longevity_pay_provided, tss.longevity_ba_max, tss.longevity_ma_max,
      tss.longevity_ma30_max, tss.longevity_hss_max,
      tss.health_premium_employee, tss.health_pct_employer_employee,
      tss.health_premium_family, tss.health_pct_employer_family,
      tss.dental_premium_employee, tss.dental_pct_employer_employee,
      tss.dental_premium_family, tss.dental_pct_employer_family,
      tss.vision_premium_employee, tss.vision_pct_employer_employee,
      tss.vision_premium_family, tss.vision_pct_employer_family,
      tss.life_premium_employee, tss.life_pct_employer_employee,
      tss.life_premium_family, tss.life_pct_employer_family,
      tss.prescription_premium_employee, tss.prescription_pct_employer_employee,
      tss.prescription_premium_family, tss.prescription_pct_employer_family,
      tss.disability_premium_employee, tss.disability_pct_employer_employee,
      tss.disability_premium_family, tss.disability_pct_employer_family
    FROM districts d
    JOIN tss_annual tss ON tss.state_district_id = d.state_district_id
    WHERE ${where}
    ORDER BY d.id, tss.school_year DESC
    LIMIT ${limit}
  `);

  const data = (rows.rows as Record<string, unknown>[]).map((r) => ({
    district_id: Number(r.district_id),
    district_name: r.district_name,
    county: r.county,
    district_type: r.district_type,
    school_year: r.school_year,
    affiliation: r.affiliation,
    enrollment_range: r.enrollment_range,
    contract_expires: r.contract_expires,
    salary_program: r.salary_program,
    education_level_required: r.education_level_required,
    salary_schedule: {
      ba_begin: asNum(r.ba_begin), ba_max: asNum(r.ba_max), ba_years_to_max: asNum(r.ba_years_to_max),
      ma_begin: asNum(r.ma_begin), ma_max: asNum(r.ma_max), ma_years_to_max: asNum(r.ma_years_to_max),
      ma30_begin: asNum(r.ma30_begin), ma30_max: asNum(r.ma30_max), ma30_years_to_max: asNum(r.ma30_years_to_max),
      highest_scheduled_salary: asNum(r.highest_scheduled_salary),
      hss_years_to_max: asNum(r.hss_years_to_max),
      masters_10th_year_salary: asNum(r.masters_10th_year_salary),
    },
    retirement: {
      trs_board_paid_pct: asNum(r.trs_board_paid_pct),
      trs_included_in_salary: r.trs_included_in_salary,
      severance_pay: r.severance_pay,
      early_retirement_program: r.early_retirement_program,
    },
    leave: {
      sick_days: asNum(r.sick_days),
      personal_days: asNum(r.personal_days),
      sick_leave_bank: r.sick_leave_bank,
    },
    longevity: {
      longevity_pay_provided: r.longevity_pay_provided,
      longevity_ba_max: asNum(r.longevity_ba_max),
      longevity_ma_max: asNum(r.longevity_ma_max),
      longevity_ma30_max: asNum(r.longevity_ma30_max),
      longevity_hss_max: asNum(r.longevity_hss_max),
    },
    fair_share_provision: r.fair_share_provision,
    insurance: {
      health: {
        premium_employee: asNum(r.health_premium_employee), pct_employer_employee: asNum(r.health_pct_employer_employee),
        premium_family: asNum(r.health_premium_family), pct_employer_family: asNum(r.health_pct_employer_family),
      },
      dental: {
        premium_employee: asNum(r.dental_premium_employee), pct_employer_employee: asNum(r.dental_pct_employer_employee),
        premium_family: asNum(r.dental_premium_family), pct_employer_family: asNum(r.dental_pct_employer_family),
      },
      vision: {
        premium_employee: asNum(r.vision_premium_employee), pct_employer_employee: asNum(r.vision_pct_employer_employee),
        premium_family: asNum(r.vision_premium_family), pct_employer_family: asNum(r.vision_pct_employer_family),
      },
      life: {
        premium_employee: asNum(r.life_premium_employee), pct_employer_employee: asNum(r.life_pct_employer_employee),
        premium_family: asNum(r.life_premium_family), pct_employer_family: asNum(r.life_pct_employer_family),
      },
      prescription: {
        premium_employee: asNum(r.prescription_premium_employee), pct_employer_employee: asNum(r.prescription_pct_employer_employee),
        premium_family: asNum(r.prescription_premium_family), pct_employer_family: asNum(r.prescription_pct_employer_family),
      },
      disability: {
        premium_employee: asNum(r.disability_premium_employee), pct_employer_employee: asNum(r.disability_pct_employer_employee),
        premium_family: asNum(r.disability_premium_family), pct_employer_family: asNum(r.disability_pct_employer_family),
      },
    },
  }));

  const results: AskResult[] = data.map((d) => {
    const trs = d.retirement.trs_board_paid_pct;
    const health = d.insurance.health.premium_employee;
    const snippet =
      [
        d.county ? `${d.county} County` : null,
        d.salary_schedule.ba_begin != null ? `BA start ${asSalary(d.salary_schedule.ba_begin)}` : null,
        trs != null ? `TRS board-paid ${trs}%` : null,
        health != null ? `health EE ${asSalary(health)}` : null,
        d.school_year,
      ]
        .filter(Boolean)
        .join(" · ") || "State salary-study baseline";
    return {
      type: "district" as const,
      id: d.district_id,
      label: `${d.district_name} — salary-study baseline`,
      snippet,
      path: districtPath(d.district_id),
    };
  });

  return { data, results };
}

// ---------------------------------------------------------------------------
// get_eis_salary_stats — ISBE EIS actual-pay statistics (il_eis_district plus,
// when a position is requested, il_eis_position_summary). Aggregates only —
// never individual educator names. Both tables are keyed by state_district_id
// (no state column), so every query joins `districts` and asserts d.state.
// ---------------------------------------------------------------------------
async function getEisSalaryStats(input: Input): Promise<ToolOutput> {
  const limit = clampLimit(input.limit, 5);
  const districtName = likePattern(input.district_name);
  const county = asTrimmedString(input.county);
  const schoolYear = asSchoolYear(input.school_year);
  const positionPattern = likePattern(input.position);
  const groupRaw = asTrimmedString(input.position_group, 20);
  const positionGroup =
    groupRaw && ["teacher", "administrator", "other"].includes(groupRaw.toLowerCase())
      ? groupRaw.toLowerCase()
      : null;

  const distConds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    districtName ? sql`d.name ILIKE ${districtName}` : null,
    county ? sql`d.county = ${county}` : null,
    schoolYear ? sql`eis.school_year = ${schoolYear}` : null,
  ];
  const distWhere = buildWhere(distConds);

  const distRows = await db.execute(sql`
    SELECT DISTINCT ON (d.id)
      d.id AS district_id, d.name AS district_name, d.county, d.district_type,
      d.enrollment, eis.school_year, eis.teacher_headcount, eis.teacher_fte,
      eis.avg_teacher_salary, eis.median_teacher_salary, eis.p25_salary, eis.p75_salary,
      eis.total_teacher_base_payroll, eis.avg_sick_days,
      eis.all_staff_headcount, eis.all_staff_fte
    FROM districts d
    JOIN il_eis_district eis ON eis.state_district_id = d.state_district_id
    WHERE ${distWhere}
    ORDER BY d.id, eis.school_year DESC
    LIMIT ${limit}
  `);

  const districts = (distRows.rows as Record<string, unknown>[]).map((r) => ({
    district_id: Number(r.district_id),
    district_name: r.district_name,
    county: r.county,
    district_type: r.district_type,
    school_year: r.school_year,
    teacher_headcount: asNum(r.teacher_headcount),
    teacher_fte: asNum(r.teacher_fte),
    avg_teacher_salary: asNum(r.avg_teacher_salary),
    median_teacher_salary: asNum(r.median_teacher_salary),
    p25_salary: asNum(r.p25_salary),
    p75_salary: asNum(r.p75_salary),
    total_teacher_base_payroll: asNum(r.total_teacher_base_payroll),
    avg_sick_days: asNum(r.avg_sick_days),
    all_staff_headcount: asNum(r.all_staff_headcount),
    all_staff_fte: asNum(r.all_staff_fte),
  }));

  // Optional per-position breakdown. Latest year per (district, position); the
  // query re-joins districts and re-asserts d.state for independent IL-scoping.
  let positions:
    | Array<{
        district_id: number;
        district_name: unknown;
        county: unknown;
        school_year: unknown;
        position_description: unknown;
        position_group: unknown;
        headcount: number | null;
        total_fte: number | null;
        avg_salary: number | null;
        median_salary: number | null;
        p25_salary: number | null;
        p75_salary: number | null;
        avg_sick_days: number | null;
        avg_vacation_days: number | null;
        total_base_salary: number | null;
        total_bonus: number | null;
        total_annuities: number | null;
        total_retirement_enhancements: number | null;
        total_other_benefits: number | null;
      }>
    | undefined;
  if (positionPattern || positionGroup) {
    const posConds: Array<SQL | null> = [
      sql`d.state = ${CUSTOMER_STATE}`,
      districtName ? sql`d.name ILIKE ${districtName}` : null,
      county ? sql`d.county = ${county}` : null,
      schoolYear ? sql`ps.school_year = ${schoolYear}` : null,
      positionPattern ? sql`ps.position_description ILIKE ${positionPattern}` : null,
      positionGroup ? sql`ps.position_group = ${positionGroup}` : null,
    ];
    const posWhere = buildWhere(posConds);

    const posRows = await db.execute(sql`
      SELECT DISTINCT ON (d.id, ps.position_description)
        d.id AS district_id, d.name AS district_name, d.county,
        ps.school_year, ps.position_description, ps.position_group,
        ps.headcount, ps.total_fte, ps.avg_salary, ps.median_salary,
        ps.p25_salary, ps.p75_salary, ps.avg_sick_days, ps.avg_vacation_days,
        ps.total_base_salary, ps.total_bonus, ps.total_annuities,
        ps.total_retirement_enhancements, ps.total_other_benefits
      FROM districts d
      JOIN il_eis_position_summary ps ON ps.state_district_id = d.state_district_id
      WHERE ${posWhere}
      ORDER BY d.id, ps.position_description, ps.school_year DESC
    `);

    positions = (posRows.rows as Record<string, unknown>[])
      .map((r) => ({
        district_id: Number(r.district_id),
        district_name: r.district_name,
        county: r.county,
        school_year: r.school_year,
        position_description: r.position_description,
        position_group: r.position_group,
        headcount: asNum(r.headcount),
        total_fte: asNum(r.total_fte),
        avg_salary: asNum(r.avg_salary),
        median_salary: asNum(r.median_salary),
        p25_salary: asNum(r.p25_salary),
        p75_salary: asNum(r.p75_salary),
        avg_sick_days: asNum(r.avg_sick_days),
        avg_vacation_days: asNum(r.avg_vacation_days),
        total_base_salary: asNum(r.total_base_salary),
        total_bonus: asNum(r.total_bonus),
        total_annuities: asNum(r.total_annuities),
        total_retirement_enhancements: asNum(r.total_retirement_enhancements),
        total_other_benefits: asNum(r.total_other_benefits),
      }))
      .sort((a, b) => (b.headcount ?? 0) - (a.headcount ?? 0))
      .slice(0, MAX_TOOL_LIMIT);
  }

  // One card per matched district (deep-linking to its overview). When the
  // caller asked only for positions of a district we didn't surface at the
  // district level, still build cards from the position rows' districts.
  const cardSource = districts.length
    ? districts.map((d) => ({ id: d.district_id, name: d.district_name, county: d.county, school_year: d.school_year, avg: d.avg_teacher_salary, median: d.median_teacher_salary, headcount: d.teacher_headcount }))
    : [];
  const results: AskResult[] = cardSource.map((d) => {
    const snippet =
      [
        d.county ? `${d.county} County` : null,
        d.avg != null ? `avg teacher ${asSalary(d.avg)}` : null,
        d.median != null ? `median ${asSalary(d.median)}` : null,
        d.headcount != null ? `${d.headcount} teachers` : null,
        d.school_year,
      ]
        .filter(Boolean)
        .join(" · ") || "State salary statistics";
    return {
      type: "district" as const,
      id: d.id,
      label: `${d.name} — salary statistics`,
      snippet,
      path: districtPath(d.id),
    };
  });

  const data: Record<string, unknown> = { districts };
  if (positions) data.positions = positions;
  return { data, results };
}

// ---------------------------------------------------------------------------
// compare_to_peers — focal district's baseline figure vs a peer-group
// median/avg/min/max for a WHITELISTED metric. The metric maps to a fixed
// column on either tss_annual or il_eis_district; the column name is taken from
// this registry only (never from user text) so sql.raw is safe to interpolate.
// ---------------------------------------------------------------------------
type MetricKind = "money" | "pct" | "days" | "count" | "fte";
const COMPARE_METRICS: Record<
  string,
  { table: "tss" | "eis"; column: string; label: string; kind: MetricKind }
> = {
  ba_begin: { table: "tss", column: "ba_begin", label: "BA beginning salary", kind: "money" },
  ba_max: { table: "tss", column: "ba_max", label: "BA maximum salary", kind: "money" },
  ma_begin: { table: "tss", column: "ma_begin", label: "MA beginning salary", kind: "money" },
  ma_max: { table: "tss", column: "ma_max", label: "MA maximum salary", kind: "money" },
  highest_scheduled_salary: { table: "tss", column: "highest_scheduled_salary", label: "highest scheduled salary", kind: "money" },
  trs_board_paid_pct: { table: "tss", column: "trs_board_paid_pct", label: "board-paid TRS percentage", kind: "pct" },
  health_premium_employee: { table: "tss", column: "health_premium_employee", label: "employee health premium", kind: "money" },
  health_premium_family: { table: "tss", column: "health_premium_family", label: "family health premium", kind: "money" },
  dental_premium_employee: { table: "tss", column: "dental_premium_employee", label: "employee dental premium", kind: "money" },
  vision_premium_employee: { table: "tss", column: "vision_premium_employee", label: "employee vision premium", kind: "money" },
  life_premium_employee: { table: "tss", column: "life_premium_employee", label: "employee life premium", kind: "money" },
  prescription_premium_employee: { table: "tss", column: "prescription_premium_employee", label: "employee prescription premium", kind: "money" },
  sick_days: { table: "tss", column: "sick_days", label: "sick days", kind: "days" },
  personal_days: { table: "tss", column: "personal_days", label: "personal days", kind: "days" },
  avg_teacher_salary: { table: "eis", column: "avg_teacher_salary", label: "average teacher salary", kind: "money" },
  median_teacher_salary: { table: "eis", column: "median_teacher_salary", label: "median teacher salary", kind: "money" },
  teacher_headcount: { table: "eis", column: "teacher_headcount", label: "teacher headcount", kind: "count" },
  teacher_fte: { table: "eis", column: "teacher_fte", label: "teacher FTE", kind: "fte" },
};

function formatMetric(kind: MetricKind, value: number | null): string | null {
  if (value == null) return null;
  switch (kind) {
    case "money":
      return asSalary(value);
    case "pct":
      return `${value}%`;
    case "days":
      return `${value} days`;
    case "fte":
      return `${value} FTE`;
    case "count":
    default:
      return String(Math.round(value));
  }
}

async function compareToPeers(input: Input): Promise<ToolOutput> {
  const districtName = likePattern(input.district_name);
  const county = asTrimmedString(input.county);
  const bandRaw = asTrimmedString(input.band);
  const bandValid = bandRaw && BANDS.has(bandRaw) ? bandRaw : null;
  const districtType = asTrimmedString(input.district_type);
  // Resolve to a known metric. An unknown/absent key falls back to
  // avg_teacher_salary; metricKey is then set to the RESOLVED key (never the raw
  // user text) so the returned data never advertises an unsupported metric.
  const requestedMetric = asTrimmedString(input.metric, 40);
  const metricKey =
    requestedMetric && COMPARE_METRICS[requestedMetric]
      ? requestedMetric
      : "avg_teacher_salary";
  const metric = COMPARE_METRICS[metricKey];
  const col = sql.raw(metric.column);

  // Phase 1: identify the focal district and read its latest value for the
  // metric. The value subselect targets the metric's own table; the outer query
  // is IL-scoped (d.state) so the whole statement is anchored to Illinois.
  const focalValExpr =
    metric.table === "tss"
      ? sql`(SELECT t.${col} FROM tss_annual t
             WHERE t.state_district_id = d.state_district_id AND t.state = ${CUSTOMER_STATE}
               AND t.${col} IS NOT NULL ORDER BY t.school_year DESC LIMIT 1)`
      : sql`(SELECT e.${col} FROM il_eis_district e
             WHERE e.state_district_id = d.state_district_id
               AND e.${col} IS NOT NULL ORDER BY e.school_year DESC LIMIT 1)`;

  const focalConds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    districtName ? sql`d.name ILIKE ${districtName}` : null,
    county ? sql`d.county = ${county}` : null,
  ];
  const focalWhere = buildWhere(focalConds);

  const focalRows = await db.execute(sql`
    SELECT d.id AS district_id, d.name AS district_name, d.county,
           d.district_type, d.enrollment, ${focalValExpr} AS focal_value
    FROM districts d
    WHERE ${focalWhere}
    ORDER BY d.name
    LIMIT 1
  `);
  const focal = focalRows.rows[0] as Record<string, unknown> | undefined;
  if (!focal) {
    return {
      data: { error: "No matching Illinois district found.", metric: metricKey },
      results: [],
    };
  }

  const focalId = Number(focal.district_id);
  // Peers default to the focal district's own county when no filters are given.
  const peerCounty = county ?? (asTrimmedString(focal.county) || null);

  const peerConds: Array<SQL | null> = [
    sql`d.state = ${CUSTOMER_STATE}`,
    sql`d.id <> ${focalId}`,
    peerCounty ? sql`d.county = ${peerCounty}` : null,
    bandValid ? bandSql(bandValid) : null,
    districtType ? sql`d.district_type = ${districtType}` : null,
  ];
  const peerWhere = buildWhere(peerConds);

  // Phase 2: peer aggregate. `latest` keeps one (most recent) value per peer
  // district; `peers` carries the IL state filter so this statement is anchored.
  const tableExpr = metric.table === "tss" ? sql`tss_annual x` : sql`il_eis_district x`;
  const latestWhere =
    metric.table === "tss"
      ? sql`x.${col} IS NOT NULL AND x.state = ${CUSTOMER_STATE}`
      : sql`x.${col} IS NOT NULL`;

  const aggRows = await db.execute(sql`
    WITH peers AS (
      SELECT d.state_district_id FROM districts d WHERE ${peerWhere}
    ),
    latest AS (
      SELECT DISTINCT ON (x.state_district_id) x.${col} AS v
      FROM ${tableExpr}
      JOIN peers p ON p.state_district_id = x.state_district_id
      WHERE ${latestWhere}
      ORDER BY x.state_district_id, x.school_year DESC
    )
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS median,
           AVG(v)::numeric(14,2) AS avg, MIN(v) AS min, MAX(v) AS max,
           COUNT(*)::int AS n
    FROM latest
  `);
  const agg = (aggRows.rows[0] ?? {}) as Record<string, unknown>;

  const focalValue = asNum(focal.focal_value);
  const peerMedian = asNum(agg.median);
  const peerAvg = asNum(agg.avg);
  const data = {
    district_id: focalId,
    district_name: focal.district_name,
    county: focal.county,
    metric: metricKey,
    metric_label: metric.label,
    district_value: focalValue,
    peer_median: peerMedian,
    peer_avg: peerAvg,
    peer_min: asNum(agg.min),
    peer_max: asNum(agg.max),
    peer_count: Number(agg.n ?? 0),
    peer_filters: { county: peerCounty, band: bandValid, district_type: districtType },
  };

  const snippet =
    [
      `${metric.label}: ${formatMetric(metric.kind, focalValue) ?? "n/a"}`,
      peerMedian != null ? `peer median ${formatMetric(metric.kind, peerMedian)}` : null,
      `${data.peer_count} peer${data.peer_count !== 1 ? "s" : ""}${peerCounty ? " in " + peerCounty : ""}`,
    ]
      .filter(Boolean)
      .join(" · ");

  const results: AskResult[] = [
    {
      type: "comparables" as const,
      id: focalId,
      label: `${focal.district_name} — vs peers`,
      snippet,
      path: comparablesPath(focalId, { county: peerCounty, band: bandValid, districtType }),
    },
  ];

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
    case "get_salary_schedule":
      return getSalarySchedule(safeInput);
    case "get_baseline_benefits":
      return getBaselineBenefits(safeInput);
    case "get_eis_salary_stats":
      return getEisSalaryStats(safeInput);
    case "compare_to_peers":
      return compareToPeers(safeInput);
    default:
      return { data: { error: `Unknown tool: ${name}` }, results: [] };
  }
}
