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
});
