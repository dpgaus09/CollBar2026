import { describe, it, expect } from "vitest";
import { classifyBatchResponse } from "./parse";

// The fail-closed gate hinges on this pure function correctly distinguishing a
// VALID-EMPTY result (a real success that legitimately replaces stored rows)
// from a TRUNCATED or PARSE-FAILURE response (which must NOT be stored/cached).
describe("classifyBatchResponse (fail-closed batch interpretation)", () => {
  it("fails closed on truncation regardless of body", () => {
    const r = classifyBatchResponse('{"items":[{"topic":"salary"}]}', true, "items");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("truncated");
  });

  it("flags non-JSON / empty / fence-only text as parse_error", () => {
    for (const t of ["", "   ", "I could not read these pages.", "```", "not json"]) {
      const r = classifyBatchResponse(t, false, "items");
      expect(r.ok, JSON.stringify(t)).toBe(false);
      if (!r.ok) expect(r.reason).toBe("parse_error");
    }
  });

  it("treats a valid object with an empty array as a SUCCESSFUL empty result", () => {
    expect(classifyBatchResponse('{"items": []}', false, "items")).toEqual({
      ok: true,
      items: [],
    });
  });

  it("treats a valid object MISSING the key as success-empty (schema default)", () => {
    expect(classifyBatchResponse('{"note":"none found"}', false, "contracts")).toEqual({
      ok: true,
      items: [],
    });
  });

  it("coerces a non-array value under the key to empty (never crashes)", () => {
    expect(classifyBatchResponse('{"items": "oops"}', false, "items")).toEqual({
      ok: true,
      items: [],
    });
  });

  it("returns the array when present, ignoring surrounding prose/fences", () => {
    const r = classifyBatchResponse(
      'here:\n```json\n{"items":[{"topic":"salary"},{"topic":"leave"}]}\n```',
      false,
      "items",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toHaveLength(2);
  });
});
