import { describe, it, expect, vi, beforeEach } from "vitest";

// deriveStatedSettlements reads from the DB; mock the db module so the test is
// pure. Each `db.execute` call resolves to the next queued result: the first call
// loads the doc's contracts, then one call per contract loads its provisions.
const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@workspace/db", () => ({ db: { execute: h.execute } }));
vi.mock("../../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { schoolYear, deriveStatedSettlements } from "./settlements";

function rows(...r: unknown[]) {
  return { rows: r };
}

beforeEach(() => {
  h.execute.mockReset();
});

describe("schoolYear", () => {
  it("maps an Aug start to that fall's school year", () => {
    expect(schoolYear("2022-08-15")).toBe("2022-23");
  });
  it("shifts a first-half end month back a year when isEnd", () => {
    expect(schoolYear("2025-06-30", true)).toBe("2024-25");
  });
  it("keeps a second-half end month in the same year when isEnd", () => {
    expect(schoolYear("2025-08-01", true)).toBe("2025-26");
  });
  it("returns null for empty/unparseable input", () => {
    expect(schoolYear(null)).toBeNull();
    expect(schoolYear("")).toBeNull();
  });
});

describe("deriveStatedSettlements", () => {
  it("derives one row per contract that has a yr1 provision", async () => {
    h.execute
      .mockResolvedValueOnce(
        rows({
          id: "11",
          districtId: "7",
          bargainingUnit: "teachers",
          effectiveStart: "2022-08-15",
          effectiveEnd: "2025-06-30",
          termYears: 3,
        }),
      )
      .mockResolvedValueOnce(
        rows(
          { key: "base_salary_increase_yr1", val: 3.5, conf: 0.9 },
          { key: "base_salary_increase_yr2", val: 3.0, conf: 0.9 },
          { key: "off_schedule_bonus_yr1", val: 500, conf: 0.8 },
        ),
      );

    const res = await deriveStatedSettlements(99);
    expect(res.settlements).toHaveLength(1);
    expect(res.settlements[0]).toMatchObject({
      districtId: "7",
      bargainingUnit: "teachers",
      fromYear: "2022-23",
      toYear: "2024-25",
      baseIncreasePct: 3.5,
      year2Pct: 3.0,
      offSchedulePayment: 500,
      contractId: "11",
    });
    expect(res.flaggedOutOfRange).toHaveLength(0);
  });

  it("skips a contract with no yr1 provision", async () => {
    h.execute
      .mockResolvedValueOnce(
        rows({
          id: "12",
          districtId: "7",
          bargainingUnit: "teachers",
          effectiveStart: "2022-08-15",
          effectiveEnd: null,
          termYears: null,
        }),
      )
      .mockResolvedValueOnce(rows());

    const res = await deriveStatedSettlements(99);
    expect(res.settlements).toHaveLength(0);
    expect(res.skipped["stated:no_yr1_provision"]).toBe(1);
  });

  it("flags an out-of-range base % instead of deriving bad data", async () => {
    h.execute
      .mockResolvedValueOnce(
        rows({
          id: "13",
          districtId: "7",
          bargainingUnit: "teachers",
          effectiveStart: "2022-08-15",
          effectiveEnd: null,
          termYears: null,
        }),
      )
      .mockResolvedValueOnce(
        rows({ key: "base_salary_increase_yr1", val: 4500, conf: 0.5 }),
      );

    const res = await deriveStatedSettlements(99);
    expect(res.settlements).toHaveLength(0);
    expect(res.flaggedOutOfRange).toEqual([{ contractId: "13", basePct: 4500 }]);
    expect(res.skipped["stated:base_pct_out_of_range"]).toBe(1);
  });
});
