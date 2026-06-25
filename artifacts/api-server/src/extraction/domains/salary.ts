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
import { extractJsonArray, classifyArrayResponse } from "../vision/parse";
import { requestHash, getCached, putCached } from "../cache";
import { costFromUsage } from "../cost";
import { logger } from "../../lib/logger";
import type { ExtractionStatus, SalaryCell, SalarySchedule } from "../types";
import {
  canonLane,
  isEducationSchedule,
  isHourlyLane,
  isAnnualLane,
  EDU_SALARY_FLOOR,
  EDU_SALARY_CEILING,
  HOURLY_RATE_FLOOR,
  HOURLY_RATE_CEILING,
  MIN_ROWS,
} from "./salary-grid";
import { verifySalaryAgainstText } from "./salary-verify";

const DOMAIN = "salary";
// Bump when the prompt or normalization changes so the cache misses old results.
// v2: Option B text-layer verification now annotates the normalized result.
// v3: capture support-staff wage tables (classification row keys + hourly rates).
// v4: mixed hourly+annual tables -> lane_grid (per-column unit), per-lane sanity.
export const SALARY_PROMPT_VERSION = "salary-v4";

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
  "Extract EVERY base pay schedule shown across these pages. Include BOTH:\n" +
  "  (a) teacher BASE SALARY schedules — experience STEPS (rows) by education " +
  "LANES (columns, e.g. BA, BA+15, MA, MA+30) with annual dollar amounts; and\n" +
  "  (b) support-staff WAGE/RATE schedules (custodial, maintenance, " +
  "transportation / bus drivers, food service, aides, paraprofessionals, " +
  "secretarial / clerical). These are often keyed by JOB CLASSIFICATION " +
  '(e.g. "Custodian I", "Bus Driver") instead of a step number, and the pay ' +
  "may be an HOURLY rate (e.g. 22.50) or an annual salary.\n" +
  "If the same schedule repeats for multiple SCHOOL YEARS (e.g. 2024-2025, " +
  "2025-2026), output a SEPARATE element per school year.\n\n" +
  "Return ONLY a JSON array. Each element represents ONE schedule for ONE " +
  "school year:\n" +
  '{"schedule_name": str, "school_year": "YYYY-YYYY" or null, ' +
  '"schedule_type": "lane_grid" | "single_column" | "hourly", ' +
  '"lane_labels": [str, ...], "page": int, ' +
  '"rows": [[step_or_classification, v1, v2, ...], ...]}\n\n' +
  "Rules:\n" +
  '- schedule_name describes the group (e.g. "Teacher Salary Schedule", ' +
  '"Custodial Hourly Wages", "Bus Driver Wages").\n' +
  '- Use schedule_type "hourly" ONLY when EVERY pay column is an hourly RATE ' +
  "(not an annual salary). If ONE table has BOTH an hourly-rate column AND an " +
  'annual-salary column, use "lane_grid" and label each column exactly (e.g. ' +
  '["Hourly", "Salary"]) — do NOT drop either column.\n' +
  "- lane_labels are the column headers, left-to-right, EXACTLY as printed " +
  "(degree lanes for teachers; step/year or rate columns otherwise).\n" +
  "- Each row's FIRST cell is the step number OR the job classification name, " +
  "copied EXACTLY as printed; then ONE value per column in lane_labels order.\n" +
  "- Use null for a blank/empty cell. NEVER invent or carry a value into a " +
  "blank cell.\n" +
  "- Pay values have no $ or commas. For HOURLY rates KEEP the cents " +
  "(e.g. 22.50); for annual salaries the cents may be omitted.\n" +
  '- single_column / hourly with one pay column: lane_labels ["Salary"] or ' +
  '["Hourly Rate"], each row [step_or_classification, amount].\n' +
  "- Do NOT include stipend, extra-duty, coaching, longevity, or index / " +
  "supplemental tables — only BASE salary or BASE wage schedules.\n" +
  "- 'page' is the PDF page number (from the label) where the schedule appears.\n" +
  "- If no salary or wage schedule is present, return [].\n" +
  "Output only the JSON array, no prose.";

const TRIAGE_PROMPT =
  "Which of the labeled pages show a PAY SCHEDULE — a table of experience " +
  "STEPS or job CLASSIFICATIONS with dollar pay amounts? This covers teacher " +
  "salary schedules (steps x education lanes) AND support-staff wage schedules " +
  "(custodial, maintenance, transportation, food service, aides, secretarial) " +
  "with annual salaries or hourly rates. Return ONLY a JSON array of the page " +
  "numbers, e.g. [48,49,50]. If none, return [].";

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

// Parse a pay value PRESERVING cents — an hourly wage rate like 22.50 must not
// be rounded to whole dollars (toIntMoney would corrupt it). Returns a positive
// number rounded to 2 decimals (matching the numeric(12,2) column) or null for
// blank/zero/unparseable input. Annual salaries pass through unchanged.
export function toMoney(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\$/g, "").replace(/,/g, "");
  if (!s || ["null", "none", "-"].includes(s.toLowerCase())) return null;
  const f = Number(s);
  if (!Number.isFinite(f)) return null;
  const n = Math.round(f * 100) / 100;
  return n > 0 ? n : null;
}

// A salary row's first cell is either an experience STEP number (teacher grids)
// or a job CLASSIFICATION label (support-staff wage tables, e.g. "Custodian I").
// Numeric steps keep their value as the sort order; classification labels are
// kept verbatim and ordered by their printed position so the grid renders
// top-to-bottom as written. Returns null for an empty/unusable key.
export function parseRowKey(
  raw: unknown,
  rowIdx: number,
): { stepLabel: string; stepOrder: number } | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || ["null", "none", "-"].includes(s.toLowerCase())) return null;
  // A bare integer, optionally prefixed "Step" (e.g. "Step 3" -> 3).
  const m = s.match(/^(?:step\s*)?(\d{1,3})$/i);
  if (m) {
    const n = Number(m[1]);
    return { stepLabel: String(n), stepOrder: n };
  }
  // Any other finite number (e.g. "3.5") truncates to an integer step.
  const n = Number(s);
  if (Number.isFinite(n)) {
    const t = Math.trunc(n);
    return { stepLabel: String(t), stepOrder: t };
  }
  // Classification label — keep as printed (bounded), order by row position.
  return { stepLabel: s.slice(0, 120), stepOrder: rowIdx };
}

// Conservative checks: pay values must fall within plausible bounds for their
// UNIT, and a schedule needs enough step rows. Bounds are scoped per column, not
// to the schedule's aggregate min/max: a support-staff table that pairs an
// hourly column with an annual salary column spans (e.g.) 20.43 .. 80000, and an
// aggregate hourly-ceiling check would falsely flag every such schedule. So the
// hourly window is applied only to hourly-rate lanes and the salary floor only
// to annual lanes. Failures are flagged for review (and confidence lowered),
// never silently trusted.
function applySanity(sched: SalarySchedule): void {
  const reasons = new Set<string>();
  const valuesForLane = (pred: (label: string | null | undefined) => boolean): number[] =>
    sched.cells.filter((c) => pred(c.laneLabel)).map((c) => c.salaryAmount);

  if (isEducationSchedule(sched)) {
    // Education grids are all annual teacher-salary columns: the aggregate is
    // homogeneous, so bound it with the education base-salary window.
    if (sched.minSalary !== null && sched.minSalary < EDU_SALARY_FLOOR) {
      reasons.add("salary_below_floor");
    }
    if (sched.maxSalary !== null && sched.maxSalary > EDU_SALARY_CEILING) {
      reasons.add("salary_above_ceiling");
    }
  } else {
    // Support-staff tables may mix hourly + annual columns. Validate the hourly
    // lane(s) against the hourly-rate window and leave annual support salaries
    // unbounded (they vary too widely across job families to bound safely).
    // A pure-hourly schedule with no per-lane headers still gets checked via its
    // (homogeneous) aggregate. A header that reads as BOTH (e.g. "Annual Rate")
    // is treated as annual, so an annual column is never judged on rate bounds.
    const isHourlyOnly = (l: string | null | undefined) => isHourlyLane(l) && !isAnnualLane(l);
    const hourlyVals =
      sched.scheduleType === "hourly" && !sched.cells.some((c) => isHourlyOnly(c.laneLabel))
        ? sched.cells.map((c) => c.salaryAmount)
        : valuesForLane(isHourlyOnly);
    if (hourlyVals.length) {
      if (Math.min(...hourlyVals) < HOURLY_RATE_FLOOR) reasons.add("rate_below_floor");
      if (Math.max(...hourlyVals) > HOURLY_RATE_CEILING) reasons.add("rate_above_ceiling");
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

    const KNOWN_TYPES = new Set(["lane_grid", "single_column", "hourly"]);
    let stype = String(s.schedule_type ?? "");
    if (!KNOWN_TYPES.has(stype)) {
      stype = laneLabels.length > 1 ? "lane_grid" : "single_column";
    }
    // Cell alignment: any schedule with >= 2 lane columns is a grid (each row
    // must carry one value per lane), EXCEPT an explicitly single column. An
    // "hourly" wage table may be single-column (classification -> rate) or a
    // grid (classification x step/year).
    const isLaneGrid = laneLabels.length >= 2 && stype !== "single_column";
    // "hourly" is a schedule-WIDE property: it holds only when EVERY pay column
    // is an hourly rate. Support-staff wage appendices often pair an hourly
    // column with an annual salary column in one table (custodial "STARTING
    // WAGES": Hourly | Salary) — that table is a lane_grid, and each column is
    // formatted and magnitude-checked by its own header. Trust the model's
    // "hourly" call unless a lane header contradicts it with an annual column.
    const hasAnnualLane = laneLabels.some(isAnnualLane);
    const isPureHourly = stype === "hourly" && !hasAnnualLane;

    const cells: SalaryCell[] = [];
    const salaries: number[] = [];
    const stepKeys = new Set<string>();
    let badShape = false;
    let rowIdx = 0;

    for (const row of (s.rows as unknown[]) ?? []) {
      if (!Array.isArray(row) || row.length < 2) continue;
      rowIdx += 1;
      // The first cell is an experience STEP number (teacher grids) or a job
      // CLASSIFICATION label (support-staff wage tables). Both are kept.
      const key = parseRowKey(row[0], rowIdx);
      if (key === null) continue;
      const { stepLabel, stepOrder } = key;
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
          const salary = toMoney(v);
          if (salary === null) return;
          cells.push({
            stepLabel,
            stepOrder,
            laneLabel: laneLabels[li],
            laneOrder: li,
            salaryAmount: salary,
            pageRef: page as number,
          });
          salaries.push(salary);
          stepKeys.add(stepLabel);
        });
      } else {
        let salary: number | null = null;
        for (const v of values) {
          const m = toMoney(v);
          if (m !== null) {
            salary = m;
            break;
          }
        }
        if (salary === null) continue;
        cells.push({
          stepLabel,
          stepOrder,
          laneLabel: laneLabels[0] ?? (isPureHourly ? "Hourly Rate" : "Salary"),
          laneOrder: 0,
          salaryAmount: salary,
          pageRef: page as number,
        });
        salaries.push(salary);
        stepKeys.add(stepLabel);
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
    const scheduleType: SalarySchedule["scheduleType"] =
      isPureHourly ? "hourly" : isLaneGrid ? "lane_grid" : "single_column";
    const sched: SalarySchedule = {
      scheduleName: (name || "Salary Schedule").slice(0, 200),
      schoolYear,
      startYear,
      scheduleType,
      laneLabels: laneLabels.length ? laneLabels : null,
      stepCount: stepKeys.size,
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

// Fail-closed sentinels: a truncated or unparseable model response must abort the
// salary extraction (status -> truncated / parse_error) so no store or cache runs
// on a partial/garbled result. Declared above their first use. Mirrors the
// provisions domain.
class TruncatedError extends Error {}
class ParseError extends Error {}

// Cheap, low-res vision triage: return 0-based page indexes that show a salary
// schedule. Batched so request bodies stay small.
//
// Fail-closed: a truncated or unparseable triage batch leaves the candidate page
// set unknown. It is NOT safe to "skip" the batch and continue with a partial
// page set — the downstream per-contract delete-then-insert store would then wipe
// any schedule that lived on an un-triaged page and replace it with nothing. So a
// bad batch throws (TruncatedError/ParseError) and a genuine callVision error
// propagates; the caller turns these into a non-success status and stores nothing.
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
    const resp = await callVision({
      blocks,
      maxTokens: TRIAGE_MAX_TOKENS,
      model,
    });
    inputTokens += resp.usage.inputTokens;
    outputTokens += resp.usage.outputTokens;
    resolvedModel = resp.model;
    if (resp.truncated) {
      throw new TruncatedError(
        `vision salary triage truncated on pages ${batchStart + 1}-${end}`,
      );
    }
    const arr = extractJsonArray(resp.text);
    if (arr === null) {
      throw new ParseError(
        `vision salary triage returned no parseable page list on pages ${batchStart + 1}-${end}`,
      );
    }
    for (const x of arr) {
      const p = Number(x);
      if (Number.isFinite(p) && p >= 1 && p <= npages) {
        found.add(Math.trunc(p) - 1);
      }
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
  // ok === (status === "success"); only an ok result may be stored or cached. A
  // truncated/parse_error result is fail-closed (empty schedules, never stored).
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

      // Fail-closed: a truncated (clipped JSON) or unparseable response is NOT a
      // valid-empty result. Treating it as [] then storing would let the
      // downstream per-contract delete-then-insert wipe existing schedules and
      // replace them with nothing. Surface it as a non-success status instead.
      const outcome = classifyArrayResponse(resp.text, resp.truncated);
      if (!outcome.ok) {
        if (outcome.reason === "truncated") {
          throw new TruncatedError(
            "vision salary extraction truncated (max_tokens)",
          );
        }
        throw new ParseError(
          "vision salary extraction returned no parseable JSON array",
        );
      }
      schedules = normalize(outcome.items);
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
    } else {
      logger.info({ fileHash }, "vision salary: no salary pages located");
    }
  } catch (err) {
    if (err instanceof TruncatedError) {
      status = "truncated";
      schedules = [];
      logger.warn(
        { fileHash, err: err.message },
        "vision salary extraction truncated; not storing (fail-closed)",
      );
    } else if (err instanceof ParseError) {
      status = "parse_error";
      schedules = [];
      logger.warn(
        { fileHash, err: err.message },
        "vision salary extraction unparseable; not storing (fail-closed)",
      );
    } else {
      doc.destroy();
      throw err;
    }
  }
  doc.destroy();

  const costUsd = costFromUsage(modelVersion, inputTokens, outputTokens);

  // Cache only a successful result — including a confident empty result — so a
  // re-run skips the paid calls. Never cache a truncated/parse_error run.
  if (useCache && fileHash && status === "success") {
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
