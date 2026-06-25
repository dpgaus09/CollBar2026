import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtractionStatus } from "../types";

// Orchestration-level fail-closed test: a truncated/parse-failed extraction must
// NEVER reach storeProvisionsForDoc, whose per-contract delete-then-insert (incl.
// zero rows) would wipe every existing provision for the doc's contracts.
const h = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  dbTransaction: vi.fn(),
  loadSourceDoc: vi.fn(),
  resolvePdfBuffer: vi.fn(),
  extractProvisions: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { execute: h.dbExecute, transaction: h.dbTransaction },
}));
vi.mock("../source-docs", () => ({
  loadSourceDoc: h.loadSourceDoc,
  resolvePdfBuffer: h.resolvePdfBuffer,
}));
vi.mock("./provisions", () => ({
  extractProvisions: h.extractProvisions,
  dedupeProvisions: (x: unknown[]) => x,
}));
vi.mock("./provisions-verify", () => ({
  verifyProvisionsAgainstText: vi.fn(() => ({ checked: 0, mismatched: 0, capped: 0 })),
}));
vi.mock("../pdf/renderer", () => ({
  openPdf: vi.fn(async () => ({ destroy: vi.fn() })),
}));

import { runProvisionsForDoc } from "./provisions-store";

function extractionResult(status: ExtractionStatus, contracts: unknown[] = []) {
  return {
    contracts,
    ok: status === "success",
    status,
    fromCache: false,
    truncated: status === "truncated",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    modelVersion: "claude-test",
    pageCount: 1,
    pagesExtracted: [] as number[],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.loadSourceDoc.mockResolvedValue({ id: "42", fileHash: "a".repeat(64) });
  h.resolvePdfBuffer.mockResolvedValue(Buffer.from("%PDF-1.4 test"));
  h.dbExecute.mockResolvedValue({ rows: [] });
  h.dbTransaction.mockResolvedValue(0);
});

describe("runProvisionsForDoc — fail-closed (never wipe rows on failed extraction)", () => {
  for (const status of ["truncated", "parse_error"] as const) {
    it(`skips the store entirely when extraction is ${status}`, async () => {
      h.extractProvisions.mockResolvedValue(extractionResult(status));
      const res = await runProvisionsForDoc("42", { dryRun: false, verify: false });
      expect(res.status).toBe("extract_failed");
      expect(res.store).toBeUndefined();
      // fetchProvisionTargets uses db.execute; the per-contract delete-then-insert
      // uses db.transaction. Neither may run on a failed extraction.
      expect(h.dbExecute).not.toHaveBeenCalled();
      expect(h.dbTransaction).not.toHaveBeenCalled();
    });
  }

  it("DOES run the delete-then-insert store on a successful (even empty) extraction", async () => {
    h.extractProvisions.mockResolvedValue(extractionResult("success", []));
    h.dbExecute.mockResolvedValue({
      rows: [{ contractId: "7", bargainingUnit: "teachers" }],
    });
    const res = await runProvisionsForDoc("42", { dryRun: false, verify: false });
    expect(res.status).toBe("ok");
    expect(h.dbExecute).toHaveBeenCalled(); // fetched targets
    expect(h.dbTransaction).toHaveBeenCalledTimes(1); // delete-then-insert (clears stale)
  });
});
