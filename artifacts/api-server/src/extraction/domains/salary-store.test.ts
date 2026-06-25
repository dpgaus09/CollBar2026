import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtractionStatus } from "../types";

// Orchestration-level fail-closed test: a truncated/parse-failed salary
// extraction must NEVER reach storeSalaryForDoc, whose per-contract
// delete-then-insert (incl. zero rows) would wipe every existing salary schedule
// for the doc's contracts.
const h = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  dbTransaction: vi.fn(),
  loadSourceDoc: vi.fn(),
  resolvePdfBuffer: vi.fn(),
  extractSalarySchedules: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { execute: h.dbExecute, transaction: h.dbTransaction },
}));
vi.mock("../source-docs", () => ({
  loadSourceDoc: h.loadSourceDoc,
  resolvePdfBuffer: h.resolvePdfBuffer,
}));
vi.mock("./salary", () => ({
  extractSalarySchedules: h.extractSalarySchedules,
}));

import { runSalaryForDoc } from "./salary-store";

function extractionResult(status: ExtractionStatus, schedules: unknown[] = []) {
  return {
    schedules,
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

describe("runSalaryForDoc — fail-closed (never wipe rows on failed extraction)", () => {
  for (const status of ["truncated", "parse_error"] as const) {
    it(`skips the store entirely when extraction is ${status}`, async () => {
      h.extractSalarySchedules.mockResolvedValue(extractionResult(status));
      const res = await runSalaryForDoc("42", { dryRun: false });
      expect(res.status).toBe("extract_failed");
      expect(res.store).toBeUndefined();
      // fetchContractTargets uses db.execute; the per-contract delete-then-insert
      // uses db.transaction. Neither may run on a failed extraction.
      expect(h.dbExecute).not.toHaveBeenCalled();
      expect(h.dbTransaction).not.toHaveBeenCalled();
    });
  }

  it("DOES run the delete-then-insert store on a successful (even empty) extraction", async () => {
    h.extractSalarySchedules.mockResolvedValue(extractionResult("success", []));
    // One teacher contract on the doc; an empty (but successful) extraction must
    // still rewrite it so any stale/leaked schedules are cleared.
    h.dbExecute.mockResolvedValue({
      rows: [
        {
          contractId: "7",
          districtId: "3",
          sourceDocId: "42",
          bargainingUnit: "teachers",
          districtName: "Test District",
        },
      ],
    });
    const res = await runSalaryForDoc("42", { dryRun: false });
    expect(res.status).toBe("ok");
    expect(h.dbExecute).toHaveBeenCalled(); // fetched targets
    expect(h.dbTransaction).toHaveBeenCalledTimes(1); // delete-then-insert (clears stale)
  });
});
