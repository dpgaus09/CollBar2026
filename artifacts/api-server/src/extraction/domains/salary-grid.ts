// Salary-grid helpers ported from pipeline/lib_salary_grid.py.
//
// These are the deterministic, no-network pieces the salary domain relies on:
// education-lane recognition / canonicalization, magnitude sanity bounds, and
// the unit-routing rules that decide which bargaining unit a schedule belongs
// to. Routing is the load-bearing invariant: a teacher BA/MA education grid must
// NEVER be attributed to a non-teacher unit (support staff, secretarial, etc.).

import type { SalarySchedule } from "../types";

// A schedule needs at least this many distinct step rows to be trusted.
export const MIN_ROWS = 3;

// Plausible base-salary bounds for an education (teacher) schedule. Values
// outside this range flag the schedule for review rather than trusting it.
export const EDU_SALARY_FLOOR = 15000;
export const EDU_SALARY_CEILING = 300000;

// Recognizes education pay lanes: BA/BS/MA/MS optionally with "+N" or "or N"
// increments, plus doctorate lanes (PhD / EdD / Doctorate). Case-insensitive,
// NON-global so `.test()` stays stateless.
export const LANE_RE =
  /(?:BA|BS|MA|MS)\s*(?:\+|or)\s*\d+|Ph\.?\s?D\.?|Ed\.?\s?D\.?|Doctorate|\bBA\b|\bBS\b|\bMA\b|\bMS\b/i;

// Job-family keywords that identify a NON-teacher schedule by its name.
const UNIT_KW: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["secretarial_clerical", ["SECRETAR", "CLERICAL", "CLERK"]],
  [
    "support_staff",
    [
      "CUSTOD",
      "MAINTEN",
      "JANITOR",
      "GROUNDS",
      "PARAPROF",
      "AIDE",
      "FOOD",
      "CAFETER",
      "BUS DRIV",
      "TRANSPORT",
    ],
  ],
];

// Tidy spacing and uppercase the degree token while leaving "or"/"+" lowercase.
export function normLane(s: string): string {
  let r = String(s).trim().replace(/\s*\+\s*/g, "+");
  r = r.replace(/\s+/g, " ");
  r = r.replace(/\b(ba|bs|ma|ms|phd|edd)\b/gi, (m) => m.toUpperCase());
  return r;
}

// Canonicalize an education-lane header to the abbreviation the router
// recognizes. A scanned page may spell lanes out ("Bachelors", "Master's + 30",
// "M.A."); left as-is those evade isEducationSchedule and an education grid
// could be misrouted onto a non-teacher unit. Degree words map to canonical
// abbreviations; anything not clearly a degree is returned unchanged (so
// "Salary" or "Grade 1" are never falsely marked as education).
export function canonLane(label: string): string {
  const s = String(label).trim().replace(/\s+/g, " ");
  if (!s) return s;
  if (LANE_RE.test(s)) return normLane(s); // already recognized -> tidy spacing
  const low = s.toLowerCase();
  const incM = low.match(/(?:\+\s*|\bor\s+)(\d{1,3})\b/);
  const inc = incM ? "+" + incM[1] : "";
  if (/\bph\.?\s?d\b|\bdoctor/.test(low)) return "PhD";
  if (/\bed\.?\s?d\b/.test(low)) return "EdD";
  if (/\bmaster|\bm\.\s?ed\b|\bm\.\s?a\b|\bm\.\s?s\b/.test(low)) {
    const base = /\bm\.\s?s\b|master of science/.test(low) ? "MS" : "MA";
    return base + inc;
  }
  if (/\bbachelor|\bb\.\s?a\b|\bb\.\s?s\b/.test(low)) {
    const base = /\bb\.\s?s\b|bachelor of science/.test(low) ? "BS" : "BA";
    return base + inc;
  }
  return s;
}

type RoutableSchedule = Pick<SalarySchedule, "scheduleName" | "laneLabels">;

// True if a schedule is an education (teacher) salary schedule: any lane label
// looks like a degree lane, or the name mentions "teacher".
export function isEducationSchedule(s: RoutableSchedule): boolean {
  for (const label of s.laneLabels ?? []) {
    if (LANE_RE.test(String(label))) return true;
  }
  return (s.scheduleName ?? "").toUpperCase().includes("TEACHER");
}

// Classify a schedule's bargaining unit from its lanes + name. "teachers" when
// it's an education schedule; otherwise match non-teacher job-family keywords;
// null when it can't be classified.
export function classifyScheduleUnit(s: RoutableSchedule): string | null {
  if (isEducationSchedule(s)) return "teachers";
  const name = (s.scheduleName ?? "").toUpperCase();
  for (const [unit, kws] of UNIT_KW) {
    if (kws.some((kw) => name.includes(kw))) return unit;
  }
  return null;
}

export interface RoutedSchedules {
  // unit -> schedules attributed to that unit (unit is in siblingUnits)
  routed: Map<string, SalarySchedule[]>;
  // schedules that could not be safely attributed to any sibling unit
  unattributed: SalarySchedule[];
}

// Route schedules to the bargaining units that actually exist on this document
// (`siblingUnits`). Rules, in order:
//   - teacher/education schedule -> "teachers" iff that unit exists here, else
//     unattributed (NEVER forced onto a non-teacher unit).
//   - a schedule whose job family matches a sibling unit -> that unit.
//   - an otherwise-unclassified NON-education schedule -> the primary unit
//     (teachers if present, else the alphabetically-first sibling).
//   - everything else -> unattributed.
export function routeSchedules(
  schedules: SalarySchedule[],
  siblingUnits: Set<string>,
): RoutedSchedules {
  const primary = siblingUnits.has("teachers")
    ? "teachers"
    : siblingUnits.size
      ? [...siblingUnits].sort()[0]
      : null;
  const routed = new Map<string, SalarySchedule[]>();
  const unattributed: SalarySchedule[] = [];
  const push = (unit: string, s: SalarySchedule) => {
    const arr = routed.get(unit) ?? [];
    arr.push(s);
    routed.set(unit, arr);
  };
  for (const s of schedules) {
    const unit = classifyScheduleUnit(s);
    if (unit === "teachers") {
      if (siblingUnits.has("teachers")) push("teachers", s);
      else unattributed.push(s);
    } else if (unit !== null && siblingUnits.has(unit)) {
      push(unit, s);
    } else if (primary !== null && !isEducationSchedule(s)) {
      push(primary, s);
    } else {
      unattributed.push(s);
    }
  }
  return { routed, unattributed };
}
