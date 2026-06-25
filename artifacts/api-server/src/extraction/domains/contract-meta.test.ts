import { describe, it, expect, beforeEach, vi } from "vitest";

// extractContractMeta talks to the renderer, the vision client, and the cache.
// Mock those so the test is hermetic; keep ../vision/parse REAL so we exercise the
// actual JSON extraction + fail-closed classification.
const h = vi.hoisted(() => ({
  callVision: vi.fn(),
  getCached: vi.fn(),
  putCached: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("../pdf/renderer", () => ({
  RENDER_VERSION: "test-render",
  openPdf: vi.fn(async () => ({
    pageCount: 4,
    renderPage: () => ({ base64: "ZmFrZQ==" }),
    destroy: h.destroy,
  })),
}));
vi.mock("../vision/client", () => ({
  DEFAULT_MODEL: "claude-test",
  callVision: h.callVision,
}));
vi.mock("../cache", () => ({
  requestHash: () => "req-hash",
  getCached: h.getCached,
  putCached: h.putCached,
}));
vi.mock("../cost", () => ({ costFromUsage: () => 0 }));
vi.mock("../../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  normalizeContractMeta,
  extractContractMeta,
  EMPTY_CONTRACT_META,
} from "./contract-meta";

const FILE_HASH = "a".repeat(64);

function visionResult(text: string, truncated = false) {
  return {
    text,
    model: "claude-test",
    stopReason: truncated ? "max_tokens" : "end_turn",
    truncated,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getCached.mockResolvedValue(null);
  h.putCached.mockResolvedValue(undefined);
});

describe("normalizeContractMeta", () => {
  it("maps snake_case fields to the ContractMeta shape", () => {
    const m = normalizeContractMeta({
      union_name: "  Rock Island Education Association ",
      affiliation: "IEA-NEA",
      effective_start: "2022-07-01",
      effective_end: "2025-06-30",
      term_years: 3,
    });
    expect(m).toEqual({
      unionName: "Rock Island Education Association",
      affiliation: "IEA-NEA",
      effectiveStart: "2022-07-01",
      effectiveEnd: "2025-06-30",
      termYears: 3,
    });
  });

  it("nulls malformed dates and blank strings", () => {
    const m = normalizeContractMeta({
      union_name: "   ",
      affiliation: 42,
      effective_start: "2022-7-1",
      effective_end: "July 1 2025",
      term_years: null,
    });
    expect(m).toEqual(EMPTY_CONTRACT_META);
  });

  it("drops both dates when start is after end (incoherent term)", () => {
    const m = normalizeContractMeta({
      effective_start: "2026-01-01",
      effective_end: "2022-01-01",
    });
    expect(m.effectiveStart).toBeNull();
    expect(m.effectiveEnd).toBeNull();
    expect(m.termYears).toBeNull();
  });

  it("derives term_years from a clean date span when omitted", () => {
    expect(
      normalizeContractMeta({
        effective_start: "2021-07-01",
        effective_end: "2024-06-30",
      }).termYears,
    ).toBe(3);
  });

  it("does NOT derive term_years from a span that does not round cleanly", () => {
    expect(
      normalizeContractMeta({
        effective_start: "2022-01-01",
        effective_end: "2024-06-01",
      }).termYears,
    ).toBeNull();
  });

  it("prefers a stated term_years (incl. numeric strings) and rejects out-of-range", () => {
    expect(normalizeContractMeta({ term_years: "4" }).termYears).toBe(4);
    expect(normalizeContractMeta({ term_years: 25 }).termYears).toBeNull();
    expect(normalizeContractMeta({ term_years: 0 }).termYears).toBeNull();
  });
});

describe("extractContractMeta", () => {
  it("returns normalized metadata and caches a successful extraction", async () => {
    h.callVision.mockResolvedValue(
      visionResult(
        '{"union_name":"Rock Island Education Association","affiliation":"IEA-NEA","effective_start":"2022-07-01","effective_end":"2025-06-30","term_years":3}',
      ),
    );
    const res = await extractContractMeta(Buffer.from("%PDF-1.4"), FILE_HASH);
    expect(res.ok).toBe(true);
    expect(res.status).toBe("success");
    expect(res.fromCache).toBe(false);
    expect(res.meta.unionName).toBe("Rock Island Education Association");
    expect(res.meta.effectiveEnd).toBe("2025-06-30");
    expect(res.meta.termYears).toBe(3);
    expect(h.putCached).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it("is a legitimate all-null result when the model finds nothing (still cached)", async () => {
    h.callVision.mockResolvedValue(
      visionResult(
        '{"union_name":null,"affiliation":null,"effective_start":null,"effective_end":null,"term_years":null}',
      ),
    );
    const res = await extractContractMeta(Buffer.from("%PDF-1.4"), FILE_HASH);
    expect(res.ok).toBe(true);
    expect(res.meta).toEqual(EMPTY_CONTRACT_META);
    expect(h.putCached).toHaveBeenCalledTimes(1);
  });

  it("fail-closed on a truncated response: empty meta, never cached", async () => {
    h.callVision.mockResolvedValue(visionResult('{"union_name":"X"', true));
    const res = await extractContractMeta(Buffer.from("%PDF-1.4"), FILE_HASH);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("truncated");
    expect(res.meta).toEqual(EMPTY_CONTRACT_META);
    expect(h.putCached).not.toHaveBeenCalled();
  });

  it("fail-closed on an unparseable response: empty meta, never cached", async () => {
    h.callVision.mockResolvedValue(
      visionResult("I could not find this information."),
    );
    const res = await extractContractMeta(Buffer.from("%PDF-1.4"), FILE_HASH);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("parse_error");
    expect(res.meta).toEqual(EMPTY_CONTRACT_META);
    expect(h.putCached).not.toHaveBeenCalled();
  });

  it("serves a cache hit without calling vision", async () => {
    h.getCached.mockResolvedValue({
      normalized: {
        unionName: "Cached EA",
        affiliation: null,
        effectiveStart: null,
        effectiveEnd: null,
        termYears: null,
      },
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0,
      modelVersion: "claude-cached",
    });
    const res = await extractContractMeta(Buffer.from("%PDF-1.4"), FILE_HASH);
    expect(res.fromCache).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.meta.unionName).toBe("Cached EA");
    expect(h.callVision).not.toHaveBeenCalled();
  });
});
