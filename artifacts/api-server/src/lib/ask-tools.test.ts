import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// The tools are the ONLY way the assistant reads data, and every query MUST be
// anchored to the customer-facing state (Illinois) so out-of-state rows (e.g.
// Ohio) can never leak. These tests run no live LLM and no real database: the
// db client is mocked so we can capture and inspect the SQL each tool builds.

const execute = vi.fn(async (_query?: unknown) => ({
  rows: [] as Record<string, unknown>[],
}));

vi.mock("@workspace/db", () => ({
  db: { execute },
}));

// Imported after the mock is registered.
const { executeAskTool, ASK_TOOL_DEFS, ASK_TOOL_NAMES } = await import(
  "./ask-tools.js"
);
const { CUSTOMER_STATE } = await import("./dashboard-query.js");

const dialect = new PgDialect();

function capturedQueries(): Array<{ text: string; params: unknown[] }> {
  return execute.mock.calls.map((call) => {
    const query = dialect.sqlToQuery(call[0] as unknown as SQL);
    return { text: query.sql, params: query.params };
  });
}

function expectEveryQueryAnchoredToIL(): void {
  const queries = capturedQueries();
  expect(queries.length).toBeGreaterThan(0);
  for (const q of queries) {
    // The state filter is parameterised: `d.state = $n` with the value bound
    // separately. Assert both the column reference and the bound IL value.
    expect(q.text.toLowerCase()).toContain(".state =");
    expect(q.params).toContain(CUSTOMER_STATE);
  }
}

beforeEach(() => {
  execute.mockClear();
  execute.mockResolvedValue({ rows: [] });
});

describe("ask-tools state scoping", () => {
  it("CUSTOMER_STATE is Illinois", () => {
    expect(CUSTOMER_STATE).toBe("IL");
  });

  it("search_districts (plain) anchors every query to IL", async () => {
    await executeAskTool("search_districts", { query: "Columbus", county: "Franklin" });
    expectEveryQueryAnchoredToIL();
  });

  it("search_districts (contract-expiry path) anchors every query to IL", async () => {
    await executeAskTool("search_districts", { contract_expires_year: 2026 });
    expectEveryQueryAnchoredToIL();
  });

  it("search_settlements anchors every query to IL", async () => {
    await executeAskTool("search_settlements", {
      district_name: "Columbus",
      min_base_pct: 4,
      start_year_min: 2023,
    });
    expectEveryQueryAnchoredToIL();
  });

  it("search_provisions anchors every query to IL", async () => {
    await executeAskTool("search_provisions", {
      keyword: "TRS pickup",
      category: "retirement",
    });
    expectEveryQueryAnchoredToIL();
  });

  it("get_comparables anchors EVERY query to IL (aggregate + district list)", async () => {
    await executeAskTool("get_comparables", { county: "Cook", band: "large" });
    // get_comparables issues two queries; both must be IL-scoped.
    expect(execute.mock.calls.length).toBe(2);
    expectEveryQueryAnchoredToIL();
  });

  it("search_factfinding anchors every query to IL", async () => {
    await executeAskTool("search_factfinding", { district_name: "Columbus" });
    expectEveryQueryAnchoredToIL();
  });

  it("every registered tool, run with empty input, anchors its query to IL", async () => {
    for (const def of ASK_TOOL_DEFS) {
      execute.mockClear();
      execute.mockResolvedValue({ rows: [] });
      await executeAskTool(def.name, {});
      expectEveryQueryAnchoredToIL();
    }
  });

  it("ASK_TOOL_NAMES matches the defined tools", () => {
    expect([...ASK_TOOL_NAMES].sort()).toEqual(
      ASK_TOOL_DEFS.map((d) => d.name).sort(),
    );
  });
});

describe("ask-tools result cards (grounded, IL rows only)", () => {
  it("builds district result cards with deep links from returned rows", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          id: 42,
          name: "Springfield SD 186",
          county: "Sangamon",
          district_type: "Unit",
          enrollment: 14000,
        },
      ],
    });
    const out = await executeAskTool("search_districts", { query: "Springfield" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      type: "district",
      id: 42,
      path: "/dashboard/42",
    });
  });

  it("returns zero result cards when no IL rows match (out-of-state target)", async () => {
    // An Ohio-targeted lookup matches nothing because the SQL is IL-scoped.
    execute.mockResolvedValue({ rows: [] });
    const out = await executeAskTool("search_districts", { query: "Columbus City Ohio" });
    expect(out.results).toEqual([]);
  });

  it("search_final_offers groups topic rows into one case card per posting", async () => {
    // Two topic rows for the same ELRB case → a single grounded card that
    // deep-links to the district's final-offers page and counts diff/aligned.
    execute.mockResolvedValueOnce({
      rows: [
        {
          posting_id: 7,
          case_number: "2026-IM-0007-C",
          year: 2026,
          bargaining_unit: "teachers",
          union_name: "RFT Local 6",
          posted_date: null,
          district_id: 99,
          district_name: "Rockford SD 205",
          county: "Winnebago",
          topic: "salary",
          topic_label: "Salary / Wages",
          status: "diff",
          numeric_gap: "1.0",
          gap_unit: "percent",
          district_summary: "Board: 6%",
          union_summary: "Union: 7%",
        },
        {
          posting_id: 7,
          case_number: "2026-IM-0007-C",
          year: 2026,
          bargaining_unit: "teachers",
          union_name: "RFT Local 6",
          posted_date: null,
          district_id: 99,
          district_name: "Rockford SD 205",
          county: "Winnebago",
          topic: "insurance",
          topic_label: "Insurance",
          status: "aligned",
          numeric_gap: null,
          gap_unit: null,
          district_summary: "PPO 80/20",
          union_summary: "PPO 80/20",
        },
      ],
    });
    const out = await executeAskTool("search_final_offers", { district_name: "Rockford" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      type: "final_offer",
      id: 99,
      path: "/dashboard/99/final-offers",
    });
    expect((out.data as { diff_count: number; aligned_count: number }[])[0]).toMatchObject({
      diff_count: 1,
      aligned_count: 1,
    });
  });

  it("search_final_offers anchors its query to IL (no out-of-state leak)", async () => {
    await executeAskTool("search_final_offers", { topic: "salary", diffs_only: true });
    expectEveryQueryAnchoredToIL();
  });

  it("search_final_offers returns no cards for an out-of-state target", async () => {
    // The SQL is IL-scoped, so an Ohio-targeted lookup matches nothing.
    execute.mockResolvedValue({ rows: [] });
    const out = await executeAskTool("search_final_offers", { district_name: "Columbus City Ohio" });
    expect(out.results).toEqual([]);
  });
});

describe("get_salary_schedule (salary grids, IL rows only)", () => {
  // Phase 1 returns the matched district + its latest contract; Phase 2 returns
  // that contract's schedules and cells. Wiring the three calls in order lets us
  // exercise the full grouping/summary path.
  function mockSalaryQueries(): void {
    execute
      .mockResolvedValueOnce({
        rows: [
          { district_id: 42, district_name: "Naperville CUSD 203", county: "DuPage", contract_id: 7 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 100,
            contract_id: 7,
            schedule_name: "Teachers",
            school_year: "2025-26",
            start_year: 2025,
            lane_labels: ["BA", "MA"],
            step_count: 2,
            lane_count: 2,
            min_salary: 50000,
            max_salary: 90000,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { schedule_id: 100, step_label: "1", step_order: 0, lane_label: "BA", lane_order: 0, salary_amount: 50000 },
          { schedule_id: 100, step_label: "1", step_order: 0, lane_label: "MA", lane_order: 1, salary_amount: 55000 },
          { schedule_id: 100, step_label: "2", step_order: 1, lane_label: "BA", lane_order: 0, salary_amount: 52000 },
          { schedule_id: 100, step_label: "2", step_order: 1, lane_label: "MA", lane_order: 1, salary_amount: 57000 },
        ],
      });
  }

  it("anchors EVERY query (district lookup + schedules + cells) to IL", async () => {
    mockSalaryQueries();
    await executeAskTool("get_salary_schedule", { district_name: "Naperville", step: 1, lane: "MA" });
    expect(execute.mock.calls.length).toBe(3);
    expectEveryQueryAnchoredToIL();
  });

  it("excludes implausible-magnitude grids from every query", async () => {
    mockSalaryQueries();
    await executeAskTool("get_salary_schedule", { district_name: "Naperville" });
    for (const q of capturedQueries()) {
      expect(q.text.toLowerCase()).toContain("not like");
      expect(q.params).toContain("%implausible_salary_magnitude%");
    }
  });

  it("scopes EVERY query (district lookup + schedules + cells) to the requested unit", async () => {
    mockSalaryQueries();
    await executeAskTool("get_salary_schedule", { district_name: "Naperville", bargaining_unit: "teachers" });
    for (const q of capturedQueries()) {
      expect(q.text.toLowerCase()).toContain("c.bargaining_unit");
      expect(q.params).toContain("teachers");
    }
  });

  it("builds a grounded salary card with anchor figures and a district deep link", async () => {
    mockSalaryQueries();
    const out = await executeAskTool("get_salary_schedule", { district_name: "Naperville" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      type: "salary",
      id: 42,
      path: "/dashboard/42",
    });
    expect((out.data as Record<string, unknown>[])[0]).toMatchObject({
      district_id: 42,
      bargaining_unit: "teachers",
      job_family: "Teachers",
      school_year: "2025-26",
      base_salary: 50000,
      ma_base_salary: 55000,
      max_salary: 90000,
    });
  });

  it("returns the requested cell for a specific step + lane lookup", async () => {
    mockSalaryQueries();
    const out = await executeAskTool("get_salary_schedule", {
      district_name: "Naperville",
      step: 1,
      lane: "MA",
    });
    const row = (out.data as Record<string, unknown>[])[0];
    expect(row.matched_cells).toEqual([{ step: "1", lane: "MA", salary: 55000 }]);
  });

  it("carries the non-default unit in the deep link (?unit=)", async () => {
    execute
      .mockResolvedValueOnce({
        rows: [{ district_id: 9, district_name: "Some CUSD", county: "Cook", contract_id: 3 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 200,
            contract_id: 3,
            schedule_name: "Custodians",
            school_year: "2024-25",
            start_year: 2024,
            lane_labels: null,
            step_count: 1,
            lane_count: 1,
            min_salary: 30000,
            max_salary: 40000,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { schedule_id: 200, step_label: "1", step_order: 0, lane_label: null, lane_order: 0, salary_amount: 30000 },
        ],
      });
    const out = await executeAskTool("get_salary_schedule", {
      district_name: "Some",
      bargaining_unit: "support_staff",
    });
    expect(out.results[0]).toMatchObject({ type: "salary", id: 9, path: "/dashboard/9?unit=support_staff" });
  });

  it("returns no cards for an out-of-state target (IL-scoped)", async () => {
    execute.mockResolvedValue({ rows: [] });
    const out = await executeAskTool("get_salary_schedule", { district_name: "Columbus City Ohio" });
    expect(out.results).toEqual([]);
    expect(out.data).toEqual([]);
  });
});

describe("get_baseline_benefits (ISBE TSS baseline, IL rows only)", () => {
  it("anchors its query to IL", async () => {
    await executeAskTool("get_baseline_benefits", { district_name: "Naperville", school_year: "2024-25" });
    expectEveryQueryAnchoredToIL();
  });

  it("builds a grounded district card with baseline figures grouped", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          district_id: 42,
          district_name: "Naperville CUSD 203",
          county: "DuPage",
          district_type: "Unit",
          enrollment: 16000,
          school_year: "2024-25",
          affiliation: "IEA",
          enrollment_range: "10000+",
          contract_expires: "2026-08-15",
          ba_begin: 48000,
          ba_max: 70000,
          ba_years_to_max: 12,
          trs_board_paid_pct: 9.0,
          health_premium_employee: 750,
          health_pct_employer_employee: 80,
          sick_days: 13,
          personal_days: 3,
          sick_leave_bank: "Yes",
        },
      ],
    });
    const out = await executeAskTool("get_baseline_benefits", { district_name: "Naperville" });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ type: "district", id: 42, path: "/dashboard/42" });
    const row = (out.data as Record<string, unknown>[])[0];
    expect(row).toMatchObject({ district_id: 42, school_year: "2024-25" });
    expect((row.salary_schedule as Record<string, unknown>).ba_begin).toBe(48000);
    expect((row.retirement as Record<string, unknown>).trs_board_paid_pct).toBe(9);
    expect(((row.insurance as Record<string, Record<string, unknown>>).health).premium_employee).toBe(750);
  });

  it("returns no cards for an out-of-state target (IL-scoped)", async () => {
    execute.mockResolvedValue({ rows: [] });
    const out = await executeAskTool("get_baseline_benefits", { district_name: "Columbus City Ohio" });
    expect(out.results).toEqual([]);
  });
});

describe("get_eis_salary_stats (ISBE EIS actual pay, aggregate only)", () => {
  it("anchors its district-level query to IL (no position breakdown)", async () => {
    await executeAskTool("get_eis_salary_stats", { district_name: "Springfield" });
    // Only the district-level query runs when no position filter is given.
    expect(execute.mock.calls.length).toBe(1);
    expectEveryQueryAnchoredToIL();
  });

  it("builds a grounded district card from EIS stats", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          district_id: 7,
          district_name: "Springfield SD 186",
          county: "Sangamon",
          district_type: "Unit",
          enrollment: 14000,
          school_year: "2023-24",
          teacher_headcount: 900,
          teacher_fte: 880.5,
          avg_teacher_salary: 62000,
          median_teacher_salary: 60000,
          p25_salary: 48000,
          p75_salary: 75000,
          total_teacher_base_payroll: 54000000,
          avg_sick_days: 12,
        },
      ],
    });
    const out = await executeAskTool("get_eis_salary_stats", { district_name: "Springfield" });
    expect(out.results[0]).toMatchObject({ type: "district", id: 7, path: "/dashboard/7" });
    const districts = (out.data as { districts: Record<string, unknown>[] }).districts;
    expect(districts[0]).toMatchObject({ district_id: 7, avg_teacher_salary: 62000, median_teacher_salary: 60000 });
  });

  it("runs a per-position breakdown (2 queries) and anchors both to IL", async () => {
    execute
      .mockResolvedValueOnce({
        rows: [
          {
            district_id: 7,
            district_name: "Springfield SD 186",
            county: "Sangamon",
            district_type: "Unit",
            enrollment: 14000,
            school_year: "2023-24",
            teacher_headcount: 900,
            avg_teacher_salary: 62000,
            median_teacher_salary: 60000,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { district_id: 7, district_name: "Springfield SD 186", county: "Sangamon", school_year: "2023-24", position_description: "Principal", position_group: "administrator", headcount: 12, avg_salary: 110000, median_salary: 108000 },
          { district_id: 7, district_name: "Springfield SD 186", county: "Sangamon", school_year: "2023-24", position_description: "Assistant Principal", position_group: "administrator", headcount: 20, avg_salary: 95000, median_salary: 94000 },
        ],
      });
    const out = await executeAskTool("get_eis_salary_stats", { district_name: "Springfield", position_group: "administrator" });
    expect(execute.mock.calls.length).toBe(2);
    expectEveryQueryAnchoredToIL();
    const positions = (out.data as { positions: Record<string, unknown>[] }).positions;
    // Sorted by headcount desc.
    expect(positions.map((p) => p.position_description)).toEqual(["Assistant Principal", "Principal"]);
  });
});

describe("compare_to_peers (focal vs peer group, IL-scoped)", () => {
  function mockCompareQueries(): void {
    execute
      .mockResolvedValueOnce({
        rows: [
          { district_id: 42, district_name: "Naperville CUSD 203", county: "DuPage", district_type: "Unit", enrollment: 16000, focal_value: 68000 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ median: 60000, avg: 61000, min: 50000, max: 72000, n: 9 }],
      });
  }

  it("anchors BOTH queries (focal + peer aggregate) to IL", async () => {
    mockCompareQueries();
    await executeAskTool("compare_to_peers", { district_name: "Naperville", metric: "avg_teacher_salary" });
    expect(execute.mock.calls.length).toBe(2);
    expectEveryQueryAnchoredToIL();
  });

  it("returns focal value alongside peer median/avg and a comparables card", async () => {
    mockCompareQueries();
    const out = await executeAskTool("compare_to_peers", { district_name: "Naperville", metric: "avg_teacher_salary" });
    expect(out.data).toMatchObject({
      district_id: 42,
      metric: "avg_teacher_salary",
      district_value: 68000,
      peer_median: 60000,
      peer_avg: 61000,
      peer_count: 9,
    });
    expect(out.results[0]).toMatchObject({ type: "comparables", id: 42 });
    expect(out.results[0].path.startsWith("/dashboard/42/comparables")).toBe(true);
  });

  it("defaults the peer county to the focal district's county when none given", async () => {
    mockCompareQueries();
    const out = await executeAskTool("compare_to_peers", { district_name: "Naperville", metric: "trs_board_paid_pct" });
    const data = out.data as { peer_filters: { county: string | null } };
    expect(data.peer_filters.county).toBe("DuPage");
  });

  it("falls back to the default metric for an unknown metric and stays IL-anchored", async () => {
    mockCompareQueries();
    const out = await executeAskTool("compare_to_peers", { district_name: "Naperville", metric: "not_a_metric" });
    // The unknown key resolves to avg_teacher_salary and the returned data
    // advertises the RESOLVED metric, never the unsupported user text.
    expect((out.data as { metric: string }).metric).toBe("avg_teacher_salary");
    expectEveryQueryAnchoredToIL();
  });

  it("returns no card when the focal district is not found", async () => {
    execute.mockResolvedValue({ rows: [] });
    const out = await executeAskTool("compare_to_peers", { district_name: "Columbus City Ohio" });
    expect(out.results).toEqual([]);
    // Only the focal lookup ran; it is IL-anchored.
    expect(execute.mock.calls.length).toBe(1);
    expectEveryQueryAnchoredToIL();
  });
});
