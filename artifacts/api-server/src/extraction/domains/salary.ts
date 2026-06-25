// Salary-schedule extraction (vision-primary), ported from
// pipeline/lib_salary_vision.py to TypeScript.
//
// Strategy (bounded cost):
//   1. Small docs (<= SMALL_DOC_PAGES): send every page to high-res extraction.
//   2. Large docs: a cheap low-res vision TRIAGE locates the page(s) that carry a
//      salary schedule, then only those pages are re-rendered high-res for the
//      structured EXTRACTION call.
//
// Fail-closed everywhere: a truncated extraction (stop_reason=max_tokens) is
// discarded whole (never store clipped JSON), a lane-row width mismatch drops
// the whole schedule (salaries could be shifted into the wrong education lane),
// and implausible magnitudes are flagged for review rather than trusted. Results
// are cached by (file_hash, request_hash) so a re-run skips the paid calls.

import { openPdf, RENDER_VERSION, type PdfDoc } from "../pdf/renderer";
import { callVision, DEFAULT_MODEL, type VisionBlock } from "../vision/client";
import { extractJsonArray } from "../vision/parse";
import { requestHash, getCached, putCached } from "../cache";
import { costFromUsage } from "../cost";
import { logger } from "../../lib/logger";
import type { SalaryCell, SalarySchedule } from "../types";
import {
  canonLane,
  isEducationSchedule,
  EDU_SALARY_FLOOR,
  EDU_SALARY_CEILING,
  MIN_ROWS,
} from "./salary-grid";
import { verifySalaryAgainstText } from "./salary-verify";

const DOMAIN = "salary";
// Bump when the prompt or normalization changes so the cache misses old results.
// v2: Option B text-layer verification now annotates the normalized result.
export const SALARY_PROMPT_VERSION = "salary-v2";

// Triage: low-res thumbnails are enough to tell "is there a grid of dollars".
const TRIAGE_DPI = 60;
const TRIAGE_MAX_PX = 900;
const TRIAGE_BATCH = 12; // pages per triage request
const TRIAGE_MAX_TOKENS = 8192;

// Extraction: higher-res so digits read cleanly.
const EXTRACT_DPI = 150;
const EXTRACT_MAX_PX = 1600;
const EXTRACT_MAX_TOKENS = 12000;

export const DEFAULT_MAX_PAGES = 12; // hard cap on high-res extraction pages
const SMALL_DOC_PAGES = 6; // docs this small skip triage (extract every page)

const EXTRACT_PROMPT =
  "You are reading scanned pages from a school-district collective bargaining " +
  "agreement. Each image is one PDF page, labeled '=== PDF page N ===' just " +
  "before it.\n\n" +
  "Extract EVERY base salary schedule shown across these pages. A salary " +
  "schedule is a table of experience STEPS (rows) by pay LANES (columns) with " +
  "dollar amounts, or a single step->salary column. If the same schedule " +
  "repeats for multiple SCHOOL YEARS (e.g. 2024-2025, 2025-2026), output a " +
  "SEPARATE element per school year.\n\n" +
  "Return ONLY a JSON array. Each element represents ONE schedule for ONE " +
  "school year:\n" +
  '{"schedule_name": str, "school_year": "YYYY-YYYY" or null, ' +
  '"schedule_type": "lane_grid" or "single_column", ' +
  '"lane_labels": [str, ...], "page": int, ' +
  '"rows": [[step, v1, v2, ...], ...]}\n\n' +
  "Rules:\n" +
  "- lane_labels are the column headers, left-to-right, EXACTLY as printed.\n" +
  "- Each row is [step_number, then ONE value per lane in lane_labels order].\n" +
  "- Use null for a blank/empty cell. NEVER invent or carry a value into a " +
  "blank cell.\n" +
  "- step_number is an integer; salary values are integers with no $ or commas " +
  "(ignore any cents).\n" +
  "- Use the EXACT column headers and step numbers as printed.\n" +
  '- single_column schedule: lane_labels ["Salary"], each row [step, salary].\n' +
  "- Do NOT include stipend, extra-duty, longevity, or index tables — only base " +
  "salary schedules.\n" +
  "- 'page' is the PDF page number (from the label) where the schedule appears.\n" +
  "- If no salary schedule is present, return [].\n" +
  "Output only the JSON array, no prose.";

const TRIAGE_PROMPT =
  "Which of the labeled pages show a SALARY SCHEDULE (a table of experience " +
  "steps and dollar salary amounts, or a step->salary column)? Return ONLY a " +
  "JSON array of the page numbers, e.g. [48,49,50]. If none, return [].";

function imgBlock(base64: string): VisionBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: base64 },
  };
}

// Exported for unit testing of the fail-closed parsing logic.
export function toIntMoney(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\$/g, "").replace(/,/g, "");
  if (!s || ["null", "none", "-"].includes(s.toLowerCase())) return null;
  const f = Number(s);
  if (!Number.isFinite(f)) return null;
  const n = Math.round(f);
  return n > 0 ? n : null;
}

// Conservative checks: education grids must fall within plausible base-salary
// bounds, and a schedule needs enough step rows. Failures are flagged for review
// (and confidence lowered), never silently trusted.
function applySanity(sched: SalarySchedule): void {
  const reasons = new Set<string>();
  if (isEducationSchedule(sched)) {
    if (sched.minSalary !== null && sched.minSalary < EDU_SALARY_FLOOR) {
      reasons.add("salary_below_floor");
    }
    if (sched.maxSalary !== null && sched.maxSalary > EDU_SALARY_CEILING) {
      reasons.add("salary_above_ceiling");
    }
  }
  if (sched.stepCount < MIN_ROWS) reasons.add("too_few_steps");
  if (reasons.size) {
    sched.needsReview = true;
    sched.confidence = 0.5;
    sched.reviewReason = [...reasons].sort().join(";");
  }
}

// Turn the model's compact row JSON into schedule objects matching
// SalarySchedule. Exported for unit testing of the fail-closed parsing logic.
export function normalize(data: unknown[]): SalarySchedule[] {
  const out: SalarySchedule[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const s = raw as Record<string, unknown>;

    const laneLabels = ((s.lane_labels as unknown[]) ?? [])
      .filter((x) => String(x).trim())
      .map((x) => canonLane(String(x)));

    let page: number | null = null;
    if (s.page !== null && s.page !== undefined) {
      const p = Number(s.page);
      page = Number.isFinite(p) ? Math.trunc(p) : null;
    }
    page = page || 1;

    let stype = s.schedule_type;
    if (stype !== "lane_grid" && stype !== "single_column") {
      stype = laneLabels.length > 1 ? "lane_grid" : "single_column";
    }
    const isLaneGrid = stype === "lane_grid" && laneLabels.length >= 2;

    const cells: SalaryCell[] = [];
    const salaries: number[] = [];
    const steps = new Set<number>();
    let badShape = false;

    for (const row of (s.rows as unknown[]) ?? []) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const stepN = Number(row[0]);
      if (!Number.isFinite(stepN)) continue;
      const step = Math.trunc(stepN);
      const values = row.slice(1);
      // The model dropped null placeholders for blank cells (or added stray
      // columns): cell->lane alignment is no longer reliable and salaries could
      // be shifted into the wrong education lane. Fail closed — drop the whole
      // schedule rather than store mis-mapped pay.
      if (isLaneGrid && values.length !== laneLabels.length) {
        badShape = true;
        break;
      }
      if (isLaneGrid) {
        values.forEach((v, li) => {
          const salary = toIntMoney(v);
          if (salary === null) return;
          cells.push({
            stepLabel: String(step),
            stepOrder: step,
            laneLabel: laneLabels[li],
            laneOrder: li,
            salaryAmount: salary,
            pageRef: page as number,
          });
          salaries.push(salary);
          steps.add(step);
        });
      } else {
        let salary: number | null = null;
        for (const v of values) {
          const m = toIntMoney(v);
          if (m !== null) {
            salary = m;
            break;
          }
        }
        if (salary === null) continue;
        cells.push({
          stepLabel: String(step),
          stepOrder: step,
          laneLabel: laneLabels[0] ?? "Salary",
          laneOrder: 0,
          salaryAmount: salary,
          pageRef: page as number,
        });
        salaries.push(salary);
        steps.add(step);
      }
    }

    if (badShape) {
      logger.warn(
        { scheduleName: s.schedule_name, lanes: laneLabels.length },
        "vision salary: dropping schedule — row width != lane count",
      );
      continue;
    }
    if (!cells.length) continue;

    let schoolYear = s.school_year ? String(s.school_year).trim() : null;
    if (schoolYear && !/\d{4}\s*[-\u2013]\s*\d{2,4}/.test(schoolYear)) {
      schoolYear = null;
    }
    let startYear: number | null = null;
    if (schoolYear) {
      const m = schoolYear.match(/(\d{4})/);
      if (m) startYear = Number(m[1]);
    }

    const name = String(s.schedule_name ?? "").trim();
    const sched: SalarySchedule = {
      scheduleName: (name || "Salary Schedule").slice(0, 200),
      schoolYear,
      startYear,
      scheduleType: isLaneGrid ? "lane_grid" : "single_column",
      laneLabels: laneLabels.length ? laneLabels : null,
      stepCount: steps.size,
      laneCount: isLaneGrid ? laneLabels.length : 1,
      pageStart: page,
      pageEnd: page,
      minSalary: Math.min(...salaries),
      maxSalary: Math.max(...salaries),
      // Vision results surface in the customer view the same way the
      // deterministic parser's do, so they are tagged extraction_method=
      // 'claude_vision' to stay auditable. Obvious failures are withheld by the
      // magnitude sanity check below, and lane-shifted grids were dropped above.
      confidence: 0.85,
      needsReview: false,
      reviewReason: null,
      extractionMethod: "claude_vision",
      cells,
    };
    applySanity(sched);
    out.push(sched);
  }
  return out;
}

interface TriageResult {
  pages: number[];
  inputTokens: number;
  outputTokens: number;
  model: string;
}

// Cheap, low-res vision triage: return 0-based page indexes that show a salary
// schedule. Batched so request bodies stay small; a failing batch is skipped
// rather than aborting the whole locate.
async function locateSalaryPages(
  doc: PdfDoc,
  npages: number,
  maxPages: number,
  model: string,
): Promise<TriageResult> {
  const found = new Set<number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let resolvedModel = model;

  for (let batchStart = 0; batchStart < npages; batchStart += TRIAGE_BATCH) {
    const end = Math.min(batchStart + TRIAGE_BATCH, npages);
    const blocks: VisionBlock[] = [];
    for (let i = batchStart; i < end; i++) {
      blocks.push({ type: "text", text: `=== PDF page ${i + 1} ===` });
      const img = doc.renderPage(i, { dpi: TRIAGE_DPI, maxPx: TRIAGE_MAX_PX });
      blocks.push(imgBlock(img.base64));
    }
    blocks.push({ type: "text", text: TRIAGE_PROMPT });
    try {
      const resp = await callVision({
        blocks,
        maxTokens: TRIAGE_MAX_TOKENS,
        model,
      });
      inputTokens += resp.usage.inputTokens;
      outputTokens += resp.usage.outputTokens;
      resolvedModel = resp.model;
      const arr = extractJsonArray(resp.text) ?? [];
      for (const x of arr) {
        const p = Number(x);
        if (Number.isFinite(p) && p >= 1 && p <= npages) {
          found.add(Math.trunc(p) - 1);
        }
      }
    } catch (err) {
      logger.warn({ err, batchStart, end }, "vision triage batch failed; skipping");
      continue;
    }
  }

  let pages = [...found].sort((a, b) => a - b);
  if (pages.length > maxPages) {
    logger.info(
      { candidates: pages.length, cap: maxPages },
      "vision salary: candidate pages > cap; truncating",
    );
    pages = pages.slice(0, maxPages);
  }
  return { pages, inputTokens, outputTokens, model: resolvedModel };
}

export interface SalaryExtractionResult {
  schedules: SalarySchedule[];
  fromCache: boolean;
  truncated: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelVersion: string;
  pageCount: number;
  pagesExtracted: number[];
}

// Vision-extract salary schedules from a PDF buffer. Returns schedules (possibly
// empty), token usage, and cost. Caches successful (non-truncated) results by
// (fileHash, requestHash) so re-runs skip the paid calls.
export async function extractSalarySchedules(
  buf: Buffer,
  fileHash: string,
  opts?: {
    model?: string;
    maxPages?: number;
    useCache?: boolean;
    verify?: boolean;
  },
): Promise<SalaryExtractionResult> {
  const model = opts?.model ?? DEFAULT_MODEL;
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
  const useCache = opts?.useCache ?? true;
  // Option B: cross-check vision salaries against the digital text layer.
  const verify = opts?.verify ?? true;

  const reqHash = requestHash({
    domain: DOMAIN,
    model,
    promptVersion: SALARY_PROMPT_VERSION,
    renderVersion: RENDER_VERSION,
    triageDpi: TRIAGE_DPI,
    triageMaxPx: TRIAGE_MAX_PX,
    triageBatch: TRIAGE_BATCH,
    extractDpi: EXTRACT_DPI,
    extractMaxPx: EXTRACT_MAX_PX,
    extractMaxTokens: EXTRACT_MAX_TOKENS,
    maxPages,
    smallDocPages: SMALL_DOC_PAGES,
    verify,
  });

  if (useCache && fileHash) {
    const hit = await getCached(fileHash, reqHash);
    if (hit) {
      return {
        schedules: (hit.normalized as SalarySchedule[]) ?? [],
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
  let truncated = false;
  let schedules: SalarySchedule[] = [];
  let pagesExtracted: number[] = [];
  let rawResponse: string | null = null;

  try {
    let pages: number[];
    if (pageCount <= SMALL_DOC_PAGES) {
      pages = Array.from({ length: pageCount }, (_, i) => i);
    } else {
      const loc = await locateSalaryPages(doc, pageCount, maxPages, model);
      pages = loc.pages;
      inputTokens += loc.inputTokens;
      outputTokens += loc.outputTokens;
      modelVersion = loc.model;
    }

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

      if (resp.truncated) {
        // A truncated response yields partial/last-schedule-clipped JSON; do not
        // store any of it. Fail closed (and do NOT cache) so a re-run retries.
        truncated = true;
        logger.warn(
          { fileHash },
          "vision salary extraction truncated (max_tokens); discarding output",
        );
      } else {
        const parsed = extractJsonArray(resp.text);
        schedules = parsed ? normalize(parsed) : [];
        // Option B: corroborate each salary against the digital text layer (the
        // doc is still open here). Scanned pages are skipped inside verify.
        if (verify && schedules.length) {
          const vstats = verifySalaryAgainstText(schedules, doc);
          if (vstats.cellsChecked) {
            logger.info(
              { fileHash, ...vstats },
              "vision salary: text-layer verification",
            );
          }
        }
      }
    } else {
      logger.info({ fileHash }, "vision salary: no salary pages located");
    }
  } finally {
    doc.destroy();
  }

  const costUsd = costFromUsage(modelVersion, inputTokens, outputTokens);

  // Cache successful (non-truncated) results — including a confident empty
  // result — so a re-run skips the paid calls. Never cache a truncated run.
  if (useCache && fileHash && !truncated) {
    try {
      await putCached({
        fileHash,
        requestHash: reqHash,
        domain: DOMAIN,
        model,
        modelVersion,
        promptVersion: SALARY_PROMPT_VERSION,
        renderVersion: RENDER_VERSION,
        pageSet: pagesExtracted.length
          ? pagesExtracted.map((p) => p + 1).join(",")
          : "none",
        status: "success",
        rawResponse,
        normalized: schedules,
        inputTokens,
        outputTokens,
        estimatedCostUsd: costUsd,
        finishReason: "end_turn",
      });
    } catch (err) {
      logger.warn({ err, fileHash }, "failed to cache salary extraction");
    }
  }

  return {
    schedules,
    fromCache: false,
    truncated,
    inputTokens,
    outputTokens,
    costUsd,
    modelVersion,
    pageCount,
    pagesExtracted,
  };
}
