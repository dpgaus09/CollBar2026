// ELRB final-offer extraction (vision-primary), Task #174 T007.
// Ported from pipeline/19_extract_final_offers.py + prompts/v1_il_offer.txt. The
// Python script sent the PDF text layer to Claude; this engine is vision-primary:
// it renders one party's offer PDF and extracts that party's per-topic positions
// from the page images.
//
// ELRB postings are short, so there is no triage — every page (up to a small cap)
// is rendered high-res and batched. Items are merged across batches and deduped
// to AT MOST ONE per topic (keep first), matching the Python contract.
//
// Fail-closed: a truncated batch is retried once at half size; if still truncated
// the whole extraction fails (no items returned, nothing cached). Results cache
// by (file_hash, request_hash).

import { openPdf, RENDER_VERSION } from "../pdf/renderer";
import { callVision, DEFAULT_MODEL, type VisionBlock } from "../vision/client";
import { classifyBatchResponse } from "../vision/parse";
import { requestHash, getCached, putCached } from "../cache";
import { costFromUsage } from "../cost";
import { logger } from "../../lib/logger";
import type { OfferItem, ExtractionStatus } from "../types";

const DOMAIN = "final_offer";
export const FINAL_OFFER_PROMPT_VERSION = "final-offer-v1";

const EXTRACT_DPI = 150;
const EXTRACT_MAX_PX = 1600;
const EXTRACT_MAX_TOKENS = 8192;
const EXTRACT_BATCH = 8;
export const MAX_OFFER_PAGES = 30; // offers are short; cap defends against junk

// Closed topic vocabulary — MUST match prompts/v1_il_offer.txt. Unknown topics
// are coerced to "other".
const TOPICS = new Set([
  "salary", "insurance", "retirement", "stipends", "leave", "workday",
  "work_year", "class_size", "evaluation", "grievance", "layoff_rif",
  "seniority", "term", "other",
]);
const NUMERIC_UNITS = new Set(["percent", "usd", "years", "days", "ratio"]);

const EXTRACT_PROMPT =
  "You are an expert Illinois K-12 labor-relations analyst. The images above are " +
  "the pages of ONE party's \"final offer\" from an Illinois Educational Labor " +
  "Relations Board (ELRB) interest-arbitration posting — either the school " +
  "DISTRICT (employer/board) offer OR the UNION offer in a single dispute. " +
  "Extract THIS party's position on each substantive bargaining topic so it can " +
  "be compared, topic-by-topic, against the other party's offer.\n\n" +
  "Output ONLY a single JSON object, no prose and no markdown fences:\n" +
  '{"items": [ <item>, ... ]}\n\n' +
  "Each <item> is:\n" +
  "{\n" +
  '  "topic":        one of the fixed values below (the single best fit),\n' +
  '  "topic_label":  short human label, e.g. "Salary / Across-the-Board Raise",\n' +
  '  "summary":      ONE sentence stating THIS party\'s position (<= 240 chars),\n' +
  '  "numeric_value": the single most representative number, or null,\n' +
  '  "numeric_unit": one of ["percent","usd","years","days","ratio"] or null,\n' +
  '  "raw_text":     a verbatim excerpt (<= 60 words) supporting it\n' +
  "}\n\n" +
  'The ONLY allowed "topic" values are: salary, insurance, retirement, stipends, ' +
  "leave, workday, work_year, class_size, evaluation, grievance, layoff_rif, " +
  "seniority, term, other.\n\n" +
  "Rules:\n" +
  "- Emit AT MOST ONE item per topic. Merge related sub-points into the single " +
  "best item for that topic. No duplicate topics.\n" +
  "- Only include topics this offer actually addresses. Never invent a position.\n" +
  "- For salary, prefer the percentage raise; if only dollars are given, use usd. " +
  "For a multi-year schedule, set numeric_value to the FIRST year's value and " +
  "describe the full schedule in summary.\n" +
  "- numeric_value must be a plain JSON number: no %, no $, no commas, no ranges. " +
  "If the position is purely language, use null.\n" +
  "- Keep summary factual and specific (include numbers/years when present).\n" +
  "- If no substantive positions are present, return {\"items\": []}.\n" +
  "Output valid JSON only.";

function imgBlock(base64: string): VisionBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: base64 },
  };
}

function coerceNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[$,%\s]/g, "");
  if (!s || ["null", "none", "-"].includes(s.toLowerCase())) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normTopic(v: unknown): string {
  const t = String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TOPICS.has(t) ? t : "other";
}

function normUnit(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const u = String(v).trim().toLowerCase();
  return NUMERIC_UNITS.has(u) ? u : null;
}

function blank(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

// Normalize + dedupe the model's items: at most one per topic (keep first),
// matching pipeline replace_items. Exported for unit tests.
export function normalizeOfferItems(raw: unknown): OfferItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OfferItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const o = r as Record<string, unknown>;
    const topic = normTopic(o.topic);
    if (seen.has(topic)) continue;
    seen.add(topic);
    out.push({
      topic,
      topicLabel: blank(o.topic_label),
      summary: blank(o.summary),
      numericValue: coerceNum(o.numeric_value),
      numericUnit: normUnit(o.numeric_unit),
      rawText: blank(o.raw_text),
    });
  }
  return out;
}

class TruncatedError extends Error {}
class ParseError extends Error {}

export interface OfferExtractionResult {
  items: OfferItem[];
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
  pagesExtracted: number;
}

export async function extractFinalOffer(
  buf: Buffer,
  fileHash: string,
  opts?: { model?: string; maxPages?: number; useCache?: boolean },
): Promise<OfferExtractionResult> {
  const model = opts?.model ?? DEFAULT_MODEL;
  const maxPages = opts?.maxPages ?? MAX_OFFER_PAGES;
  const useCache = opts?.useCache ?? true;

  const reqHash = requestHash({
    domain: DOMAIN,
    model,
    promptVersion: FINAL_OFFER_PROMPT_VERSION,
    renderVersion: RENDER_VERSION,
    extractDpi: EXTRACT_DPI,
    extractMaxPx: EXTRACT_MAX_PX,
    extractMaxTokens: EXTRACT_MAX_TOKENS,
    extractBatch: EXTRACT_BATCH,
    maxPages,
  });

  if (useCache && fileHash) {
    const hit = await getCached(fileHash, reqHash);
    if (hit) {
      return {
        items: (hit.normalized as OfferItem[]) ?? [],
        ok: true,
        status: "success",
        fromCache: true,
        truncated: false,
        inputTokens: hit.inputTokens,
        outputTokens: hit.outputTokens,
        costUsd: hit.estimatedCostUsd,
        modelVersion: hit.modelVersion,
        pageCount: 0,
        pagesExtracted: 0,
      };
    }
  }

  const doc = await openPdf(buf);
  const pageCount = doc.pageCount;
  const nPages = Math.min(pageCount, maxPages);
  let inputTokens = 0;
  let outputTokens = 0;
  let modelVersion = model;
  let status: ExtractionStatus = "success";
  let items: OfferItem[] = [];
  let rawResponse: string | null = null;

  async function extractBatch(pages: number[], allowSplit: boolean): Promise<unknown[]> {
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
    if (resp.truncated && allowSplit && pages.length > 1) {
      const mid = Math.ceil(pages.length / 2);
      const a = await extractBatch(pages.slice(0, mid), false);
      const b = await extractBatch(pages.slice(mid), false);
      return [...a, ...b];
    }
    const outcome = classifyBatchResponse(resp.text, resp.truncated, "items");
    if (!outcome.ok) {
      if (outcome.reason === "truncated") {
        throw new TruncatedError(`final-offer batch truncated on ${pages.length} page(s)`);
      }
      throw new ParseError(`final-offer batch returned no parseable JSON on ${pages.length} page(s)`);
    }
    return outcome.items;
  }

  try {
    const allPages = Array.from({ length: nPages }, (_, i) => i);
    const collected: unknown[] = [];
    for (let i = 0; i < allPages.length; i += EXTRACT_BATCH) {
      collected.push(...(await extractBatch(allPages.slice(i, i + EXTRACT_BATCH), true)));
    }
    items = normalizeOfferItems(collected);
  } catch (err) {
    if (err instanceof TruncatedError) {
      status = "truncated";
      items = [];
      logger.warn({ fileHash, err: err.message }, "final-offer extraction truncated; not storing (fail-closed)");
    } else if (err instanceof ParseError) {
      status = "parse_error";
      items = [];
      logger.warn({ fileHash, err: err.message }, "final-offer extraction unparseable; not storing (fail-closed)");
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
        promptVersion: FINAL_OFFER_PROMPT_VERSION,
        renderVersion: RENDER_VERSION,
        pageSet: nPages ? `1-${nPages}` : "none",
        status: "success",
        rawResponse,
        normalized: items,
        inputTokens,
        outputTokens,
        estimatedCostUsd: costUsd,
        finishReason: "end_turn",
      });
    } catch (err) {
      logger.warn({ err, fileHash }, "failed to cache final-offer extraction");
    }
  }

  return {
    items,
    ok: status === "success",
    status,
    fromCache: false,
    truncated: status === "truncated",
    inputTokens,
    outputTokens,
    costUsd,
    modelVersion,
    pageCount,
    pagesExtracted: nPages,
  };
}
