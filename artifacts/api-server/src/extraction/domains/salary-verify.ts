// Option B (Task #174): for DIGITAL PDFs — pages that carry a real text layer —
// cross-check each vision-extracted salary value against the exact numbers
// printed on its page. Vision stays authoritative: we NEVER overwrite a value
// with the text layer. A value the text layer cannot corroborate is flagged for
// human review (needs_review + reason) and its confidence is lowered so it
// routes to the re-run queue. Scanned pages (no usable text layer) are skipped —
// there is nothing to verify against.

import type { PdfDoc } from "../pdf/renderer";
import { logger } from "../../lib/logger";
import type { SalarySchedule } from "../types";

// Money tokens on a page: comma-grouped ("45,000", "45,000.50") or a bare 4-7
// digit run ("45000"), each optionally with cents. Order-independent set
// membership absorbs the column/row scrambling that text extraction introduces.
const MONEY_TOKEN_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,7}(?:\.\d+)?/g;

// A page with at least this many text-layer characters is treated as digital
// (verifiable). Scanned pages extract little/no text and are skipped.
const MIN_PAGE_TEXT_CHARS = 40;

// The model is told to "ignore cents" while text normalization rounds them, so
// allow a $1 slack on the exact-value match (a real OCR error is far larger).
const VALUE_SLACK = 1;

export const SALARY_VERIFY_REASON = "text_verify_mismatch";

function pageMoneySet(text: string): Set<number> {
  const out = new Set<number>();
  const matches = text.match(MONEY_TOKEN_RE);
  if (!matches) return out;
  for (const m of matches) {
    const n = Math.round(Number(m.replace(/,/g, "")));
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out;
}

function corroborated(set: Set<number>, value: number): boolean {
  for (let d = -VALUE_SLACK; d <= VALUE_SLACK; d++) {
    if (set.has(value + d)) return true;
  }
  return false;
}

// Merge a review reason into the schedule's existing ;-joined reason set without
// clobbering reasons set by the magnitude/shape sanity checks.
function addReason(sched: SalarySchedule, reason: string): void {
  const reasons = new Set(
    (sched.reviewReason ?? "")
      .split(";")
      .map((r) => r.trim())
      .filter(Boolean),
  );
  reasons.add(reason);
  sched.reviewReason = [...reasons].sort().join(";");
}

export interface SalaryVerifyStats {
  schedulesChecked: number;
  schedulesFlagged: number;
  cellsChecked: number;
  cellsMismatched: number;
}

// Mutates `schedules` in place: flags any whose cells the page text cannot
// corroborate. Never changes a salary value. Returns telemetry for logging/tests.
export function verifySalaryAgainstText(
  schedules: SalarySchedule[],
  doc: Pick<PdfDoc, "pageText">,
  opts?: { minPageTextChars?: number },
): SalaryVerifyStats {
  const minChars = opts?.minPageTextChars ?? MIN_PAGE_TEXT_CHARS;
  const stats: SalaryVerifyStats = {
    schedulesChecked: 0,
    schedulesFlagged: 0,
    cellsChecked: 0,
    cellsMismatched: 0,
  };
  // null = page is scanned/unverifiable; cached so each page is read once.
  const moneyByPage = new Map<number, Set<number> | null>();

  const getSet = (pageIdx: number): Set<number> | null => {
    if (moneyByPage.has(pageIdx)) return moneyByPage.get(pageIdx) ?? null;
    let set: Set<number> | null = null;
    try {
      const text = doc.pageText(pageIdx);
      set = text.length >= minChars ? pageMoneySet(text) : null;
    } catch (err) {
      logger.warn({ err, pageIdx }, "salary verify: pageText failed; skipping");
      set = null;
    }
    moneyByPage.set(pageIdx, set);
    return set;
  };

  for (const sched of schedules) {
    let checked = 0;
    let mismatched = 0;
    for (const cell of sched.cells) {
      const set = getSet(cell.pageRef - 1);
      if (!set) continue; // scanned / unverifiable page
      checked++;
      if (!corroborated(set, cell.salaryAmount)) mismatched++;
    }
    if (checked === 0) continue; // nothing verifiable on this schedule's pages
    stats.schedulesChecked++;
    stats.cellsChecked += checked;
    stats.cellsMismatched += mismatched;
    if (mismatched > 0) {
      sched.needsReview = true;
      sched.confidence = Math.min(sched.confidence, 0.5);
      addReason(sched, SALARY_VERIFY_REASON);
      stats.schedulesFlagged++;
      logger.info(
        { schedule: sched.scheduleName, checked, mismatched },
        "salary verify: text-layer mismatch; flagged for review",
      );
    }
  }
  return stats;
}
