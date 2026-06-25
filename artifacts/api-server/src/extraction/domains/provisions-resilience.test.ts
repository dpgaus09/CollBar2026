import { describe, it, expect, beforeEach, vi } from "vitest";

// Resilience tests for extractProvisions on the DIGITAL (keyword-triage) path:
//   1. A single truncated/unparseable page must NOT discard the whole document —
//      it is skipped (recorded in pagesSkipped) while every other page is kept.
//   2. An empty tier-1 result escalates ONCE to a no-triage deep pass over all
//      pages, which recovers the provisions.
//   3. When triage locates zero candidate pages, the deep pass still runs.
const h = vi.hoisted(() => ({
  callVision: vi.fn(),
  // Mutable so each test can shape the doc's text layer (which pages carry
  // provision keywords) without redefining the module mock.
  state: { pageText: (_i: number) => "" as string, pageCount: 10 },
}));

vi.mock("../vision/client", () => ({
  callVision: h.callVision,
  DEFAULT_MODEL: "claude-test",
}));
vi.mock("../cache", () => ({
  requestHash: () => "req-hash",
  getCached: async () => null,
  putCached: async () => {},
}));
vi.mock("../cost", () => ({ costFromUsage: () => 0 }));
vi.mock("../pdf/renderer", () => ({
  RENDER_VERSION: "test",
  openPdf: async () => ({
    pageCount: h.state.pageCount,
    pageText: (i: number) => h.state.pageText(i),
    renderPage: () => ({ base64: "x", width: 1, height: 1 }),
    destroy: () => {},
  }),
}));

import { extractProvisions } from "./provisions";

// >= DIGITAL_DOC_MIN_CHARS total across pages keeps us on the FREE keyword-triage
// path (never the scanned-doc vision triage). Filler has no digit -> never a hit.
const FILLER =
  "the parties hereby mutually concur to honor every clause herein for the full duration as set forth above and below";
// Has a provision keyword (SALARY) AND a digit -> a keyword-triage hit.
const KEYWORD_PAGE =
  "ARTICLE VII SALARY the base salary shall increase by 3 percent in year one of this agreement period herein";

const VALID = JSON.stringify({
  contracts: [
    {
      bargaining_unit: "teachers",
      unit_scope: null,
      provisions: [
        {
          category: "leave",
          provision_key: "sick_days_annual",
          value_numeric: 12,
          value_text: null,
          unit: "days",
          clause_excerpt: "twelve sick days",
          page_ref: 1,
          confidence: 0.9,
        },
      ],
    },
  ],
});
const EMPTY = JSON.stringify({ contracts: [] });

function visionResp(over: Record<string, unknown> = {}) {
  return {
    text: "",
    truncated: false,
    usage: { inputTokens: 10, outputTokens: 5 },
    model: "claude-test",
    ...over,
  };
}

// 1-based PDF page numbers present in a callVision request's labelled blocks.
function pagesInCall(blocks: Array<{ type?: string; text?: string }>): number[] {
  const nums: number[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") {
      const m = b.text.match(/^=== PDF page (\d+) ===$/);
      if (m) nums.push(Number(m[1]));
    }
  }
  return nums;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.pageCount = 10;
  h.state.pageText = () => "";
});

describe("extractProvisions — per-page fail-closed resilience (digital path)", () => {
  it("skips one irreducible bad page instead of discarding the whole document", async () => {
    // Every page carries a provision keyword -> all 10 pages are candidates.
    h.state.pageText = () => KEYWORD_PAGE;
    // PDF page 3 always truncates (even alone); every other page extracts fine.
    h.callVision.mockImplementation(
      async ({ blocks }: { blocks: Array<{ type?: string; text?: string }> }) =>
        pagesInCall(blocks).includes(3)
          ? visionResp({ truncated: true, text: "" })
          : visionResp({ text: VALID }),
    );

    const res = await extractProvisions(Buffer.from("%PDF"), "f".repeat(64), {
      useCache: false,
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe("success");
    // The whole doc is NOT lost: provisions from the other pages survive.
    expect(res.contracts.length).toBeGreaterThan(0);
    expect(res.contracts[0].provisions.length).toBeGreaterThan(0);
    // Only the irreducible page 3 (0-based index 2) was dropped.
    expect(res.pagesSkipped).toEqual([2]);
    expect(res.deepRetried).toBe(false);
  });
});

describe("extractProvisions — completeness deep-retry", () => {
  it("escalates to a no-triage deep pass when tier-1 returns empty", async () => {
    // Only page 5 carries a keyword -> tier-1 triages a small subset (pages 4-6).
    h.state.pageText = (i: number) => (i === 4 ? KEYWORD_PAGE : FILLER);
    let n = 0;
    // First call is the tier-1 batch (empty); deep-pass calls recover provisions.
    h.callVision.mockImplementation(async () => {
      n += 1;
      return n === 1 ? visionResp({ text: EMPTY }) : visionResp({ text: VALID });
    });

    const res = await extractProvisions(Buffer.from("%PDF"), "f".repeat(64), {
      useCache: false,
    });

    expect(res.ok).toBe(true);
    expect(res.deepRetried).toBe(true);
    expect(res.contracts.length).toBeGreaterThan(0);
    expect(res.contracts[0].provisions.length).toBeGreaterThan(0);
    // Deep pass covered every page.
    expect(res.pagesExtracted).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("runs the deep pass even when triage locates zero candidate pages", async () => {
    // No page carries a keyword -> tier-1 finds nothing -> deep pass must run.
    h.state.pageText = () => FILLER;
    h.callVision.mockResolvedValue(visionResp({ text: VALID }));

    const res = await extractProvisions(Buffer.from("%PDF"), "f".repeat(64), {
      useCache: false,
    });

    expect(res.ok).toBe(true);
    expect(res.deepRetried).toBe(true);
    expect(res.contracts.length).toBeGreaterThan(0);
    expect(res.contracts[0].provisions.length).toBeGreaterThan(0);
  });
});
