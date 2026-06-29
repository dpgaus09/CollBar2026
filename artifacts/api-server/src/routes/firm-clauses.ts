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
import { parseUnit } from "./bargaining-units.js";
import { logger } from "../lib/logger.js";
import {
  MAX_DISTRICTS,
  MAX_KEY_LEN,
  parseScope,
  toInt,
  prettyKey,
  resolveScope,
  mapClauseRow,
  latestContractCte,
  latestContractCteForState,
  buildClauseCompare,
  type ClauseRow,
} from "../lib/firm-clauses-model.js";

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
// the firm workspace — NOT gate()/isFree(). The matter/tracked/all/explicit
// scopes stay inside the firm's own scope (roster ∪ matter districts). The
// "database" scope deliberately widens retrieval to EVERY district in
// CUSTOMER_STATE (IL) — the whole in-state corpus, not just this firm's
// workspace; out-of-state districts (OH) stay hidden. Every returned clause's
// source PDF remains reachable through GET /api/firm/document, whose firm-scope
// authorization was correspondingly broadened to allow any firm member to open
// an in-state (CUSTOMER_STATE) document.
// ============================================================================

const router: IRouter = Router();

const SEARCH_MODEL = "claude-haiku-4-5"; // fast model for search synthesis
const COMPARE_MODEL = "claude-opus-4-8"; // strongest model for multi-clause compare
const MAX_QUERY_LEN = 300;
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

// --- Prompt caching --------------------------------------------------------
// The clause-search / clause-compare synthesis calls re-send a fixed, static
// system prompt on every request. Anthropic prompt caching stores that prefix
// and re-reads it at ~1/10th the input price — the exact technique already
// proven on the Ask engine (see ask-engine.ts buildSystem). The cache is
// matched in the order system -> messages, so a single ephemeral breakpoint on
// the system block caches the whole static prefix. Caching only affects cost;
// the synthesized answer is unchanged.
//
// `promptCachingEnabled` is a process-level safety latch: if the upstream proxy
// ever rejects the cache_control field with a 400, we disable it and fall back
// to the plain (uncached) request shape for the rest of the process rather than
// failing synthesis.
//
// VERIFIED (prod): no cache currently lands. The breakpoint can only cache the
// system prefix (cache order is tools -> system -> messages; the bulk input —
// the retrieved clauses — lives in the user message AFTER the breakpoint and
// varies per query, so it can never form a stable cacheable prefix). The two
// SYNTH_SYSTEM prompts are ~150 tokens, far below Anthropic's minimum cacheable
// prefix (1024 opus / 2048 haiku), so cache_creation/cache_read stay 0 and the
// "clause synthesis prompt-cache usage" line below never fires in production.
// DECISION: accept the negligible per-call savings — identical-request reuse is
// already covered by the in-memory responseCache (it serves repeats with zero
// model calls). The mechanism is left in place because it is harmless, degrades
// cleanly, and auto-realizes a real win if these synth prompts ever grow past
// the minimum cacheable size.
let promptCachingEnabled = true;

// The Anthropic SDK is imported as a type only, so detect a request-validation
// rejection (HTTP 400) by shape rather than `instanceof`.
function isBadRequest(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: number }).status === 400
  );
}

// Build the `system` field: an array carrying an ephemeral cache breakpoint when
// caching is on (caches the static system prefix), or the plain string otherwise.
function buildSynthSystem(
  system: string,
  useCache: boolean,
): string | Anthropic.TextBlockParam[] {
  if (!useCache) return system;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
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
  // Snapshot the latch locally so a *concurrent* request that turns caching off
  // can't make THIS in-flight request skip its own safe retry.
  const attemptedCache = promptCachingEnabled;
  const createOnce = (useCache: boolean) =>
    anthropic.messages.create(
      {
        model,
        max_tokens: SYNTH_MAX_TOKENS,
        system: buildSynthSystem(system, useCache),
        messages: [{ role: "user", content: userContent }],
      },
      { signal: controller.signal },
    );
  try {
    let msg: Anthropic.Message;
    try {
      msg = await createOnce(attemptedCache);
    } catch (err) {
      // A cache_control rejection is a request-validation 400; latch caching off
      // and retry once with the plain shape so synthesis still succeeds. Any
      // other failure (or a second failure) propagates to the catch below, which
      // degrades to synthesis=null.
      if (attemptedCache && isBadRequest(err)) {
        promptCachingEnabled = false;
        logger.warn(
          { err, model },
          "clause synthesis: prompt caching rejected (HTTP 400); disabling and retrying without it",
        );
        msg = await createOnce(false);
      } else {
        throw err;
      }
    }
    // usage may be absent (e.g. mocked clients); coalesce. When caching is
    // active, input_tokens is only the UNcached portion, so log the cache counts
    // separately to confirm cache reads land on rapid repeat searches/compares.
    const cacheCreate = msg.usage?.cache_creation_input_tokens ?? 0;
    const cacheRead = msg.usage?.cache_read_input_tokens ?? 0;
    if (cacheCreate > 0 || cacheRead > 0) {
      logger.info(
        {
          model,
          inputTokens: msg.usage?.input_tokens ?? 0,
          cacheCreate,
          cacheRead,
        },
        "clause synthesis prompt-cache usage",
      );
    }
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
    const scopeResult = outcome.scope;

    const baseResponse = {
      query,
      scope,
      bargainingUnit: unit,
      matterId: scopeResult.matterId,
      matterName: scopeResult.matterName,
      category,
      provisionKey,
      clauses: [] as ClauseRow[],
      synthesis: null as string | null,
    };

    // Only the bounded workspace scopes short-circuit on empty / reject over the
    // MAX_DISTRICTS cap. The whole-state "database" scope skips both and is
    // bounded by the result LIMIT below.
    if (scopeResult.kind === "districts") {
      if (scopeResult.districtIds.length === 0) {
        res.json(baseResponse);
        return;
      }
      if (scopeResult.districtIds.length > MAX_DISTRICTS) {
        res.status(400).json({
          error: `Too many districts in scope (max ${MAX_DISTRICTS}).`,
        });
        return;
      }
    }

    // The cache key must distinguish scope KIND + state from a district list:
    // "database" carries no ids, so keying only on a (here-absent) id list would
    // collide with a genuinely-empty workspace scope.
    const cacheKey = JSON.stringify({
      f: firm.firmId,
      s: scope,
      m: scopeResult.matterId,
      st: scopeResult.kind === "state" ? scopeResult.state : null,
      d:
        scopeResult.kind === "districts"
          ? [...scopeResult.districtIds].sort((a, b) => a - b)
          : null,
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
      const contractCte =
        scopeResult.kind === "state"
          ? latestContractCteForState(unit, scopeResult.state)
          : latestContractCte(
              sql.join(
                scopeResult.districtIds.map((id) => sql`${id}`),
                sql`, `,
              ),
              unit,
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
        WITH latest_contract AS (${contractCte}),
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

    try {
      // Single source of truth: the clause-appendix export builder calls the
      // same buildClauseCompare(), so a generated appendix renders byte-for-byte
      // the verbatim clauses + citations the UI shows.
      const result = await buildClauseCompare(firm.firmId, {
        scope,
        matterId,
        districtIds: explicitIds,
        unit,
        provisionKey,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      const { availableTypes, clauses } = result.data;

      // Best-effort grounded synthesis over the retrieved clauses — a route-only
      // layer that never alters the verbatim clauses or their citations.
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

      res.json({
        scope,
        bargainingUnit: unit,
        matterId: result.data.matterId,
        matterName: result.data.matterName,
        provisionKey,
        availableTypes,
        clauses,
        synthesis,
      });
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "clause compare failed");
      res.status(500).json({ error: "Clause comparison failed." });
    }
  },
);

export default router;
