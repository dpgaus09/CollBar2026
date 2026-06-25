import { describe, it, expect, vi } from "vitest";

// versions.ts imports the live store fns + db at module load; stub them so we can
// unit-test the pure hashing helpers without a DB connection.
vi.mock("@workspace/db", () => ({ db: { execute: vi.fn(), transaction: vi.fn() } }));
vi.mock("../domains/salary-store", () => ({ storeSalaryForDoc: vi.fn() }));
vi.mock("../domains/provisions-store", () => ({ storeProvisionsForDoc: vi.fn() }));

import { canonicalJson, resultHash } from "./versions";

describe("canonicalJson / resultHash — stable, order-independent identity", () => {
  it("orders object keys deterministically regardless of insertion order", () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(resultHash(a)).toBe(resultHash(b));
  });

  it("preserves array order (arrays are meaningful sequences)", () => {
    expect(resultHash({ xs: [1, 2, 3] })).not.toBe(resultHash({ xs: [3, 2, 1] }));
  });

  it("produces a different hash when a value actually changes", () => {
    expect(resultHash({ amount: 100 })).not.toBe(resultHash({ amount: 101 }));
  });

  it("is a 64-char sha256 hex digest", () => {
    expect(resultHash({ any: "thing" })).toMatch(/^[0-9a-f]{64}$/);
  });
});
