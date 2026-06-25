import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExtractionStatus } from "../types";

// Orchestration-level fail-closed test: a truncated/parse-failed side must NEVER
// reach storeOfferItems (delete-then-insert), which would wipe that side's items.
// The comparison rebuild (a separate transaction) still runs and is harmless.
const h = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  dbTransaction: vi.fn(),
  loadSourceDoc: vi.fn(),
  resolvePdfBuffer: vi.fn(),
  extractFinalOffer: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { execute: h.dbExecute, transaction: h.dbTransaction },
}));
vi.mock("../source-docs", () => ({
  loadSourceDoc: h.loadSourceDoc,
  resolvePdfBuffer: h.resolvePdfBuffer,
}));
vi.mock("./final-offers", () => ({
  extractFinalOffer: h.extractFinalOffer,
}));

import { runFinalOffersForPosting } from "./final-offers-store";

function offerResult(status: ExtractionStatus, items: unknown[] = []) {
  return {
    items,
    ok: status === "success",
    status,
    fromCache: false,
    truncated: status === "truncated",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    modelVersion: "claude-test",
    pageCount: 1,
    pagesExtracted: 1,
  };
}

const POSTING = {
  id: "9",
  caseNumber: "S-MA-2026-001",
  districtSourceDocId: "100",
  unionSourceDocId: "200",
};

let execCalls = 0;

beforeEach(() => {
  vi.clearAllMocks();
  execCalls = 0;
  h.loadSourceDoc.mockResolvedValue({ id: "100", fileHash: "b".repeat(64) });
  h.resolvePdfBuffer.mockResolvedValue(Buffer.from("%PDF-1.4 test"));
  // 1st db.execute = loadPosting; subsequent = loadOfferItems (empty).
  h.dbExecute.mockImplementation(async () => {
    execCalls += 1;
    return execCalls === 1 ? { rows: [POSTING] } : { rows: [] };
  });
  // db.transaction runs its callback so storeOfferItems' DELETE/INSERT counts.
  h.dbTransaction.mockImplementation(
    async (cb: (tx: { execute: () => Promise<{ rows: unknown[] }> }) => unknown) =>
      cb({ execute: async () => ({ rows: [] }) }),
  );
});

describe("runFinalOffersForPosting — fail-closed (no item wipe on failed side)", () => {
  for (const status of ["truncated", "parse_error"] as const) {
    it(`does not replace either side's items when both extractions are ${status}`, async () => {
      h.extractFinalOffer.mockResolvedValue(offerResult(status));
      const res = await runFinalOffersForPosting("9", { dryRun: false });
      expect(res.status).toBe("ok");
      expect(res.sides?.map((s) => s.status)).toEqual(["extract_failed", "extract_failed"]);
      // The 2 item stores (district + union) must be skipped; only the single
      // comparison-rebuild transaction may run.
      expect(h.dbTransaction).toHaveBeenCalledTimes(1);
    });
  }

  it("replaces both sides' items on a successful extraction", async () => {
    h.extractFinalOffer.mockResolvedValue(
      offerResult("success", [
        {
          topic: "salary",
          topicLabel: null,
          summary: "3%",
          numericValue: 3,
          numericUnit: "percent",
          rawText: "3%",
        },
      ]),
    );
    const res = await runFinalOffersForPosting("9", { dryRun: false });
    expect(res.status).toBe("ok");
    expect(res.sides?.map((s) => s.status)).toEqual(["ok", "ok"]);
    // 2 item stores (district + union) + 1 comparison rebuild = 3 transactions.
    expect(h.dbTransaction).toHaveBeenCalledTimes(3);
  });
});
