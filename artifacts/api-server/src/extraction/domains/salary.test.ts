import { describe, it, expect } from "vitest";
import { normalize, toIntMoney } from "./salary";
import {
  canonLane,
  classifyScheduleUnit,
  isEducationSchedule,
  routeSchedules,
} from "./salary-grid";
import type { SalarySchedule } from "../types";

// Minimal SalarySchedule factory for routing tests.
function sched(
  partial: Partial<SalarySchedule> & Pick<SalarySchedule, "scheduleName">,
): SalarySchedule {
  return {
    schoolYear: "2024-2025",
    startYear: 2024,
    scheduleType: "lane_grid",
    laneLabels: null,
    stepCount: 5,
    laneCount: 1,
    pageStart: 1,
    pageEnd: 1,
    minSalary: 40000,
    maxSalary: 80000,
    confidence: 0.85,
    needsReview: false,
    reviewReason: null,
    extractionMethod: "claude_vision",
    cells: [],
    ...partial,
  };
}

describe("toIntMoney", () => {
  it("strips $ and commas, rounds cents", () => {
    expect(toIntMoney("$45,000")).toBe(45000);
    expect(toIntMoney("45000.67")).toBe(45001);
  });
  it("rejects non-positive / sentinel / non-numeric", () => {
    expect(toIntMoney("0")).toBeNull();
    expect(toIntMoney("-")).toBeNull();
    expect(toIntMoney("null")).toBeNull();
    expect(toIntMoney(null)).toBeNull();
    expect(toIntMoney("abc")).toBeNull();
    expect(toIntMoney("")).toBeNull();
  });
});

describe("canonLane", () => {
  it("canonicalizes spelled-out degree lanes (remap branch)", () => {
    expect(canonLane("Bachelors")).toBe("BA");
    expect(canonLane("Master's + 30")).toBe("MA+30");
    expect(canonLane("M.A.")).toBe("MA");
    expect(canonLane("Doctoral Degree")).toBe("PhD");
  });
  it("tidies headers already recognized by the lane regex (parity with Python _norm_lane)", () => {
    // "Ph.D." is matched by the lane regex, so it is tidied, not remapped —
    // dots are preserved exactly as Python does.
    expect(canonLane("Ph.D.")).toBe("Ph.D.");
    expect(canonLane("ba + 15")).toBe("BA+15");
  });
  it("leaves non-degree headers unchanged", () => {
    expect(canonLane("Salary")).toBe("Salary");
    expect(canonLane("Grade 1")).toBe("Grade 1");
  });
});

describe("isEducationSchedule / classifyScheduleUnit", () => {
  it("detects education by lane or name", () => {
    expect(isEducationSchedule(sched({ scheduleName: "X", laneLabels: ["BA", "MA"] }))).toBe(true);
    expect(isEducationSchedule(sched({ scheduleName: "Teachers Salary" }))).toBe(true);
    expect(isEducationSchedule(sched({ scheduleName: "Custodians", laneLabels: ["Salary"] }))).toBe(false);
  });
  it("classifies non-teacher job families by name", () => {
    expect(classifyScheduleUnit(sched({ scheduleName: "Secretary Schedule", laneLabels: ["Salary"] }))).toBe("secretarial_clerical");
    expect(classifyScheduleUnit(sched({ scheduleName: "Custodian Pay", laneLabels: ["Salary"] }))).toBe("support_staff");
    expect(classifyScheduleUnit(sched({ scheduleName: "Misc Stipend", laneLabels: ["Salary"] }))).toBeNull();
    expect(classifyScheduleUnit(sched({ scheduleName: "X", laneLabels: ["BA", "MA"] }))).toBe("teachers");
  });
});

describe("routeSchedules — cross-unit leak protection", () => {
  it("routes a teacher education grid to teachers, never to a non-teacher sibling", () => {
    const teacherGrid = sched({ scheduleName: "Appendix A", laneLabels: ["BA", "MA"] });
    const { routed } = routeSchedules([teacherGrid], new Set(["teachers", "support_staff"]));
    expect(routed.get("teachers")).toHaveLength(1);
    expect(routed.get("support_staff")).toBeUndefined();
  });

  it("leaves a teacher grid UNATTRIBUTED when no teachers contract is on the doc (no leak onto support_staff)", () => {
    const teacherGrid = sched({ scheduleName: "Appendix A", laneLabels: ["BA", "MA"] });
    const { routed, unattributed } = routeSchedules([teacherGrid], new Set(["support_staff"]));
    expect(routed.get("support_staff")).toBeUndefined();
    expect(unattributed).toHaveLength(1);
  });

  it("routes a named non-teacher schedule to its matching sibling unit", () => {
    const custodian = sched({ scheduleName: "Custodian Salary", laneLabels: ["Salary"] });
    const { routed } = routeSchedules([custodian], new Set(["teachers", "support_staff"]));
    expect(routed.get("support_staff")).toHaveLength(1);
    expect(routed.get("teachers")).toBeUndefined();
  });

  it("routes a generic non-education schedule to the primary unit", () => {
    const generic = sched({ scheduleName: "Salary Schedule", laneLabels: ["Salary"] });
    const { routed } = routeSchedules([generic], new Set(["teachers"]));
    expect(routed.get("teachers")).toHaveLength(1);
  });
});

describe("normalize — fail-closed parsing", () => {
  it("parses a lane_grid into per-(step,lane) cells", () => {
    const out = normalize([
      {
        schedule_name: "Teachers",
        school_year: "2024-2025",
        schedule_type: "lane_grid",
        lane_labels: ["BA", "MA"],
        page: 7,
        rows: [
          [1, 40000, 45000],
          [2, 41000, 46000],
          [3, 42000, 47000],
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.cells).toHaveLength(6);
    expect(s.stepCount).toBe(3);
    expect(s.laneCount).toBe(2);
    expect(s.minSalary).toBe(40000);
    expect(s.maxSalary).toBe(47000);
    expect(s.startYear).toBe(2024);
    expect(s.pageStart).toBe(7);
    expect(s.needsReview).toBe(false);
  });

  it("DROPS a schedule whose row width != lane count (lane-shift guard)", () => {
    const out = normalize([
      {
        schedule_name: "Teachers",
        school_year: "2024-2025",
        schedule_type: "lane_grid",
        lane_labels: ["BA", "MA", "PhD"],
        page: 1,
        rows: [
          [1, 40000, 45000], // only 2 values for 3 lanes -> dropped whole schedule
          [2, 41000, 46000],
        ],
      },
    ]);
    expect(out).toHaveLength(0);
  });

  it("never invents a value for a blank cell (null stays missing)", () => {
    const out = normalize([
      {
        schedule_name: "Teachers",
        school_year: "2024-2025",
        schedule_type: "lane_grid",
        lane_labels: ["BA", "MA"],
        page: 1,
        rows: [
          [1, 40000, null],
          [2, 41000, 46000],
          [3, 42000, 47000],
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    // The blank MA cell on step 1 must simply be absent, not carried/invented.
    const ma1 = out[0].cells.find((c) => c.stepOrder === 1 && c.laneLabel === "MA");
    expect(ma1).toBeUndefined();
    expect(out[0].cells).toHaveLength(5);
  });

  it("flags an education grid below the salary floor for review", () => {
    const out = normalize([
      {
        schedule_name: "Teachers",
        school_year: "2024-2025",
        schedule_type: "lane_grid",
        lane_labels: ["BA", "MA"],
        page: 1,
        rows: [
          [1, 12, 14], // implausible base salaries
          [2, 13, 15],
          [3, 16, 18],
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].needsReview).toBe(true);
    expect(out[0].confidence).toBe(0.5);
    expect(out[0].reviewReason).toContain("salary_below_floor");
  });

  it("flags too-few-steps schedules", () => {
    const out = normalize([
      {
        schedule_name: "Teachers",
        school_year: "2024-2025",
        schedule_type: "lane_grid",
        lane_labels: ["BA", "MA"],
        page: 1,
        rows: [[1, 40000, 45000]], // 1 step < MIN_ROWS
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].needsReview).toBe(true);
    expect(out[0].reviewReason).toContain("too_few_steps");
  });

  it("parses a single_column schedule with implicit Salary lane", () => {
    const out = normalize([
      {
        schedule_name: "Aides",
        school_year: "2024-2025",
        schedule_type: "single_column",
        lane_labels: [],
        page: 3,
        rows: [
          [1, 30000],
          [2, 31000],
          [3, 32000],
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].scheduleType).toBe("single_column");
    expect(out[0].cells.every((c) => c.laneLabel === "Salary" && c.laneOrder === 0)).toBe(true);
  });

  it("nulls an unparseable school year (store synthesizes a placeholder later)", () => {
    const out = normalize([
      {
        schedule_name: "Teachers",
        school_year: "sometime",
        schedule_type: "lane_grid",
        lane_labels: ["BA", "MA"],
        page: 1,
        rows: [
          [1, 40000, 45000],
          [2, 41000, 46000],
          [3, 42000, 47000],
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].schoolYear).toBeNull();
    expect(out[0].startYear).toBeNull();
  });
});
