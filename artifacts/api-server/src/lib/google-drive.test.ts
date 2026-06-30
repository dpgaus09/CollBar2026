import { describe, it, expect, vi } from "vitest";
import {
  callWithRateLimitRetry,
  parseRetryAfterMs,
  listFolderTree,
} from "./google-drive.js";

// ---------------------------------------------------------------------------
// listFolderTree fans out one connector-proxy "list children" call per folder.
// We mock the connector SDK so the crawl runs against an in-memory folder tree:
// root -> {A, B, one.pdf}; A -> {two.pdf, C}; B -> {three.pdf}; C -> {four.pdf}.
// That is 4 folders and 4 files across 3 levels, exercising the level-by-level
// crawl and the onProgress callback added for the background-scan change.
// ---------------------------------------------------------------------------
vi.mock("@replit/connectors-sdk", () => {
  const PDF = "application/pdf";
  const tree: Record<string, Array<Record<string, unknown>>> = {
    rootfolder0: [
      { id: "folderAAAA1", name: "A", mimeType: "application/vnd.google-apps.folder" },
      { id: "folderBBBB2", name: "B", mimeType: "application/vnd.google-apps.folder" },
      { id: "p1", name: "one.pdf", mimeType: PDF, size: "10", md5Checksum: "h1", modifiedTime: "2026-01-01T00:00:00Z" },
    ],
    folderAAAA1: [
      { id: "p2", name: "two.pdf", mimeType: PDF, size: "20", md5Checksum: "h2", modifiedTime: "2026-01-02T00:00:00Z" },
      { id: "folderCCCC3", name: "C", mimeType: "application/vnd.google-apps.folder" },
    ],
    folderBBBB2: [
      { id: "p3", name: "three.pdf", mimeType: PDF, size: "30", md5Checksum: "h3", modifiedTime: "2026-01-03T00:00:00Z" },
    ],
    folderCCCC3: [
      { id: "p4", name: "four.pdf", mimeType: PDF, size: "40", md5Checksum: "h4", modifiedTime: "2026-01-04T00:00:00Z" },
    ],
  };
  return {
    ReplitConnectors: class {
      // Mirrors the subset of the SDK proxy listFolderChildren relies on.
      async proxy(_name: string, path: string) {
        // The folder id is the first quoted token of the `q` parameter
        // (`'<id>' in parents and trashed=false`). URLSearchParams encodes
        // spaces as "+", so match the quoted token directly after decoding.
        const decoded = decodeURIComponent(path);
        const m = /'([^']+)'/.exec(decoded);
        const folderId = m ? m[1] : "";
        const files = tree[folderId] ?? [];
        const text = JSON.stringify({ files });
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: () => Promise.resolve(text),
        };
      }
    },
  };
});

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

describe("listFolderTree onProgress", () => {
  it("emits monotonic progress whose final filesFound equals the returned files", async () => {
    const events: Array<{
      foldersScanned: number;
      foldersKnown: number;
      filesFound: number;
      depth: number;
    }> = [];

    const tree = await listFolderTree("rootfolder0", (p) => events.push({ ...p }));

    // All 4 PDFs across the 3 levels are collected (no folders, no truncation).
    expect(tree.truncated).toBe(false);
    expect(tree.files.map((f) => f.name).sort()).toEqual([
      "four.pdf",
      "one.pdf",
      "three.pdf",
      "two.pdf",
    ]);
    // The nested file carries its ancestor folder names as parentPath.
    expect(tree.files.find((f) => f.name === "four.pdf")?.parentPath).toEqual(["A", "C"]);

    // Progress was actually reported and every counter is non-decreasing.
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].foldersScanned).toBeGreaterThanOrEqual(events[i - 1].foldersScanned);
      expect(events[i].foldersKnown).toBeGreaterThanOrEqual(events[i - 1].foldersKnown);
      expect(events[i].filesFound).toBeGreaterThanOrEqual(events[i - 1].filesFound);
    }

    // The crawl converges: every folder is scanned/known and the final
    // filesFound matches the number of files actually returned (no lost files).
    const last = events[events.length - 1];
    expect(last.foldersScanned).toBe(4);
    expect(last.foldersKnown).toBe(4);
    expect(last.filesFound).toBe(tree.files.length);
    expect(last.filesFound).toBe(4);
  });
});
