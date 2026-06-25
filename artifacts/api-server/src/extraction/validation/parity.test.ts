import { describe, it, expect, vi } from "vitest";

// parity.ts imports @workspace/db at module load; stub it so importing the pure
// gates never opens a real connection. The pure gates take plain data and do no
// IO, so the stub is never actually called by these tests.
vi.mock("@workspace/db", () => ({ db: { execute: vi.fn() } }));

import {
  gateNoTrustedOnTruncation,
  gateNoCrossUnitLeak,
  gateSalaryCellsExactOrFlagged,
  combineGates,
  type ParitySchedule,
  type RoutedScheduleRow,
} from "./parity";

describe("gateNoTrustedOnTruncation", () => {
  it("passes when success=>ok and non-success store nothing", () => {
    const g = gateNoTrustedOnTruncation([
      { label: "a", status: "success", ok: true, storedRows: 5 },
      { label: "b", status: "truncated", ok: false, storedRows: 0 },
      { label: "c", status: "parse_error", ok: false, storedRows: 0 },
    ]);
    expect(g.passed).toBe(true);
    expect(g.checked).toBe(3);
  });

  it("fails when a truncated result is trusted (ok:true)", () => {
    const g = gateNoTrustedOnTruncation([
      { label: "b", status: "truncated", ok: true, storedRows: 0 },
    ]);
    expect(g.passed).toBe(false);
    expect(g.violations[0]).toContain("ok=true");
  });

  it("fails when a non-success result would store rows", () => {
    const g = gateNoTrustedOnTruncation([
      { label: "c", status: "parse_error", ok: false, storedRows: 3 },
    ]);
    expect(g.passed).toBe(false);
    expect(g.violations[0]).toContain("storedRows=3");
  });

  it("fails when a success result is not ok", () => {
    const g = gateNoTrustedOnTruncation([
      { label: "d", status: "success", ok: false, storedRows: 0 },
    ]);
    expect(g.passed).toBe(false);
    expect(g.violations[0]).toContain("status=success but ok=false");
  });
});

describe("gateNoCrossUnitLeak", () => {
  const rows = (over: Partial<RoutedScheduleRow>[]): RoutedScheduleRow[] =>
    over.map((o, i) => ({
      label: `r${i}`,
      unit: "teachers",
      schedule: { scheduleName: "X", laneLabels: null },
      ...o,
    }));

  it("passes when an education grid is on the teachers unit", () => {
    const g = gateNoCrossUnitLeak(
      rows([{ unit: "teachers", schedule: { scheduleName: "Cert Salary", laneLabels: ["BA", "MA"] } }]),
    );
    expect(g.passed).toBe(true);
  });

  it("fails when an education grid leaks onto a non-teacher unit", () => {
    const g = gateNoCrossUnitLeak(
      rows([
        { unit: "support_staff", schedule: { scheduleName: "Salary", laneLabels: ["BA", "MA+30"] } },
      ]),
    );
    expect(g.passed).toBe(false);
    expect(g.violations[0]).toContain("non-teacher unit");
  });

  it("allows a genuine non-education grid on a non-teacher unit", () => {
    const g = gateNoCrossUnitLeak(
      rows([
        { unit: "support_staff", schedule: { scheduleName: "Custodian Hourly", laneLabels: ["Grade 1"] } },
      ]),
    );
    expect(g.passed).toBe(true);
  });
});

describe("gateSalaryCellsExactOrFlagged", () => {
  const sched = (over: Partial<ParitySchedule> = {}): ParitySchedule => ({
    scheduleName: "Teacher 2024-25",
    schoolYear: "2024-25",
    needsReview: false,
    cells: [
      { stepLabel: "1", laneLabel: "BA", salaryAmount: 40000 },
      { stepLabel: "2", laneLabel: "BA", salaryAmount: 41000 },
    ],
    ...over,
  });

  it("passes when TS cells match the Python baseline exactly", () => {
    const g = gateSalaryCellsExactOrFlagged([sched()], [sched()]);
    expect(g.passed).toBe(true);
    expect(g.checked).toBe(2);
  });

  it("fails when an unflagged TS cell diverges from baseline", () => {
    const cand = sched({
      cells: [
        { stepLabel: "1", laneLabel: "BA", salaryAmount: 40000 },
        { stepLabel: "2", laneLabel: "BA", salaryAmount: 99999 },
      ],
    });
    const g = gateSalaryCellsExactOrFlagged([sched()], [cand]);
    expect(g.passed).toBe(false);
    expect(g.violations[0]).toContain("99999");
  });

  it("passes a divergent cell when the schedule is flagged for review", () => {
    const cand = sched({
      needsReview: true,
      cells: [
        { stepLabel: "1", laneLabel: "BA", salaryAmount: 40000 },
        { stepLabel: "2", laneLabel: "BA", salaryAmount: 99999 },
      ],
    });
    const g = gateSalaryCellsExactOrFlagged([sched()], [cand]);
    expect(g.passed).toBe(true);
  });

  it("ignores cells that have no baseline counterpart (coverage, not fidelity)", () => {
    const cand = sched({
      cells: [{ stepLabel: "9", laneLabel: "PhD", salaryAmount: 70000 }],
    });
    const g = gateSalaryCellsExactOrFlagged([sched()], [cand]);
    expect(g.passed).toBe(true);
    expect(g.checked).toBe(0);
  });
});

describe("combineGates", () => {
  it("is passed only when every gate passes", () => {
    const pass = gateNoTrustedOnTruncation([]);
    const fail = gateNoCrossUnitLeak([
      { label: "x", unit: "support_staff", schedule: { scheduleName: "S", laneLabels: ["MA"] } },
    ]);
    expect(combineGates([pass]).passed).toBe(true);
    expect(combineGates([pass, fail]).passed).toBe(false);
  });
});
