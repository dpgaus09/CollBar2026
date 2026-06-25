import { describe, it, expect, beforeEach, vi } from "vitest";

// Fail-closed test for the scanned-doc vision-triage path inside extractProvisions.
// A truncated/unparseable triage response must NOT degrade into an empty
// candidate set (which would later make storeProvisionsForDoc wipe existing
// rows); it must surface as a non-ok result so the orchestrator skips the store.
const h = vi.hoisted(() => ({ callVision: vi.fn() }));

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
    pageCount: 10, // > SMALL_DOC_PAGES so triage runs
    pageText: () => "", // no text layer -> scanned-doc vision triage path
    renderPage: () => ({ base64: "x", width: 1, height: 1 }),
    destroy: () => {},
  }),
}));

import { extractProvisions } from "./provisions";

function visionResp(over: Record<string, unknown> = {}) {
  return {
    text: "[1, 2, 3]",
    truncated: false,
    usage: { inputTokens: 10, outputTokens: 5 },
    model: "claude-test",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractProvisions — scanned-doc vision triage is fail-closed", () => {
  it("returns ok:false status=truncated when a triage batch is truncated", async () => {
    h.callVision.mockResolvedValue(visionResp({ truncated: true, text: "" }));
    const res = await extractProvisions(Buffer.from("%PDF"), "f".repeat(64), {
      useCache: false,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("truncated");
    expect(res.contracts).toEqual([]);
  });

  it("returns ok:false status=parse_error when triage output is unparseable", async () => {
    h.callVision.mockResolvedValue(visionResp({ text: "I cannot read these scans." }));
    const res = await extractProvisions(Buffer.from("%PDF"), "f".repeat(64), {
      useCache: false,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("parse_error");
    expect(res.contracts).toEqual([]);
  });

  it("succeeds (ok:true) when triage returns a valid page list", async () => {
    h.callVision.mockImplementation(async ({ maxTokens }: { maxTokens: number }) =>
      // triage call (4096 tokens) returns pages; extract call (12000) returns no contracts
      maxTokens <= 4096
        ? visionResp({ text: "[1, 2]" })
        : visionResp({ text: '{"contracts": []}' }),
    );
    const res = await extractProvisions(Buffer.from("%PDF"), "f".repeat(64), {
      useCache: false,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("success");
  });

  it("succeeds when triage wraps the page array in a code fence / prose", async () => {
    // Regression: the model commonly returns the array inside a markdown fence or
    // after a sentence despite "Return ONLY a JSON array". This must parse, not
    // fail-closed (the old object-wrapping parser threw ParseError here).
    h.callVision.mockImplementation(async ({ maxTokens }: { maxTokens: number }) =>
      maxTokens <= 4096
        ? visionResp({ text: "Here are the pages:\n```json\n[1, 2, 3]\n```" })
        : visionResp({ text: '{"contracts": []}' }),
    );
    const res = await extractProvisions(Buffer.from("%PDF"), "f".repeat(64), {
      useCache: false,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe("success");
  });
});
