// Provision/retirement/benefits/leaves extraction (vision-primary), Task #174.
// Ported from pipeline/06_extract_contracts.py + prompts/v1_il.txt, but where the
// Python pipeline fed Claude the raw text layer, this engine is vision-primary:
//
//   1. Page selection (bounded cost):
//      - small docs: extract every page (up to a small cap);
//      - digital docs: a FREE text-layer keyword triage picks the article pages
//        that carry provisions (compensation/insurance/leave/retirement/...),
//        expanded by +/-1 page;
//      - scanned docs (no usable text layer): a cheap low-res VISION triage finds
//        the candidate pages instead.
//   2. The selected pages are rendered high-res and sent to Claude in batches; the
//      per-contract provision objects are merged across batches.
//   3. Option B text-layer verification (provisions-verify) corroborates $/%
//      values against the digital text where present.
//
// Fail-closed: a truncated batch is retried once at half size; if still truncated
// the WHOLE document extraction fails (no partial rows, nothing cached). Results
// are cached by (file_hash, request_hash) so a re-run skips the paid calls.

import { openPdf, RENDER_VERSION, type PdfDoc } from "../pdf/renderer";
import { callVision, DEFAULT_MODEL, type VisionBlock } from "../vision/client";
import { extractJsonArray, classifyBatchResponse } from "../vision/parse";
import { requestHash, getCached, putCached } from "../cache";
import { costFromUsage } from "../cost";
import { logger } from "../../lib/logger";
import type {
  ExtractedContract,
  ExtractionStatus,
  ProvisionCategory,
  ProvisionItem,
} from "../types";

const DOMAIN = "provisions";
// Bump when the prompt or normalization changes so the cache misses old results.
export const PROVISIONS_PROMPT_VERSION = "provisions-v2";

// Triage (scanned-doc fallback): low-res thumbnails locate provision pages.
const TRIAGE_DPI = 60;
const TRIAGE_MAX_PX = 900;
const TRIAGE_BATCH = 12;
const TRIAGE_MAX_TOKENS = 4096;

// Extraction: higher-res so figures read cleanly.
const EXTRACT_DPI = 150;
const EXTRACT_MAX_PX = 1600;
const EXTRACT_MAX_TOKENS = 12000;
const EXTRACT_BATCH = 8; // pages per extraction request

export const MAX_PROVISION_PAGES = 60; // hard cap on tier-1 high-res extraction pages
const DEEP_MAX_PAGES = 100; // cap for the no-triage completeness deep-retry pass
const SMALL_DOC_PAGES = 6; // docs this small skip triage (extract every page)
const MIN_PAGE_TEXT_CHARS = 40; // a page with less text is treated as scanned
const DIGITAL_DOC_MIN_CHARS = 1000; // whole-doc text below this => scanned doc

const ALLOWED_CATEGORIES = new Set<ProvisionCategory>([
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

// Article keywords that mark a page as carrying provision data. Uppercased
// substring match against the page text layer.
const PROVISION_KEYWORDS = [
  "SALARY", "COMPENSATION", "WAGE", "STIPEND", "STEP", "LANE",
  "INSURANCE", "HEALTH", "PREMIUM", "DENTAL", "VISION", "MEDICAL", "HSA", "HRA",
  "RETIREMENT", "TRS", "IMRF", "PENSION", "PICKUP", "PICK-UP",
  "LEAVE", "SICK", "PERSONAL DAY", "BEREAVEMENT", "VACATION",
  "WORK DAY", "WORKDAY", "CONTRACT DAY", "INSTRUCTIONAL", "CALENDAR",
  "EVALUATION", "PERA", "DANIELSON",
  "REDUCTION IN FORCE", "HONORABLE DISMISSAL", "RECALL", "LAYOFF", "RIF",
  "GRIEVANCE", "ARBITRATION",
];

const EXTRACT_PROMPT =
  "You are a contract data extraction specialist for Illinois K-12 collective " +
  "bargaining agreements (CBAs). You are reading scanned pages from one CBA. " +
  "Each image is one PDF page, labeled '=== PDF page N ===' just before it.\n\n" +
  "Extract structured data from these pages. Output ONLY valid JSON matching the " +
  "schema below — no prose, no markdown fences.\n\n" +
  "## Illinois context\n" +
  "- Retirement: TRS (certified/licensed staff) vs IMRF (classified/support). " +
  "Note Tier 1 vs Tier 2 if stated. Employer TRS pickup of the 9.4% employee " +
  "contribution is retirement_pickup_pct.\n" +
  "- Salary lanes: BA, BA+15, BA+30, MA, MA+30, MA+45, PhD by experience step.\n" +
  "- Leave: IL law grants >= 10 sick days/year; many contracts exceed this.\n\n" +
  "## Output schema\n" +
  "{\n" +
  '  "contracts": [\n' +
  "    {\n" +
  '      "bargaining_unit": "canonical category, EXACTLY one of: teachers, ' +
  "paraprofessionals, custodial_maintenance, transportation, " +
  "secretarial_clerical, food_service, nurses, administrators, support_staff, " +
  'other",\n' +
  '      "unit_scope": "verbatim bargaining unit description, or null",\n' +
  '      "provisions": [\n' +
  "        {\n" +
  '          "category": "one of: compensation, insurance, retirement, leave, ' +
  'workday, evaluation, rif, grievance, other",\n' +
  '          "provision_key": "snake_case identifier — see key list",\n' +
  '          "value_numeric": number_or_null,\n' +
  '          "value_text": "human-readable value, or null",\n' +
  '          "unit": "e.g. \'%\', \'$\', \'days\', \'hours\', or null",\n' +
  '          "clause_excerpt": "verbatim text (<= 80 words) supporting the value",\n' +
  '          "page_ref": integer_page_number_or_null,\n' +
  '          "confidence": 0.0_to_1.0\n' +
  "        }\n" +
  "      ]\n" +
  "    }\n" +
  "  ]\n" +
  "}\n\n" +
  "## Provision keys (extract all that appear)\n" +
  "compensation: base_salary_increase_yr1, base_salary_increase_yr2, " +
  "base_salary_increase_yr3, step_increase, lane_advancement_allowed, " +
  "off_schedule_bonus_yr1, ba_min_salary, ba_max_salary, ma_min_salary, " +
  "ma_max_salary, salary_steps_count, salary_lanes_count\n" +
  "insurance: health_single_premium, health_family_premium, " +
  "employee_premium_share_pct, dental_coverage, vision_coverage, " +
  "hsa_employer_contribution\n" +
  "retirement: retirement_pickup_pct, retirement_system, trs_tier\n" +
  "leave: sick_days_annual, personal_days_annual, bereavement_days, " +
  "sick_leave_max_days\n" +
  "workday: contract_days_teacher, instructional_minutes_day\n" +
  "evaluation: evaluation_cycle_years\n" +
  "rif: rif_recall_years\n" +
  "grievance: grievance_steps, arbitration_binding\n\n" +
  "## Rules\n" +
  "1. If a field is absent or cannot be determined, set it to null.\n" +
  "2. clause_excerpt MUST be verbatim, truncated to <= 80 words. Never paraphrase.\n" +
  "3. confidence: 0.95+ explicit numeric; 0.80-0.94 clearly implied; 0.50-0.79 " +
  "inferred/ambiguous; < 0.50 very uncertain (include with low confidence).\n" +
  "4. If these pages show more than one agreement (e.g. teachers AND support " +
  "staff), output one contract object per agreement.\n" +
  "5. Do not fabricate values or infer percentages from incomplete data.\n" +
  "6. page_ref is the PDF page number from the '=== PDF page N ===' label where " +
  "the value appears.\n" +
  "7. bargaining_unit MUST be exactly one canonical value. Use 'teachers' for " +
  "certificated/licensed teaching staff; 'support_staff' for a combined " +
  "non-certified unit. If you cannot tell from these pages, set it to null.\n" +
  "8. If no provision data is present on these pages, return {\"contracts\": []}.\n" +
  "Output only the JSON object, no prose.";

const TRIAGE_PROMPT =
  "Which of the labeled pages discuss collective-bargaining TERMS such as " +
  "salary/compensation, insurance/health premiums, retirement (TRS/IMRF), leave " +
  "(sick/personal/bereavement), work day/calendar, evaluation, reduction in " +
  "force/recall, or grievance/arbitration? Return ONLY a JSON array of the page " +
  "numbers, e.g. [3,4,12]. If none, return [].";

function imgBlock(base64: string): VisionBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: base64 },
  };
}

// ----- normalization (exported for unit tests) -----

function snakeKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function coerceNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[$,%\s]/g, "");
  if (!s || ["null", "none", "-"].includes(s.toLowerCase())) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function coerceInt(v: unknown): number | null {
  const n = coerceNum(v);
  if (n === null) return null;
  const i = Math.trunc(n);
  return i >= 1 ? i : null;
}

function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function truncateWords(s: string, max = 80): string {
  const words = s.trim().split(/\s+/);
  return words.length <= max ? s.trim() : words.slice(0, max).join(" ");
}

// Richer-of-two for (category, provision_key) dedupe: prefer a row that has a
// page_ref, then a value, then a longer excerpt, then higher confidence.
function provRichness(p: ProvisionItem): number[] {
  return [
    p.pageRef !== null ? 1 : 0,
    p.valueNumeric !== null || p.valueText ? 1 : 0,
    p.clauseExcerpt ? p.clauseExcerpt.length : 0,
    p.confidence,
  ];
}

function richerGt(a: ProvisionItem, b: ProvisionItem): boolean {
  const ra = provRichness(a);
  const rb = provRichness(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i];
  }
  return false;
}

// Validate + normalize the model's provision objects. Invalid individual
// provisions are dropped (never fail the whole doc). A provision with no page_ref
// has its confidence capped to 0.6 so it routes to the (<0.8) human-review queue.
export function normalizeProvisions(raw: unknown): ProvisionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ProvisionItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const p = r as Record<string, unknown>;

    const category = String(p.category ?? "").trim().toLowerCase();
    if (!ALLOWED_CATEGORIES.has(category as ProvisionCategory)) continue;

    const provisionKey = snakeKey(String(p.provision_key ?? ""));
    if (!provisionKey) continue;

    const valueNumeric = coerceNum(p.value_numeric);
    const valueText = p.value_text ? String(p.value_text).trim() || null : null;
    // A provision with neither a numeric nor a text value carries no information.
    if (valueNumeric === null && !valueText) continue;

    const unit = p.unit ? String(p.unit).trim() || null : null;
    const clauseExcerpt = p.clause_excerpt
      ? truncateWords(String(p.clause_excerpt)) || null
      : null;
    const pageRef = coerceInt(p.page_ref);
    let confidence = clampConfidence(p.confidence);
    if (pageRef === null) confidence = Math.min(confidence, 0.6);

    out.push({
      category: category as ProvisionCategory,
      provisionKey,
      valueNumeric,
      valueText,
      unit,
      clauseExcerpt,
      pageRef,
      confidence,
    });
  }
  return out;
}

// Dedupe a unit's provisions by (category, provision_key), keeping the richer.
export function dedupeProvisions(items: ProvisionItem[]): ProvisionItem[] {
  const best = new Map<string, ProvisionItem>();
  for (const p of items) {
    const key = `${p.category}\u0000${p.provisionKey}`;
    const prev = best.get(key);
    if (!prev || richerGt(p, prev)) best.set(key, p);
  }
  return [...best.values()];
}

function normalizeContractObject(raw: unknown): ExtractedContract | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const bu = c.bargaining_unit ? String(c.bargaining_unit).trim().toLowerCase() : null;
  const provisions = normalizeProvisions(c.provisions);
  return {
    bargainingUnit: bu || null,
    unitScope: c.unit_scope ? String(c.unit_scope).trim() || null : null,
    provisions,
  };
}

// Merge contract objects across batches: provisions for the same bargaining unit
// (or the same null/unknown bucket) accumulate, then dedupe per unit at the end.
export function mergeContracts(
  batches: ExtractedContract[][],
): ExtractedContract[] {
  const byUnit = new Map<string, ExtractedContract>();
  for (const batch of batches) {
    for (const c of batch) {
      const key = c.bargainingUnit ?? "\u0000default";
      const prev = byUnit.get(key);
      if (prev) {
        prev.provisions.push(...c.provisions);
        if (!prev.unitScope && c.unitScope) prev.unitScope = c.unitScope;
      } else {
        byUnit.set(key, {
          bargainingUnit: c.bargainingUnit,
          unitScope: c.unitScope,
          provisions: [...c.provisions],
        });
      }
    }
  }
  return [...byUnit.values()].map((c) => ({
    ...c,
    provisions: dedupeProvisions(c.provisions),
  }));
}

// ----- page selection -----

// FREE text-layer triage: pages whose text mentions a provision article AND
// contains a digit, expanded by +/-1 page so values that spill to the next page
// are captured. Returns 0-based page indexes.
export function keywordTriagePages(
  pageTexts: string[],
  opts?: { minChars?: number },
): number[] {
  const minChars = opts?.minChars ?? MIN_PAGE_TEXT_CHARS;
  const npages = pageTexts.length;
  const hits = new Set<number>();
  for (let i = 0; i < npages; i++) {
    const t = pageTexts[i] ?? "";
    if (t.length < minChars) continue;
    if (!/\d/.test(t)) continue;
    const up = t.toUpperCase();
    if (PROVISION_KEYWORDS.some((kw) => up.includes(kw))) hits.add(i);
  }
  const expanded = new Set<number>();
  for (const i of hits) {
    for (const d of [-1, 0, 1]) {
      const j = i + d;
      if (j >= 0 && j < npages) expanded.add(j);
    }
  }
  return [...expanded].sort((a, b) => a - b);
}

interface TriageResult {
  pages: number[];
  inputTokens: number;
  outputTokens: number;
  model: string;
}

// Fail-closed sentinels: a truncated or unparseable model response must abort
// extraction (status -> truncated / parse_error) so no store or cache occurs.
class TruncatedError extends Error {}
class ParseError extends Error {}

// Scanned-doc fallback: low-res vision triage. Mirrors the salary domain.
async function visionTriagePages(
  doc: PdfDoc,
  npages: number,
  model: string,
): Promise<TriageResult> {
  const found = new Set<number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let resolvedModel = model;
  for (let start = 0; start < npages; start += TRIAGE_BATCH) {
    const end = Math.min(start + TRIAGE_BATCH, npages);
    const blocks: VisionBlock[] = [];
    for (let i = start; i < end; i++) {
      blocks.push({ type: "text", text: `=== PDF page ${i + 1} ===` });
      blocks.push(imgBlock(doc.renderPage(i, { dpi: TRIAGE_DPI, maxPx: TRIAGE_MAX_PX }).base64));
    }
    blocks.push({ type: "text", text: TRIAGE_PROMPT });
    const resp = await callVision({ blocks, maxTokens: TRIAGE_MAX_TOKENS, model });
    inputTokens += resp.usage.inputTokens;
    outputTokens += resp.usage.outputTokens;
    resolvedModel = resp.model;
    // Fail-closed: an unreliable triage batch must abort the whole extraction.
    // A truncated or unparseable triage response leaves the candidate page set
    // unknown; proceeding would extract from a partial set, and the downstream
    // delete-then-insert store would silently drop provisions on un-triaged
    // pages. Surface it as truncated/parse_error so the doc is never stored.
    if (resp.truncated) {
      throw new TruncatedError(
        `provisions vision triage truncated on pages ${start + 1}-${end}`,
      );
    }
    // The triage prompt asks for a top-level JSON array (e.g. [3,4,12]). Use the
    // tolerant array extractor (handles code fences / surrounding prose), mirroring
    // the salary domain — a bare-array reconstruction via extractJsonObject broke
    // whenever the model wrapped the array in a fence or prose, falsely tripping
    // the fail-closed ParseError and storing zero provisions. A genuinely
    // unparseable response (no array at all) still fails closed.
    const arr = extractJsonArray(resp.text);
    if (arr === null) {
      throw new ParseError(
        `provisions vision triage returned no parseable page list on pages ${start + 1}-${end}`,
      );
    }
    for (const x of arr) {
      const p = Number(x);
      if (Number.isFinite(p) && p >= 1 && p <= npages) found.add(Math.trunc(p) - 1);
    }
  }
  return {
    pages: [...found].sort((a, b) => a - b),
    inputTokens,
    outputTokens,
    model: resolvedModel,
  };
}

// ----- extraction -----

export interface ProvisionsExtractionResult {
  contracts: ExtractedContract[];
  // ok === (status === "success"); only an ok result may be stored or cached.
  ok: boolean;
  status: ExtractionStatus;
  fromCache: boolean;
  truncated: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelVersion: string;
  pageCount: number;
  pagesExtracted: number[];
  // Pages that could not be extracted even at single-page granularity (rare).
  pagesSkipped: number[];
  // True when the cheap triaged pass came back empty and a no-triage deep pass ran.
  deepRetried: boolean;
}

export async function extractProvisions(
  buf: Buffer,
  fileHash: string,
  opts?: { model?: string; maxPages?: number; useCache?: boolean },
): Promise<ProvisionsExtractionResult> {
  const model = opts?.model ?? DEFAULT_MODEL;
  const maxPages = opts?.maxPages ?? MAX_PROVISION_PAGES;
  const useCache = opts?.useCache ?? true;

  // page_set is data-dependent (triage), so it is NOT in the request hash; the
  // hash pins the deterministic knobs and the cache is keyed by file content.
  const reqHash = requestHash({
    domain: DOMAIN,
    model,
    promptVersion: PROVISIONS_PROMPT_VERSION,
    renderVersion: RENDER_VERSION,
    triageDpi: TRIAGE_DPI,
    triageMaxPx: TRIAGE_MAX_PX,
    extractDpi: EXTRACT_DPI,
    extractMaxPx: EXTRACT_MAX_PX,
    extractMaxTokens: EXTRACT_MAX_TOKENS,
    extractBatch: EXTRACT_BATCH,
    maxPages,
    smallDocPages: SMALL_DOC_PAGES,
  });

  if (useCache && fileHash) {
    const hit = await getCached(fileHash, reqHash);
    if (hit) {
      return {
        contracts: (hit.normalized as ExtractedContract[]) ?? [],
        ok: true,
        status: "success",
        fromCache: true,
        truncated: false,
        inputTokens: hit.inputTokens,
        outputTokens: hit.outputTokens,
        costUsd: hit.estimatedCostUsd,
        modelVersion: hit.modelVersion,
        pageCount: 0,
        pagesExtracted: [],
        pagesSkipped: [],
        deepRetried: false,
      };
    }
  }

  const doc = await openPdf(buf);
  const pageCount = doc.pageCount;
  let inputTokens = 0;
  let outputTokens = 0;
  let modelVersion = model;
  let status: ExtractionStatus = "success";
  let contracts: ExtractedContract[] = [];
  let pagesExtracted: number[] = [];
  const pagesSkipped: number[] = [];
  let deepRetried = false;
  let rawResponse: string | null = null;

  // Render + extract one batch. Fail-closed at PAGE granularity (not whole-doc):
  // a truncated or unparseable batch is split and retried smaller so one bad page
  // cannot discard the entire document's provisions. A single page that still
  // fails is skipped (recorded in pagesSkipped) rather than thrown — losing one
  // page is strictly better than losing everything. Each page is still extracted
  // whole, so the no-partial-JSON guarantee holds per page.
  async function extractBatch(pages: number[]): Promise<ExtractedContract[]> {
    const blocks: VisionBlock[] = [];
    for (const i of pages) {
      blocks.push({ type: "text", text: `=== PDF page ${i + 1} ===` });
      blocks.push(imgBlock(doc.renderPage(i, { dpi: EXTRACT_DPI, maxPx: EXTRACT_MAX_PX }).base64));
    }
    blocks.push({ type: "text", text: EXTRACT_PROMPT });
    const resp = await callVision({ blocks, maxTokens: EXTRACT_MAX_TOKENS, model });
    inputTokens += resp.usage.inputTokens;
    outputTokens += resp.usage.outputTokens;
    modelVersion = resp.model;
    rawResponse = resp.text;

    const outcome = classifyBatchResponse(resp.text, resp.truncated, "contracts");
    if (outcome.ok) {
      return outcome.items
        .map((c) => normalizeContractObject(c))
        .filter((c): c is ExtractedContract => c !== null);
    }
    if (pages.length > 1) {
      const mid = Math.ceil(pages.length / 2);
      const a = await extractBatch(pages.slice(0, mid));
      const b = await extractBatch(pages.slice(mid));
      return [...a, ...b];
    }
    pagesSkipped.push(pages[0]);
    logger.warn(
      { fileHash, page: pages[0] + 1, reason: outcome.reason },
      "provisions: skipping unextractable page (fail-closed per-page)",
    );
    return [];
  }

  // Run the per-page-resilient extraction over a page set and merge across batches.
  async function runBatches(pageSet: number[]): Promise<ExtractedContract[]> {
    const batches: ExtractedContract[][] = [];
    for (let i = 0; i < pageSet.length; i += EXTRACT_BATCH) {
      batches.push(await extractBatch(pageSet.slice(i, i + EXTRACT_BATCH)));
    }
    return mergeContracts(batches);
  }

  try {
    let pages: number[];
    if (pageCount <= SMALL_DOC_PAGES) {
      pages = Array.from({ length: pageCount }, (_, i) => i);
    } else {
      const pageTexts = Array.from({ length: pageCount }, (_, i) => doc.pageText(i));
      const totalChars = pageTexts.reduce((n, t) => n + t.length, 0);
      if (totalChars >= DIGITAL_DOC_MIN_CHARS) {
        pages = keywordTriagePages(pageTexts);
        logger.info(
          { fileHash, pageCount, candidates: pages.length },
          "provisions: digital keyword triage",
        );
      } else {
        const loc = await visionTriagePages(doc, pageCount, model);
        pages = loc.pages;
        inputTokens += loc.inputTokens;
        outputTokens += loc.outputTokens;
        modelVersion = loc.model;
        logger.info(
          { fileHash, pageCount, candidates: pages.length },
          "provisions: scanned-doc vision triage",
        );
      }
    }

    if (pages.length > maxPages) {
      logger.info(
        { candidates: pages.length, cap: maxPages },
        "provisions: candidate pages > cap; truncating page set",
      );
      pages = pages.slice(0, maxPages);
    }

    if (pages.length) {
      pagesExtracted = pages;
      contracts = await runBatches(pages);
    } else {
      logger.info({ fileHash }, "provisions: no candidate pages located");
    }

    // Completeness deep-retry. The cheap triaged tier-1 pass can come back empty
    // when triage missed the provision articles entirely. Rather than silently
    // store zero provisions, escalate ONCE to a no-triage deep pass over every
    // page (bounded by DEEP_MAX_PAGES). This is what makes extraction reliable:
    // a unit never ends up with no provisions when the data is in the document.
    const tier1Empty = contracts.every((c) => c.provisions.length === 0);
    if (tier1Empty && pageCount > SMALL_DOC_PAGES) {
      deepRetried = true;
      const deepCap = Math.min(pageCount, DEEP_MAX_PAGES);
      const allPages = Array.from({ length: deepCap }, (_, i) => i);
      logger.info(
        { fileHash, pageCount, deepCap },
        "provisions: tier-1 empty — deep retry over all pages",
      );
      const deep = await runBatches(allPages);
      if (deep.some((c) => c.provisions.length > 0)) {
        pagesExtracted = allPages;
        contracts = deep;
      }
    }
  } catch (err) {
    if (err instanceof TruncatedError) {
      status = "truncated";
      contracts = [];
      logger.warn({ fileHash, err: err.message }, "provisions extraction truncated; not storing (fail-closed)");
    } else if (err instanceof ParseError) {
      status = "parse_error";
      contracts = [];
      logger.warn({ fileHash, err: err.message }, "provisions extraction unparseable; not storing (fail-closed)");
    } else {
      doc.destroy();
      throw err;
    }
  }
  doc.destroy();

  const costUsd = costFromUsage(modelVersion, inputTokens, outputTokens);

  if (useCache && fileHash && status === "success") {
    try {
      await putCached({
        fileHash,
        requestHash: reqHash,
        domain: DOMAIN,
        model,
        modelVersion,
        promptVersion: PROVISIONS_PROMPT_VERSION,
        renderVersion: RENDER_VERSION,
        pageSet: pagesExtracted.length
          ? pagesExtracted.map((p) => p + 1).join(",")
          : "none",
        status: "success",
        rawResponse,
        normalized: contracts,
        inputTokens,
        outputTokens,
        estimatedCostUsd: costUsd,
        finishReason: "end_turn",
      });
    } catch (err) {
      logger.warn({ err, fileHash }, "failed to cache provisions extraction");
    }
  }

  return {
    contracts,
    ok: status === "success",
    status,
    fromCache: false,
    truncated: status === "truncated",
    inputTokens,
    outputTokens,
    costUsd,
    modelVersion,
    pageCount,
    pagesExtracted,
    pagesSkipped,
    deepRetried,
  };
}
