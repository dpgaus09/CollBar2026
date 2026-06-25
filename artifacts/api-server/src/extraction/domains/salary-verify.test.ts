import { describe, it, expect } from "vitest";
import {
  verifySalaryAgainstText,
  SALARY_VERIFY_REASON,
} from "./salary-verify";
import type { SalaryCell, SalarySchedule } from "../types";

function cell(stepOrder: number, salaryAmount: number, pageRef = 1): SalaryCell {
  return {
    stepLabel: String(stepOrder),
    stepOrder,
    laneLabel: "Salary",
    laneOrder: 0,
    salaryAmount,
    pageRef,
  };
}

function sched(cells: SalaryCell[], partial?: Partial<SalarySchedule>): SalarySchedule {
  return {
    scheduleName: "Teachers",
    schoolYear: "2024-2025",
    startYear: 2024,
    scheduleType: "single_column",
    laneLabels: null,
    stepCount: cells.length,
    laneCount: 1,
    pageStart: 1,
    pageEnd: 1,
    minSalary: Math.min(...cells.map((c) => c.salaryAmount)),
    maxSalary: Math.max(...cells.map((c) => c.salaryAmount)),
    confidence: 0.85,
    needsReview: false,
    reviewReason: null,
    extractionMethod: "claude_vision",
    cells,
    ...partial,
  };
}

// A digital page whose text layer lists the given salaries (comma-grouped),
// padded with prose so it clears the min-text-chars gate.
function digitalPage(salaries: number[]): string {
  const lines = salaries.map(
    (s, i) => `Step ${i + 1}  ${s.toLocaleString("en-US")}`,
  );
  return (
    "TEACHERS SALARY SCHEDULE 2024-2025\nStep  Salary\n" + lines.join("\n")
  );
}

function fakeDoc(pages: Record<number, string>) {
  return { pageText: (i: number) => pages[i] ?? "" };
}

describe("verifySalaryAgainstText", () => {
  it("does not flag when every cell is corroborated by the text layer", () => {
    const s = sched([cell(1, 40000), cell(2, 45000), cell(3, 50000)]);
    const doc = fakeDoc({ 0: digitalPage([40000, 45000, 50000]) });
    const stats = verifySalaryAgainstText([s], doc);
    expect(s.needsReview).toBe(false);
    expect(s.reviewReason).toBeNull();
    expect(stats.cellsChecked).toBe(3);
    expect(stats.cellsMismatched).toBe(0);
    expect(stats.schedulesFlagged).toBe(0);
  });

  it("flags (never overwrites) a cell the text layer cannot corroborate", () => {
    const s = sched([cell(1, 40000), cell(2, 45000), cell(3, 99999)]);
    // Text layer has the first two but a different third value.
    const doc = fakeDoc({ 0: digitalPage([40000, 45000, 50000]) });
    const stats = verifySalaryAgainstText([s], doc);
    expect(s.needsReview).toBe(true);
    expect(s.reviewReason).toContain(SALARY_VERIFY_REASON);
    expect(s.confidence).toBe(0.5);
    // The value is NEVER replaced with the text-layer number.
    expect(s.cells[2].salaryAmount).toBe(99999);
    expect(stats.cellsMismatched).toBe(1);
    expect(stats.schedulesFlagged).toBe(1);
  });

  it("skips scanned pages (no text layer) without flagging", () => {
    const s = sched([cell(1, 40000), cell(2, 45000)]);
    const doc = fakeDoc({ 0: "" }); // scanned page
    const stats = verifySalaryAgainstText([s], doc);
    expect(s.needsReview).toBe(false);
    expect(stats.schedulesChecked).toBe(0);
    expect(stats.cellsChecked).toBe(0);
  });

  it("tolerates a $1 cents-rounding difference", () => {
    const s = sched([cell(1, 40000), cell(2, 45000)]);
    // Text prints rounded-up cents: 40,001 / 45,001 vs cell 40000 / 45000.
    const doc = fakeDoc({ 0: digitalPage([40001, 45001]) });
    verifySalaryAgainstText([s], doc);
    expect(s.needsReview).toBe(false);
  });

  it("recognizes bare (comma-less) and $-prefixed money tokens", () => {
    const s = sched([cell(1, 40000), cell(2, 45000)]);
    const doc = fakeDoc({
      0: "Salary schedule for teachers\nStep 1 40000 and Step 2 $45,000 total",
    });
    const stats = verifySalaryAgainstText([s], doc);
    expect(s.needsReview).toBe(false);
    expect(stats.cellsMismatched).toBe(0);
  });

  it("merges with an existing review reason instead of clobbering it", () => {
    const s = sched([cell(1, 40000), cell(2, 99999)], {
      needsReview: true,
      reviewReason: "salary_below_floor",
      confidence: 0.5,
    });
    const doc = fakeDoc({ 0: digitalPage([40000, 45000]) });
    verifySalaryAgainstText([s], doc);
    expect(s.reviewReason).toContain("salary_below_floor");
    expect(s.reviewReason).toContain(SALARY_VERIFY_REASON);
  });

  it("verifies cells against their own page in a multi-page schedule", () => {
    const s = sched([cell(1, 40000, 1), cell(2, 45000, 2)]);
    const doc = fakeDoc({
      0: digitalPage([40000]),
      1: digitalPage([45000]),
    });
    const stats = verifySalaryAgainstText([s], doc);
    expect(s.needsReview).toBe(false);
    expect(stats.cellsChecked).toBe(2);
  });
});
