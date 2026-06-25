// Contract-metadata extraction (vision-primary), Task #175 follow-up.
//
// Pulls the two contract-level facts the customer "Current Contract" card needs
// but that no other domain produces: the agreement's TITLE (the union/association
// that is a party -> contracts.union_name) and its EXPIRATION (contracts.
// effective_end), plus the effective_start and term_years that drive the term
// display. These live on the opening pages (title/duration article) and often the
// final signature page, so there is no triage — we render the first few + last few
// pages and ask for one small JSON object.
//
// Fail-closed: a truncated (clipped JSON) or unparseable response is NOT treated
// as "no metadata" — it returns ok:false so the worker records no version and the
// store never runs (existing contract data is left intact). A VALID object whose
// fields are all null IS a legitimate "nothing found" result. Results cache by
// (file_hash, request_hash) so a re-run skips the paid call.

import { openPdf, RENDER_VERSION } from "../pdf/renderer";
import { callVision, DEFAULT_MODEL, type VisionBlock } from "../vision/client";
import { extractJsonObject } from "../vision/parse";
import { requestHash, getCached, putCached } from "../cache";
import { costFromUsage } from "../cost";
import { logger } from "../../lib/logger";
import type { ExtractionStatus } from "../types";

const DOMAIN = "contract_meta";
// Bump when the prompt or normalization changes so the cache misses old results.
export const CONTRACT_META_PROMPT_VERSION = "contract-meta-v1";

const EXTRACT_DPI = 150;
const EXTRACT_MAX_PX = 1600;
const EXTRACT_MAX_TOKENS = 2048; // a 5-field object is tiny
// The title + duration clause are at the front; the signed term dates are often on
// the final/signature page — render both ends.
const FIRST_PAGES = 5;
const LAST_PAGES = 3;

const EXTRACT_PROMPT =
  "You are an expert U.S. K-12 collective bargaining analyst. The images above are " +
  "selected pages (the opening pages and the final/signature pages) of ONE collective " +
  "bargaining agreement (CBA) between a school district / board of education and an " +
  "employee union or association.\n\n" +
  "Extract the agreement's identifying metadata as a SINGLE JSON object with EXACTLY " +
  "these keys:\n" +
  '  "union_name": the full name of the employee union/association that is a party to ' +
  'this agreement, exactly as printed (e.g. "Rock Island Education Association"). ' +
  "Use null if not stated.\n" +
  '  "affiliation": the parent / state / national affiliation if stated (e.g. "IEA-NEA", ' +
  '"IFT-AFT", "AFSCME Council 31"). Use null if none is stated.\n' +
  '  "effective_start": the date the agreement BECOMES EFFECTIVE, from its duration / term ' +
  'clause, formatted "YYYY-MM-DD". Use null if not stated.\n' +
  '  "effective_end": the date the agreement EXPIRES / terminates, formatted "YYYY-MM-DD". ' +
  "Use null if not stated.\n" +
  '  "term_years": the length of the agreement in years as a number (e.g. 3), or null.\n\n' +
  "Rules: Return ONLY the JSON object — no prose, no markdown, no code fences. Use null " +
  "for any field not explicitly supported by the text; do NOT guess names. Dates must be " +
  "full calendar dates in YYYY-MM-DD form. If the term is stated only as school year(s) " +
  '(e.g. "the 2022-2023 through 2024-2025 school years") with no exact dates, you may use ' +
  "the standard July 1 start and June 30 end of that span; otherwise use null.";

function imgBlock(base64: string): VisionBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: base64 },
  };
}

export interface ContractMeta {
  unionName: string | null;
  affiliation: string | null;
  effectiveStart: string | null; // YYYY-MM-DD
  effectiveEnd: string | null; // YYYY-MM-DD
  termYears: number | null;
}

export const EMPTY_CONTRACT_META: ContractMeta = {
  unionName: null,
  affiliation: null,
  effectiveStart: null,
  effectiveEnd: null,
  termYears: null,
};

function asTrimmedString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function asIsoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return Number.isNaN(Date.parse(t)) ? null : t;
}

function asTermYears(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 20) return null;
  return Number(n.toFixed(1));
}

// Normalize the model's object into a ContractMeta. Invalid/partial values become
// null (never stored). term_years is derived from the date span only when the
// model omitted it AND the span rounds cleanly to a whole number of years.
export function normalizeContractMeta(o: Record<string, unknown>): ContractMeta {
  const unionName = asTrimmedString(o.union_name);
  const affiliation = asTrimmedString(o.affiliation);
  let effectiveStart = asIsoDate(o.effective_start);
  let effectiveEnd = asIsoDate(o.effective_end);
  let termYears = asTermYears(o.term_years);

  // A start after the end is incoherent — drop both rather than store a bad term.
  if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) {
    effectiveStart = null;
    effectiveEnd = null;
  }

  if (termYears == null && effectiveStart && effectiveEnd) {
    const days =
      (Date.parse(effectiveEnd) - Date.parse(effectiveStart)) / 86_400_000;
    const yrs = days / 365.25;
    const rounded = Math.round(yrs);
    if (rounded >= 1 && rounded <= 10 && Math.abs(yrs - rounded) <= 0.25) {
      termYears = rounded;
    }
  }

  return { unionName, affiliation, effectiveStart, effectiveEnd, termYears };
}

export interface ContractMetaExtractionResult {
  meta: ContractMeta;
  // ok === (status === "success"); only an ok result may be stored or cached. A
  // truncated/parse_error result is fail-closed (empty meta, never stored).
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
}

// Page indices (0-based) to send: the first FIRST_PAGES and the last LAST_PAGES,
// de-duplicated. Small docs collapse to "every page".
function selectPages(pageCount: number): number[] {
  const set = new Set<number>();
  for (let i = 0; i < Math.min(FIRST_PAGES, pageCount); i++) set.add(i);
  for (let i = Math.max(0, pageCount - LAST_PAGES); i < pageCount; i++) set.add(i);
  return [...set].sort((a, b) => a - b);
}

// Vision-extract contract metadata from a PDF buffer. Caches successful
// (non-truncated) results by (fileHash, requestHash) so re-runs skip the paid call.
export async function extractContractMeta(
  buf: Buffer,
  fileHash: string,
  opts?: { model?: string; useCache?: boolean },
): Promise<ContractMetaExtractionResult> {
  const model = opts?.model ?? DEFAULT_MODEL;
  const useCache = opts?.useCache ?? true;

  const reqHash = requestHash({
    domain: DOMAIN,
    model,
    promptVersion: CONTRACT_META_PROMPT_VERSION,
    renderVersion: RENDER_VERSION,
    extractDpi: EXTRACT_DPI,
    extractMaxPx: EXTRACT_MAX_PX,
    extractMaxTokens: EXTRACT_MAX_TOKENS,
    firstPages: FIRST_PAGES,
    lastPages: LAST_PAGES,
  });

  if (useCache && fileHash) {
    const hit = await getCached(fileHash, reqHash);
    if (hit) {
      return {
        meta: (hit.normalized as ContractMeta) ?? EMPTY_CONTRACT_META,
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
      };
    }
  }

  const doc = await openPdf(buf);
  const pageCount = doc.pageCount;
  let inputTokens = 0;
  let outputTokens = 0;
  let modelVersion = model;
  let status: ExtractionStatus = "success";
  let meta: ContractMeta = EMPTY_CONTRACT_META;
  let pagesExtracted: number[] = [];
  let rawResponse: string | null = null;

  try {
    const pages = selectPages(pageCount);
    if (pages.length) {
      pagesExtracted = pages;
      const blocks: VisionBlock[] = [];
      for (const i of pages) {
        blocks.push({ type: "text", text: `=== PDF page ${i + 1} ===` });
        const img = doc.renderPage(i, { dpi: EXTRACT_DPI, maxPx: EXTRACT_MAX_PX });
        blocks.push(imgBlock(img.base64));
      }
      blocks.push({ type: "text", text: EXTRACT_PROMPT });

      const resp = await callVision({
        blocks,
        maxTokens: EXTRACT_MAX_TOKENS,
        model,
      });
      inputTokens += resp.usage.inputTokens;
      outputTokens += resp.usage.outputTokens;
      modelVersion = resp.model;
      rawResponse = resp.text;

      // Fail-closed: a clipped/unparseable response is not a valid-empty result.
      if (resp.truncated) {
        status = "truncated";
        logger.warn(
          { fileHash },
          "vision contract_meta truncated (max_tokens); not storing (fail-closed)",
        );
      } else {
        const obj = extractJsonObject(resp.text);
        if (!obj) {
          status = "parse_error";
          logger.warn(
            { fileHash },
            "vision contract_meta returned no parseable JSON object; not storing (fail-closed)",
          );
        } else {
          meta = normalizeContractMeta(obj);
        }
      }
    }
  } catch (err) {
    doc.destroy();
    throw err;
  }
  doc.destroy();

  const costUsd = costFromUsage(modelVersion, inputTokens, outputTokens);

  // Cache only a successful result (including a confident all-null result) so a
  // re-run skips the paid call. Never cache a truncated/parse_error run.
  if (useCache && fileHash && status === "success") {
    try {
      await putCached({
        fileHash,
        requestHash: reqHash,
        domain: DOMAIN,
        model,
        modelVersion,
        promptVersion: CONTRACT_META_PROMPT_VERSION,
        renderVersion: RENDER_VERSION,
        pageSet: pagesExtracted.length
          ? pagesExtracted.map((p) => p + 1).join(",")
          : "none",
        status: "success",
        rawResponse,
        normalized: meta,
        inputTokens,
        outputTokens,
        estimatedCostUsd: costUsd,
        finishReason: "end_turn",
      });
    } catch (err) {
      logger.warn({ err, fileHash }, "failed to cache contract_meta extraction");
    }
  }

  return {
    meta,
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
  };
}
