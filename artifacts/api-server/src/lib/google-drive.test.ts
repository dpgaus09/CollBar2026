import { describe, it, expect, vi } from "vitest";
import { callWithRateLimitRetry, parseRetryAfterMs } from "./google-drive.js";

// ---------------------------------------------------------------------------
// Unit tests for the connector-proxy rate-limit retry (Task #228). The bug:
// a wide Drive folder scan bursts past the proxy's ~10 RPS-per-repl cap and the
// proxy returns HTTP 429, which previously aborted the whole preview/ingest.
// callWithRateLimitRetry now retries a transient 429 honoring Retry-After. The
// gate + sleep are injected so these assert behavior without real timers.
// ---------------------------------------------------------------------------

function resp(
  status: number,
  retryAfter?: string,
): { status: number; headers: { get(name: string): string | null }; text: () => Promise<string> } {
  return {
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "retry-after" && retryAfter != null ? retryAfter : null,
    },
    text: () => Promise.resolve(""),
  };
}

const noopGate = () => Promise.resolve();

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("1")).toBe(1000);
    expect(parseRetryAfterMs("30")).toBe(30000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const future = new Date(now + 5000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBe(5000);
    // A past date clamps to 0, never negative.
    const past = new Date(now - 5000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  it("returns null for missing/blank/garbage", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("   ")).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });
});

describe("callWithRateLimitRetry", () => {
  it("retries a 429 then returns the success, honoring Retry-After", async () => {
    const sleeps: number[] = [];
    const sleepFn = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const fn = vi
      .fn()
      .mockResolvedValueOnce(resp(429, "1"))
      .mockResolvedValueOnce(resp(200));

    const out = await callWithRateLimitRetry(fn, { gate: noopGate, sleepFn });

    expect(out.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]); // waited the Retry-After interval
  });

  it("falls back to exponential backoff when no Retry-After header", async () => {
    const sleeps: number[] = [];
    const sleepFn = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const fn = vi
      .fn()
      .mockResolvedValueOnce(resp(429))
      .mockResolvedValueOnce(resp(429))
      .mockResolvedValueOnce(resp(200));

    const out = await callWithRateLimitRetry(fn, { gate: noopGate, sleepFn });

    expect(out.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]); // 1000 * 2^attempt
  });

  it("gives up after maxRetries and returns the last 429", async () => {
    const fn = vi.fn().mockResolvedValue(resp(429, "1"));

    const out = await callWithRateLimitRetry(fn, {
      gate: noopGate,
      sleepFn: () => Promise.resolve(),
      maxRetries: 2,
    });

    expect(out.status).toBe(429);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("passes a non-429 response straight through without sleeping", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue(resp(500));

    const out = await callWithRateLimitRetry(fn, { gate: noopGate, sleepFn });

    expect(out.status).toBe(500);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("propagates a thrown error without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("not connected"));

    await expect(
      callWithRateLimitRetry(fn, { gate: noopGate, sleepFn: () => Promise.resolve() }),
    ).rejects.toThrow("not connected");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
