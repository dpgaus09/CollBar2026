import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ContractMeta } from "./contract-meta";

// storeContractMetaForDoc reads targets via db.execute, then writes inside
// db.transaction (with a per-row SAVEPOINT via tx.transaction). Mock the db so the
// test is pure and we can assert the projection arithmetic + fail-safe behavior.
const h = vi.hoisted(() => ({ dbExecute: vi.fn(), dbTransaction: vi.fn() }));
vi.mock("@workspace/db", () => ({
  db: { execute: h.dbExecute, transaction: h.dbTransaction },
}));
vi.mock("../../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { storeContractMetaForDoc } from "./contract-meta-store";

const FULL: ContractMeta = {
  unionName: "Rock Island EA",
  affiliation: "IEA-NEA",
  effectiveStart: "2022-07-01",
  effectiveEnd: "2025-06-30",
  termYears: 3,
};
const EMPTY: ContractMeta = {
  unionName: null,
  affiliation: null,
  effectiveStart: null,
  effectiveEnd: null,
  termYears: null,
};

function target(id: string, unitScope: string | null) {
  return { id, districtId: "7", bargainingUnit: "teachers", unitScope };
}

// A fake outer tx whose nested .transaction (SAVEPOINT) succeeds by default.
function makeTx(opts?: { savepointThrows?: boolean; outerRowCount?: number }) {
  const tx2 = { execute: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
  const tx = {
    execute: vi
      .fn()
      .mockResolvedValue({ rows: [], rowCount: opts?.outerRowCount ?? 1 }),
    transaction: vi.fn(async (cb: (t: typeof tx2) => unknown) => {
      if (opts?.savepointThrows) throw new Error("duplicate key value");
      return cb(tx2);
    }),
  };
  return { tx, tx2 };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("storeContractMetaForDoc", () => {
  it("returns all-zero and never opens a transaction when the doc has no contracts", async () => {
    h.dbExecute.mockResolvedValueOnce({ rows: [] });
    const res = await storeContractMetaForDoc(99, FULL);
    expect(res).toEqual({ matched: 0, updated: 0, startApplied: 0, startSkipped: 0 });
    expect(h.dbTransaction).not.toHaveBeenCalled();
  });

  it("writes nothing (updated=0) when the extraction is all-null, leaving rows intact", async () => {
    h.dbExecute.mockResolvedValueOnce({ rows: [target("11", null)] });
    const res = await storeContractMetaForDoc(99, EMPTY);
    expect(res).toEqual({ matched: 1, updated: 0, startApplied: 0, startSkipped: 0 });
    expect(h.dbTransaction).not.toHaveBeenCalled();
  });

  it("COALESCE-updates every target row inside a SAVEPOINT (start applied)", async () => {
    h.dbExecute.mockResolvedValueOnce({
      rows: [target("11", null), target("12", null)],
    });
    const { tx, tx2 } = makeTx();
    h.dbTransaction.mockImplementation(async (cb: (t: typeof tx) => unknown) =>
      cb(tx),
    );

    const res = await storeContractMetaForDoc(99, FULL);
    expect(res).toEqual({ matched: 2, updated: 2, startApplied: 2, startSkipped: 0 });
    // Each row's full update (incl. effective_start) runs inside the savepoint.
    expect(tx.transaction).toHaveBeenCalledTimes(2);
    expect(tx2.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing effective_start and still writes the rest on a unique conflict", async () => {
    h.dbExecute.mockResolvedValueOnce({ rows: [target("11", "k12")] });
    const { tx } = makeTx({ savepointThrows: true, outerRowCount: 1 });
    h.dbTransaction.mockImplementation(async (cb: (t: typeof tx) => unknown) =>
      cb(tx),
    );

    const res = await storeContractMetaForDoc(99, FULL);
    expect(res).toEqual({ matched: 1, updated: 1, startApplied: 0, startSkipped: 1 });
    // The retry (without effective_start) runs on the OUTER tx.
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("dryRun projects without writing; flags start conflicts only for non-null unit_scope", async () => {
    h.dbExecute
      .mockResolvedValueOnce({ rows: [target("11", "k12"), target("12", null)] })
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }); // conflict for the k12 row
    const res = await storeContractMetaForDoc(99, FULL, { dryRun: true });
    expect(res).toEqual({ matched: 2, updated: 2, startApplied: 1, startSkipped: 1 });
    expect(h.dbTransaction).not.toHaveBeenCalled();
  });
});
