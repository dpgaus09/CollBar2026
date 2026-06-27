import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireFirmSession } from "../lib/firm-access.js";
import { firmScopeDistrictIds } from "../lib/firm-scope.js";
import { parseUnit } from "./bargaining-units.js";
import { logger } from "../lib/logger.js";

// ============================================================================
// Phase 4 — Clause search & side-by-side clause comparison (firm workspace).
//
// RETRIEVAL-FIRST. Keyword full-text search (tsvector + GIN, websearch_to_tsquery
// + ts_rank) over the VERBATIM clause language stored in
// contract_provisions.clause_excerpt. Every result is a real, stored clause with
// full provenance (provision id, source PDF url, page ref, confidence,
// human_verified). A single grounded model call only SYNTHESIZES over the
// clauses we already retrieved — it never invents clause language, and the
// verbatim clauses are returned (and rendered) regardless of whether synthesis
// succeeds. Synthesis is best-effort: a model failure yields synthesis=null.
//
// ENTITLEMENT: guarded by requireFirmSession (firm membership), like the rest of
// the firm workspace — NOT gate()/isFree(). Everything stays inside the firm's
// scope (roster ∪ matter districts) so every returned clause's source PDF is
// reachable through GET /api/firm/document. There is deliberately NO cross-firm
// corpus search here (that would require broadened document authorization and a
// plan-tier geo entitlement that do not exist yet); scope "all" means the entire
// firm workspace, not the whole database.
// ============================================================================

const router: IRouter = Router();

const SEARCH_MODEL = "claude-haiku-4-5"; // fast model for search synthesis
const COMPARE_MODEL = "claude-opus-4-8"; // strongest model for multi-clause compare
const MAX_DISTRICTS = 60;
const MAX_QUERY_LEN = 300;
const MAX_KEY_LEN = 80;
const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;
const SYNTH_MAX_CLAUSES = 12; // clauses handed to the model
const SYNTH_MAX_EXCERPT_CHARS = 1200; // per-clause excerpt cap handed to the model
const SYNTH_MAX_TOKENS = 1024;
const SYNTH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 200;

// The contract_provisions.category controlled vocabulary (mirrors the CHECK
// constraint). A requested category must be one of these or the request is 400.
const VALID_CATEGORIES = new Set<string>([
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

type ClauseScope = "matter" | "tracked" | "explicit" | "all";
function parseScope(v: unknown): ClauseScope {
  return v === "matter" || v === "tracked" || v === "explicit" || v === "all"
    ? v
    : "all";
}

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Rate limit the model-backed clause endpoints per user (falling back to IP for
// the unauthenticated edge, which requireFirmSession rejects anyway).
const clauseAiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.session?.userId != null
      ? String(req.session.userId)
      : ipKeyGenerator(req.ip ?? ""),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error:
        "Too many requests in a short time. Please wait a moment and try again.",
    });
  },
});

// --- tiny in-memory TTL cache for identical (firm-scoped) requests ----------
interface CacheEntry {
  expires: number;
  value: unknown;
}
const responseCache = new Map<string, CacheEntry>();
function cacheGet(key: string): unknown | undefined {
  const e = responseCache.get(key);
  if (!e) return undefined;
  if (e.expires < Date.now()) {
    responseCache.delete(key);
    return undefined;
  }
  return e.value;
}
function cacheSet(key: string, value: unknown): void {
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    const first = responseCache.keys().next().value;
    if (first !== undefined) responseCache.delete(first);
  }
  responseCache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

interface ScopeResult {
  districtIds: number[];
  matterId: number | null;
  matterName: string | null;
}
type ScopeOutcome =
  | { ok: true; scope: ScopeResult }
  | { ok: false; status: number; error: string };

// Resolve + AUTHORIZE the district set for a clause request. Everything stays
// inside the firm's scope so every returned clause has a reachable source PDF.
// A cross-firm matter id is a 404 (no existence leak); an explicit id outside
// the firm scope is a 403; the whole request is rejected rather than silently
// dropping ids (a silent drop would hide an authorization mistake).
async function resolveScope(
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
      scope: { districtIds: ids, matterId: null, matterName: null },
    };
  }

  if (scope === "all") {
    const all = await firmScopeDistrictIds(firmId);
    return {
      ok: true,
      scope: { districtIds: [...all], matterId: null, matterName: null },
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
    scope: { districtIds, matterId: null, matterName: null },
  };
}

function prettyKey(key: string | null): string {
  if (!key) return "";
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ClauseRow {
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

function mapClauseRow(row: Record<string, unknown>): ClauseRow {
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
function latestContractCte(idList: ReturnType<typeof sql>, unit: string) {
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

// Best-effort grounded synthesis over the retrieved clauses. Never throws;
// returns null when the model is unavailable so the verbatim clauses (the real
// deliverable) are always returned. temperature/top_p/top_k are intentionally
// omitted (claude-opus-4-8 rejects them).
async function synthesize(
  model: string,
  system: string,
  userContent: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
  try {
    const msg = await anthropic.messages.create(
      {
        model,
        max_tokens: SYNTH_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: userContent }],
      },
      { signal: controller.signal },
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text || null;
  } catch (err) {
    logger.warn({ err }, "clause synthesis failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clauseBlock(c: ClauseRow): string {
  const excerpt =
    c.clauseExcerpt.length > SYNTH_MAX_EXCERPT_CHARS
      ? `${c.clauseExcerpt.slice(0, SYNTH_MAX_EXCERPT_CHARS)}…`
      : c.clauseExcerpt;
  const label = [c.districtName, prettyKey(c.provisionKey)]
    .filter(Boolean)
    .join(" — ");
  return `[#${c.provisionId}] ${label}:\n"""${excerpt}"""`;
}

const SEARCH_SYNTH_SYSTEM = `You are CollBar's clause-research assistant for K-12 labor attorneys. You are given a set of VERBATIM contract clauses, each tagged with a citation id like [#123]. Summarize and compare them to answer the user's query.
Strict rules:
- Only state what the provided clauses actually say. Never invent contract language, numbers, dates, or terms.
- Cite every factual statement with the clause id(s) it draws from, in square brackets, e.g. [#123].
- If the clauses do not address the query, say so plainly.
- Be concise: 2-5 sentences. Do not quote at length; the verbatim clauses are shown to the user separately.`;

const COMPARE_SYNTH_SYSTEM = `You are CollBar's clause-research assistant for K-12 labor attorneys. You are given the SAME contract provision as written in several districts' agreements, each VERBATIM and tagged with a citation id like [#123]. Explain how the language differs across districts.
Strict rules:
- Only state what the provided clauses actually say. Never invent contract language, numbers, dates, or terms.
- Cite every statement with the clause id(s) it draws from, e.g. [#123].
- Call out the material differences (and notable similarities) in the clause language and any figures.
- Be concise: 3-6 sentences. Do not quote at length; the verbatim clauses are shown to the user separately.`;

// ---------------------------------------------------------------------------
// POST /api/firm/clause-search
//   { query, scope?='all', matterId?, districtIds?, category?, provisionKey?,
//     bargainingUnit?='teachers', limit?<=50, synthesize?=true }
// Keyword search over verbatim clause language within the firm's scope. Returns
// ranked, verbatim, fully-cited clauses plus an optional grounded synthesis.
// A POST (not GET) because the scope/district set is sent in the body; it is a
// pure read with no side effects.
// ---------------------------------------------------------------------------
router.post(
  "/firm/clause-search",
  requireFirmSession(),
  clauseAiLimiter,
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const body = req.body as {
      query?: unknown;
      scope?: unknown;
      matterId?: unknown;
      districtIds?: unknown;
      category?: unknown;
      provisionKey?: unknown;
      bargainingUnit?: unknown;
      limit?: unknown;
      synthesize?: unknown;
    };

    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      res.status(400).json({ error: "A search query is required." });
      return;
    }
    if (query.length > MAX_QUERY_LEN) {
      res
        .status(400)
        .json({ error: `Query is too long (max ${MAX_QUERY_LEN} characters).` });
      return;
    }

    const scope = parseScope(body.scope);
    const unit = parseUnit(body.bargainingUnit);
    const matterId = toInt(body.matterId);
    const explicitIds = Array.isArray(body.districtIds)
      ? (body.districtIds as unknown[])
          .map(toInt)
          .filter((n): n is number => n != null)
      : null;

    let category: string | null = null;
    if (body.category != null && body.category !== "") {
      const c = String(body.category);
      if (!VALID_CATEGORIES.has(c)) {
        res.status(400).json({ error: "Unknown category." });
        return;
      }
      category = c;
    }
    let provisionKey: string | null = null;
    if (body.provisionKey != null && body.provisionKey !== "") {
      const k = String(body.provisionKey).trim();
      if (k && k.length <= MAX_KEY_LEN) provisionKey = k;
    }

    let limit = DEFAULT_RESULTS;
    const rawLimit = toInt(body.limit);
    if (rawLimit != null) limit = Math.min(rawLimit, MAX_RESULTS);

    const wantSynthesis = body.synthesize !== false;

    const outcome = await resolveScope(
      firm.firmId,
      scope,
      matterId,
      explicitIds,
    );
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    const districtIds = outcome.scope.districtIds;

    const baseResponse = {
      query,
      scope,
      bargainingUnit: unit,
      matterId: outcome.scope.matterId,
      matterName: outcome.scope.matterName,
      category,
      provisionKey,
      clauses: [] as ClauseRow[],
      synthesis: null as string | null,
    };

    if (districtIds.length === 0) {
      res.json(baseResponse);
      return;
    }
    if (districtIds.length > MAX_DISTRICTS) {
      res
        .status(400)
        .json({ error: `Too many districts in scope (max ${MAX_DISTRICTS}).` });
      return;
    }

    const cacheKey = JSON.stringify({
      f: firm.firmId,
      s: scope,
      m: outcome.scope.matterId,
      d: [...districtIds].sort((a, b) => a - b),
      q: query.toLowerCase(),
      c: category,
      k: provisionKey,
      u: unit,
      l: limit,
      y: wantSynthesis,
    });
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    try {
      const idList = sql.join(
        districtIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const filters = [
        sql`cp.clause_tsv @@ q.tsq`,
        sql`cp.clause_excerpt IS NOT NULL`,
        sql`btrim(cp.clause_excerpt) <> ''`,
        sql`sd.source_url IS NOT NULL`,
      ];
      if (category) filters.push(sql`cp.category = ${category}`);
      if (provisionKey) filters.push(sql`cp.provision_key = ${provisionKey}`);

      const r = await db.execute(sql`
        WITH latest_contract AS (${latestContractCte(idList, unit)}),
        q AS (SELECT websearch_to_tsquery('english', ${query}) AS tsq)
        SELECT
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
          sd.retrieved_at,
          ts_rank(cp.clause_tsv, q.tsq) AS rank
        FROM latest_contract lc
        JOIN contract_provisions cp ON cp.contract_id = lc.id
        JOIN districts d ON d.id = lc.district_id
        JOIN source_documents sd ON sd.id = lc.source_doc_id
        CROSS JOIN q
        WHERE ${sql.join(filters, sql` AND `)}
        ORDER BY rank DESC,
                 cp.human_verified DESC NULLS LAST,
                 cp.confidence DESC NULLS LAST,
                 cp.id DESC
        LIMIT ${limit}
      `);
      const clauses = (r.rows as Array<Record<string, unknown>>).map(
        mapClauseRow,
      );

      let synthesis: string | null = null;
      if (wantSynthesis && clauses.length > 0) {
        const blocks = clauses
          .slice(0, SYNTH_MAX_CLAUSES)
          .map(clauseBlock)
          .join("\n\n");
        const userContent = `Query: ${query}\n\nVerbatim clauses:\n\n${blocks}`;
        synthesis = await synthesize(
          SEARCH_MODEL,
          SEARCH_SYNTH_SYSTEM,
          userContent,
        );
      }

      const response = { ...baseResponse, clauses, synthesis };
      cacheSet(cacheKey, response);
      res.json(response);
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "clause search failed");
      res.status(500).json({ error: "Clause search failed." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/firm/clause-compare
//   { provisionKey?, scope?='all', matterId?, districtIds?,
//     bargainingUnit?='teachers', synthesize?=true }
// Side-by-side verbatim text of ONE provision type across the firm's scoped
// districts. Always returns the provision types actually available in scope (for
// the picker); when provisionKey is given, also returns the best clause per
// district + an optional grounded comparison synthesis.
// ---------------------------------------------------------------------------
router.post(
  "/firm/clause-compare",
  requireFirmSession(),
  clauseAiLimiter,
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const body = req.body as {
      provisionKey?: unknown;
      scope?: unknown;
      matterId?: unknown;
      districtIds?: unknown;
      bargainingUnit?: unknown;
      synthesize?: unknown;
    };

    const scope = parseScope(body.scope);
    const unit = parseUnit(body.bargainingUnit);
    const matterId = toInt(body.matterId);
    const explicitIds = Array.isArray(body.districtIds)
      ? (body.districtIds as unknown[])
          .map(toInt)
          .filter((n): n is number => n != null)
      : null;
    let provisionKey: string | null = null;
    if (body.provisionKey != null && body.provisionKey !== "") {
      const k = String(body.provisionKey).trim();
      if (k && k.length <= MAX_KEY_LEN) provisionKey = k;
    }
    const wantSynthesis = body.synthesize !== false;

    const outcome = await resolveScope(
      firm.firmId,
      scope,
      matterId,
      explicitIds,
    );
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    const districtIds = outcome.scope.districtIds;

    const base = {
      scope,
      bargainingUnit: unit,
      matterId: outcome.scope.matterId,
      matterName: outcome.scope.matterName,
      provisionKey,
      availableTypes: [] as Array<{
        category: string | null;
        provisionKey: string;
        districtCount: number;
      }>,
      clauses: [] as ClauseRow[],
      synthesis: null as string | null,
    };

    if (districtIds.length === 0) {
      res.json(base);
      return;
    }
    if (districtIds.length > MAX_DISTRICTS) {
      res
        .status(400)
        .json({ error: `Too many districts in scope (max ${MAX_DISTRICTS}).` });
      return;
    }

    try {
      const idList = sql.join(
        districtIds.map((id) => sql`${id}`),
        sql`, `,
      );

      // The provision types actually present across the scoped districts' latest
      // contracts (drives the picker). Count = districts carrying each type.
      const typesRes = await db.execute(sql`
        WITH latest_contract AS (${latestContractCte(idList, unit)})
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
      const availableTypes = (typesRes.rows as Array<Record<string, unknown>>).map(
        (row) => ({
          category: row.category == null ? null : String(row.category),
          provisionKey: String(row.provision_key),
          districtCount: Number(row.district_count),
        }),
      );

      let clauses: ClauseRow[] = [];
      if (provisionKey) {
        const cmp = await db.execute(sql`
          WITH latest_contract AS (${latestContractCte(idList, unit)})
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
          WHERE cp.provision_key = ${provisionKey}
            AND cp.clause_excerpt IS NOT NULL
            AND btrim(cp.clause_excerpt) <> ''
            AND sd.source_url IS NOT NULL
          ORDER BY lc.district_id,
                   cp.human_verified DESC NULLS LAST,
                   cp.confidence DESC NULLS LAST,
                   cp.id DESC
        `);
        clauses = (cmp.rows as Array<Record<string, unknown>>).map(mapClauseRow);
        // Stable side-by-side order: by district name.
        clauses.sort((a, b) => a.districtName.localeCompare(b.districtName));
      }

      let synthesis: string | null = null;
      if (wantSynthesis && provisionKey && clauses.length > 1) {
        const blocks = clauses
          .slice(0, SYNTH_MAX_CLAUSES)
          .map(clauseBlock)
          .join("\n\n");
        const userContent = `Provision type: ${prettyKey(
          provisionKey,
        )}\n\nThe same provision across districts (verbatim):\n\n${blocks}`;
        synthesis = await synthesize(
          COMPARE_MODEL,
          COMPARE_SYNTH_SYSTEM,
          userContent,
        );
      }

      res.json({ ...base, availableTypes, clauses, synthesis });
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "clause compare failed");
      res.status(500).json({ error: "Clause comparison failed." });
    }
  },
);

export default router;
