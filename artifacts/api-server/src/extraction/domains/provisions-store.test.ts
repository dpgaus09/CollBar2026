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

import { runProvisionsForDoc, storeProvisionsForDoc } from "./provisions-store";
import type { ExtractedContract, ProvisionItem } from "../types";

function prov(
  category: ProvisionItem["category"],
  provisionKey: string,
  overrides: Partial<ProvisionItem> = {},
): ProvisionItem {
  return {
    category,
    provisionKey,
    valueNumeric: null,
    valueText: "x",
    unit: null,
    clauseExcerpt: null,
    pageRef: 1,
    confidence: 0.9,
    ...overrides,
  };
}

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

// A re-run/promote must never throw away manual review work. The store keeps
// human_verified rows, deletes only the unverified rows, and drops re-extracted
// provisions that collide (category + provision_key) with a verified row.
describe("storeProvisionsForDoc — preserves human_verified rows (Task #177)", () => {
  // The store issues exactly three statements per contract, in order:
  //   1) SELECT verified keys  2) DELETE unverified  3) INSERT new rows.
  // An INSERT is only issued when there is at least one row to insert.
  function fakeTx(verifiedRows: Array<{ category: string; provisionKey: string }>) {
    const calls: string[] = [];
    const tx = {
      execute: vi.fn(async () => {
        const step = calls.length;
        if (step === 0) {
          calls.push("select");
          return { rows: verifiedRows };
        }
        calls.push(step === 1 ? "delete" : "insert");
        return { rows: [] };
      }),
    };
    return { tx, calls };
  }

  it("keeps verified rows and skips re-extracted provisions that collide with them", async () => {
    h.dbExecute.mockResolvedValueOnce({
      rows: [{ contractId: "7", bargainingUnit: "teachers" }],
    });
    const { tx, calls } = fakeTx([
      { category: "compensation", provisionKey: "base_salary" },
    ]);
    h.dbTransaction.mockImplementation(
      async (cb: (t: typeof tx) => unknown) => cb(tx),
    );

    const contracts: ExtractedContract[] = [
      {
        bargainingUnit: "teachers",
        unitScope: null,
        provisions: [
          prov("compensation", "base_salary"), // collides with verified -> skipped
          prov("leave", "sick_days"), // new -> inserted
        ],
      },
    ];

    const res = await storeProvisionsForDoc("42", contracts, { dryRun: false });
    const r = res.results[0];
    expect(r.status).toBe("ok");
    expect(r.preserved).toBe(1); // base_salary kept
    expect(r.provisions).toBe(1); // only sick_days inserted
    // SELECT verified -> DELETE unverified -> INSERT new (collision dropped).
    expect(calls).toEqual(["select", "delete", "insert"]);
  });

  it("dry-run projects preserved/inserted without opening a transaction", async () => {
    h.dbExecute
      .mockResolvedValueOnce({
        rows: [{ contractId: "7", bargainingUnit: "teachers" }],
      }) // fetchProvisionTargets
      .mockResolvedValueOnce({
        rows: [{ category: "compensation", provisionKey: "base_salary" }],
      }); // verified-keys read

    const contracts: ExtractedContract[] = [
      {
        bargainingUnit: "teachers",
        unitScope: null,
        provisions: [
          prov("compensation", "base_salary"), // collides -> not counted as inserted
          prov("leave", "sick_days"),
        ],
      },
    ];

    const res = await storeProvisionsForDoc("42", contracts, { dryRun: true });
    expect(res.results[0].preserved).toBe(1);
    expect(res.results[0].provisions).toBe(1);
    expect(h.dbTransaction).not.toHaveBeenCalled();
  });
});
