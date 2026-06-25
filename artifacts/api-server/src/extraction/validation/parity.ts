// Parity harness (Task #174, T008).
//
// Goal: keep the TS-native extraction engine honest against the Python pipeline
// it replaces, WITHOUT making paid Claude Vision calls or reaching the network.
// It does this two ways:
//
//   1. Pure, no-IO "hard gates" that encode the load-bearing invariants the two
//      engines must both satisfy. They run over plain data — either fixtures or
//      rows already saved by either engine — so they are unit-testable and can be
//      wired into CI.
//        - no_trusted_on_truncation: a non-"success" extraction must be
//          fail-closed (ok:false, zero stored rows). Catches the data-loss class
//          where a truncated/parse_error result is trusted and wipes rows.
//        - no_cross_unit_leak: a teacher BA/MA education grid must never be
//          attributed to a non-teacher bargaining unit.
//        - salary_cells_exact_or_flagged: where a TS salary cell disagrees with
//          the Python baseline for the same (schedule, step, lane), the TS
//          schedule MUST be flagged needs_review (Option B never silently
//          diverges).
//
//   2. A read-only loader that pulls the salary rows already stored in the DB so
//      the cross-unit-leak gate can be run over real data with no model calls.
//
// A live, paid TS-vs-Python diff on representative documents (render -> vision
// extract -> normalize -> compare) is intentionally deferred: this environment
// cannot make paid model calls or reach the source hosts. When that becomes
// possible, dry-run the TS extractors and feed their normalized output into the
// same gates below.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import type { ExtractionStatus, SalaryCell, SalarySchedule } from "../types";
import { isEducationSchedule } from "../domains/salary-grid";

export interface ParityGateResult {
  gate: string;
  passed: boolean;
  checked: number;
  violations: string[];
}

export interface ParityReport {
  passed: boolean;
  gates: ParityGateResult[];
}

export function combineGates(gates: ParityGateResult[]): ParityReport {
  return { passed: gates.every((g) => g.passed), gates };
}

export function formatParityReport(report: ParityReport): string {
  const lines = [report.passed ? "PARITY: PASS" : "PARITY: FAIL"];
  for (const g of report.gates) {
    lines.push(`  [${g.passed ? "PASS" : "FAIL"}] ${g.gate} (checked ${g.checked})`);
    for (const v of g.violations) lines.push(`      - ${v}`);
  }
  return lines.join("\n");
}

// ----- gate 1: fail-closed on non-success -----

// One domain extraction's outcome, reduced to what the invariant cares about:
// its status, whether it was treated as ok (=storeable), and how many rows the
// orchestrator would persist for it.
export interface ExtractionOutcomeRow {
  label: string;
  status: ExtractionStatus;
  ok: boolean;
  storedRows: number;
}

// ok must track status exactly, and a non-success outcome must store nothing.
export function gateNoTrustedOnTruncation(
  rows: ExtractionOutcomeRow[],
): ParityGateResult {
  const violations: string[] = [];
  for (const r of rows) {
    if (r.status === "success") {
      if (!r.ok) violations.push(`${r.label}: status=success but ok=false`);
    } else {
      if (r.ok) violations.push(`${r.label}: status=${r.status} but ok=true`);
      if (r.storedRows > 0) {
        violations.push(`${r.label}: status=${r.status} but storedRows=${r.storedRows}`);
      }
    }
  }
  return {
    gate: "no_trusted_on_truncation",
    passed: violations.length === 0,
    checked: rows.length,
    violations,
  };
}

// ----- gate 2: no cross-unit (education-grid) leak -----

// A salary schedule as attributed to a bargaining unit (post-routing). Only the
// fields the leak check needs.
export interface RoutedScheduleRow {
  label: string;
  unit: string;
  schedule: Pick<SalarySchedule, "scheduleName" | "laneLabels">;
}

// A teacher education grid (BA/MA/PhD lanes, or a name mentioning "teacher")
// attributed to anything other than "teachers" is a leak.
export function gateNoCrossUnitLeak(
  rows: RoutedScheduleRow[],
): ParityGateResult {
  const violations: string[] = [];
  for (const r of rows) {
    if (r.unit !== "teachers" && isEducationSchedule(r.schedule)) {
      violations.push(
        `${r.label}: education grid "${r.schedule.scheduleName}" attributed to non-teacher unit "${r.unit}"`,
      );
    }
  }
  return {
    gate: "no_cross_unit_leak",
    passed: violations.length === 0,
    checked: rows.length,
    violations,
  };
}

// ----- gate 3: salary cells exact-or-flagged vs baseline -----

export interface ParitySchedule {
  scheduleName: string;
  schoolYear: string | null;
  needsReview: boolean;
  cells: Array<Pick<SalaryCell, "stepLabel" | "laneLabel" | "salaryAmount">>;
}

const schedKey = (s: { scheduleName: string; schoolYear: string | null }): string =>
  `${s.scheduleName}\u0000${s.schoolYear ?? ""}`;
const cellKey = (c: { stepLabel: string; laneLabel: string | null }): string =>
  `${c.stepLabel}\u0000${c.laneLabel ?? ""}`;

// For every cell present in BOTH the candidate (TS) and baseline (Python) for the
// same (schedule, step, lane): the values must agree (within `slack`) OR the
// candidate schedule must be flagged needs_review. A silent disagreement is a
// parity violation. Schedules/cells with no baseline counterpart are not graded
// here (coverage is a separate concern from per-cell fidelity).
export function gateSalaryCellsExactOrFlagged(
  baseline: ParitySchedule[],
  candidate: ParitySchedule[],
  opts?: { slack?: number },
): ParityGateResult {
  const slack = opts?.slack ?? 0;
  const baseBy = new Map(baseline.map((s) => [schedKey(s), s]));
  const violations: string[] = [];
  let checked = 0;
  for (const cand of candidate) {
    const base = baseBy.get(schedKey(cand));
    if (!base) continue;
    const baseCells = new Map(base.cells.map((c) => [cellKey(c), c.salaryAmount]));
    for (const c of cand.cells) {
      const b = baseCells.get(cellKey(c));
      if (b === undefined) continue;
      checked++;
      if (Math.abs(b - c.salaryAmount) > slack && !cand.needsReview) {
        violations.push(
          `${cand.scheduleName} [${c.stepLabel}/${c.laneLabel ?? "-"}]: TS=${c.salaryAmount} vs PY=${b}, schedule not flagged`,
        );
      }
    }
  }
  return {
    gate: "salary_cells_exact_or_flagged",
    passed: violations.length === 0,
    checked,
    violations,
  };
}

// ----- read-only DB loader (no model calls) -----

// Load the salary schedules already stored for the given source documents, as
// routed rows, so gateNoCrossUnitLeak can run over real data. Read-only.
export async function loadRoutedSalaryFromDb(
  sourceDocIds: ReadonlyArray<number | string>,
): Promise<RoutedScheduleRow[]> {
  if (!sourceDocIds.length) return [];
  const ids = sql.join(
    sourceDocIds.map((i) => sql`${i}`),
    sql`, `,
  );
  const res = await db.execute(sql`
    SELECT s.id::text             AS "id",
           s.bargaining_unit      AS "unit",
           s.schedule_name        AS "scheduleName",
           s.lane_labels          AS "laneLabels",
           s.source_doc_id::text  AS "sourceDocId"
    FROM contract_salary_schedules s
    WHERE s.source_doc_id IN (${ids})
    ORDER BY s.id
  `);
  return res.rows.map((r) => {
    const row = r as {
      id: string;
      unit: string;
      scheduleName: string;
      laneLabels: unknown;
      sourceDocId: string;
    };
    let laneLabels: string[] | null = null;
    if (Array.isArray(row.laneLabels)) {
      laneLabels = row.laneLabels as string[];
    } else if (typeof row.laneLabels === "string" && row.laneLabels) {
      try {
        laneLabels = JSON.parse(row.laneLabels) as string[];
      } catch {
        laneLabels = null;
      }
    }
    return {
      label: `doc ${row.sourceDocId} / sched ${row.id}`,
      unit: row.unit,
      schedule: { scheduleName: row.scheduleName, laneLabels },
    };
  });
}

// Run the no-model gates that can be evaluated over stored data alone.
export async function runStoredSalaryParity(
  sourceDocIds: ReadonlyArray<number | string>,
): Promise<ParityReport> {
  const routed = await loadRoutedSalaryFromDb(sourceDocIds);
  return combineGates([gateNoCrossUnitLeak(routed)]);
}

// ----- CLI: `tsx src/extraction/validation/parity.ts <sourceDocId...>` -----

async function main(argv: string[]): Promise<void> {
  const ids = argv.filter((a) => /^\d+$/.test(a));
  if (!ids.length) {
    console.error(
      "usage: parity <sourceDocId...>\n" +
        "  Runs no-model parity gates over salary rows already stored for those docs.",
    );
    process.exitCode = 2;
    return;
  }
  const report = await runStoredSalaryParity(ids);
  console.log(formatParityReport(report));
  process.exitCode = report.passed ? 0 : 1;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) void main(process.argv.slice(2));
