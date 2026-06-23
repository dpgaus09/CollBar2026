import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Unit tests for the crawl-state rediscovery reader (lib/crawl-state.ts).
//
// fs is mocked so no real il_cba_crawl.json is needed: each test scripts the
// JSON the reader parses. existsSync always returns true so both the pipeline-
// dir probe and the state-file check pass, letting readFileSync drive the case.
// ---------------------------------------------------------------------------

const readFileSync = vi.fn<() => string>();

vi.mock("fs", () => ({
  existsSync: () => true,
  readFileSync: (...args: unknown[]) => readFileSync(...(args as [])),
}));

const { getRediscoveriesForDistrict, rediscoveryKey } = await import("./crawl-state.js");

function setState(state: unknown): void {
  readFileSync.mockReturnValue(JSON.stringify(state));
}

describe("rediscoveryKey", () => {
  it("joins unit and scope, defaulting scope to 'default'", () => {
    expect(rediscoveryKey("teachers", "certified")).toBe("teachers::certified");
    expect(rediscoveryKey("teachers", null)).toBe("teachers::default");
    expect(rediscoveryKey(null, null)).toBe("teachers::default");
  });
});

describe("getRediscoveriesForDistrict", () => {
  it("returns {} when rcdts is missing", () => {
    setState({ per_district: {} });
    expect(getRediscoveriesForDistrict(null)).toEqual({});
    expect(getRediscoveriesForDistrict("")).toEqual({});
  });

  it("returns {} when the district has no recheck records", () => {
    setState({ per_district: { "12345678901": { status: "found" } } });
    expect(getRediscoveriesForDistrict("12345678901")).toEqual({});
  });

  it("extracts only rediscovered_new_version outcomes, keyed by unit::scope", () => {
    setState({
      per_district: {
        "12345678901": {
          status: "found",
          recheck: {
            "teachers::default": {
              outcome: "rediscovered_new_version",
              unit_scope: null,
              effective_end_seen: "2025-06-30",
              checked_at: "2026-06-20T01:02:03Z",
            },
            "support::certified": {
              outcome: "unchanged",
              unit_scope: "certified",
              checked_at: "2026-06-20T01:02:04Z",
            },
          },
        },
      },
    });

    const out = getRediscoveriesForDistrict("12345678901");
    expect(Object.keys(out)).toEqual(["teachers::default"]);
    expect(out["teachers::default"]).toEqual({
      bargainingUnit: "teachers",
      unitScope: null,
      checkedAt: "2026-06-20T01:02:03Z",
      effectiveEndSeen: "2025-06-30",
    });
  });

  it("derives bargainingUnit from the key when present", () => {
    setState({
      per_district: {
        "999": {
          recheck: {
            "support::buildings": {
              outcome: "rediscovered_new_version",
              unit_scope: "buildings",
              checked_at: "2026-06-21T00:00:00Z",
            },
          },
        },
      },
    });
    const out = getRediscoveriesForDistrict("999");
    expect(out["support::buildings"].bargainingUnit).toBe("support");
    expect(out["support::buildings"].unitScope).toBe("buildings");
  });

  it("returns {} when the JSON is unparseable", () => {
    readFileSync.mockReturnValue("{ not json");
    expect(getRediscoveriesForDistrict("12345678901")).toEqual({});
  });
});
