import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for the Bulk CBA Import folder-scan background job. The
// preview used to be one synchronous request; a very large Drive tree could
// exceed the deployment's ~300s request cap and time out. It now runs as an
// in-process background job: POST /admin/bulk-cba/preview/start returns a
// scanId, and GET /admin/bulk-cba/preview/status is polled until the crawl
// finishes and returns the same { httpStatus, body } payload the old route did.
//
// We mock the Drive layer (listFolderTree + the manifest download) so the scan
// runs against an in-memory folder/manifest, and we assert the finished body is
// exactly what matchEntries/bulkReadManifest produce. District matching uses
// the REAL database (loadDistrictLookups), so we seed one throwaway district.
// ---------------------------------------------------------------------------

vi.mock("../lib/google-drive.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/google-drive.js")>();
  return {
    ...actual,
    listFolderTree: vi.fn(),
    downloadDriveFile: vi.fn(),
    exportGoogleSheetCsv: vi.fn(),
  };
});

const { listFolderTree, downloadDriveFile, DriveNotConnectedError } = await import(
  "../lib/google-drive.js"
);
const { matchEntries, mapManifestColumns, isPdfFile } = await import("../lib/bulk-cba.js");
type DriveFile = import("../lib/google-drive.js").DriveFile;
const adminRouter = (await import("./admin.js")).default;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { adminAuthenticated: boolean } }).session = {
      adminAuthenticated: true,
    };
    next();
  });
  app.use("/", adminRouter);
  return app;
}

const app = buildApp();

const MARK = `tstbcp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// 9-digit RCDTS prefix in the (nonexistent) region "99" so it can never collide
// with a real IL district's state_district_id.
const SID9 = `99${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const DISTRICT_NAME = `Test District ${MARK}`;
const FOLDER_ID = "previewfolderid01"; // matches the Drive id shape

let districtId: number;

beforeAll(async () => {
  const r = await db.execute(sql`
    INSERT INTO districts (state, state_district_id, name, slug)
    VALUES ('IL', ${SID9}, ${DISTRICT_NAME}, ${MARK})
    RETURNING id
  `);
  districtId = Number((r.rows[0] as { id: string | number }).id);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM districts WHERE id = ${districtId}`);
  await pool.end();
});

function file(p: Partial<DriveFile> & { name: string }): DriveFile {
  return {
    id: p.id ?? `id-${p.name}`,
    name: p.name,
    mimeType: p.mimeType ?? "application/pdf",
    size: p.size ?? 1234,
    md5Checksum: p.md5Checksum ?? "abc",
    modifiedTime: p.modifiedTime ?? "2026-01-01T00:00:00Z",
    parentPath: p.parentPath ?? [],
  };
}

// Manifest CSV: one row matches the seeded district by RCDTS, one references a
// nonexistent district (unmatched). Both PDFs exist in the folder.
const manifestFile = file({ name: "manifest.csv", id: "m1", mimeType: "text/csv" });
const adamsPdf = file({ name: "adams.pdf", id: "f1", md5Checksum: "h1", size: 999 });
const ghostPdf = file({ name: "ghost.pdf", id: "f2", md5Checksum: "h2", size: 222 });
const treeFiles: DriveFile[] = [manifestFile, adamsPdf, ghostPdf];
const CSV =
  `file,rcdts,unit,year\n` +
  `adams.pdf,${SID9},teachers,2024-25\n` +
  `ghost.pdf,999999999,teachers,2024-25\n`;

// Poll the status endpoint until the job is no longer "running" (or give up).
async function pollUntilDone(scanId: string): Promise<request.Response> {
  for (let i = 0; i < 100; i++) {
    const r = await request(app).get(`/admin/bulk-cba/preview/status?scanId=${scanId}`);
    if (r.body.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 15));
  }
  throw new Error("scan never finished");
}

describe("Bulk CBA preview scan-job lifecycle", () => {
  it("start -> running -> done, and the result body matches matchEntries/bulkReadManifest", async () => {
    // Control when the crawl finishes so we can observe the "running" state.
    let resolveTree: (t: { files: DriveFile[]; truncated: boolean }) => void;
    const treePromise = new Promise<{ files: DriveFile[]; truncated: boolean }>((r) => {
      resolveTree = r;
    });
    vi.mocked(listFolderTree).mockReturnValue(treePromise);
    vi.mocked(downloadDriveFile).mockResolvedValue(Buffer.from(CSV, "utf8"));

    const startRes = await request(app)
      .post("/admin/bulk-cba/preview/start")
      .send({ folderId: FOLDER_ID });
    expect(startRes.status).toBe(200);
    expect(startRes.body.ok).toBe(true);
    const scanId = String(startRes.body.scanId);
    expect(scanId).toMatch(/^scan-/);

    // The crawl has not resolved yet, so the job is still running.
    const running = await request(app).get(`/admin/bulk-cba/preview/status?scanId=${scanId}`);
    expect(running.status).toBe(200);
    expect(running.body.status).toBe("running");

    // Finish the crawl and poll for completion.
    resolveTree!({ files: treeFiles, truncated: false });
    const done = await pollUntilDone(scanId);
    expect(done.body.status).toBe("done");
    expect(done.body.progress.phase).toBe("done");

    const { httpStatus, body } = done.body.result as {
      httpStatus: number;
      body: Record<string, unknown>;
    };
    expect(httpStatus).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.folderId).toBe(FOLDER_ID);
    expect(body.truncated).toBe(false);
    expect(body.fileCount).toBe(2); // two PDFs (the .csv is not a PDF)
    expect(body.manifest).toEqual({ id: "m1", name: "manifest.csv" });
    expect(body.matchedCount).toBe(1);
    expect(body.counts).toEqual({ matched: 1, unmatched_district: 1 });

    // Parity: the route's matched/unmatched/unreferenced sets equal what
    // matchEntries produces from the same files + manifest rows. (Our rows only
    // reference the seeded district + a nonexistent one, so a minimal lookup
    // table reproduces loadDistrictLookups's outcome exactly.)
    const cols = mapManifestColumns(["file", "rcdts", "unit", "year"])!;
    const pdfFiles = treeFiles.filter(isPdfFile);
    const lookups = {
      byPrefix: new Map([[SID9.slice(0, 9), districtId]]),
      byName: new Map([[DISTRICT_NAME.toLowerCase(), districtId]]),
    };
    const expected = matchEntries({
      rows: [
        ["adams.pdf", SID9, "teachers", "2024-25"],
        ["ghost.pdf", "999999999", "teachers", "2024-25"],
      ],
      startLine: 2,
      cols,
      files: pdfFiles,
      lookups,
    });
    const expMatched = expected.entries.filter((e) => e.status === "matched");
    const expUnmatched = expected.entries.filter((e) => e.status !== "matched");

    expect(body.matched).toEqual(expMatched);
    expect(body.unmatched).toEqual(expUnmatched);
    expect(body.unreferencedFiles).toEqual(expected.unreferencedFiles);
    // The matched row resolved to our seeded district.
    expect((body.matched as Array<{ districtId: number }>)[0].districtId).toBe(districtId);
  });

  it("returns 404 for an unknown (or expired) scanId", async () => {
    const res = await request(app).get(
      "/admin/bulk-cba/preview/status?scanId=scan-does-not-exist",
    );
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/no folder scan found/i);
  });

  it("carries httpStatus 502 in the done result when Drive is not connected", async () => {
    vi.mocked(listFolderTree).mockRejectedValue(new DriveNotConnectedError());

    const startRes = await request(app)
      .post("/admin/bulk-cba/preview/start")
      .send({ folderId: FOLDER_ID });
    expect(startRes.status).toBe(200);
    const scanId = String(startRes.body.scanId);

    const done = await pollUntilDone(scanId);
    expect(done.body.status).toBe("done");
    const { httpStatus, body } = done.body.result as {
      httpStatus: number;
      body: { error?: string };
    };
    expect(httpStatus).toBe(502);
    expect(String(body.error)).toMatch(/not connected/i);
  });

  it("rejects a start with no folder id", async () => {
    const res = await request(app).post("/admin/bulk-cba/preview/start").send({});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/folder id or url is required/i);
  });

  it("prunes a finished scan after the TTL so its status then returns 404", async () => {
    vi.mocked(listFolderTree).mockResolvedValue({ files: treeFiles, truncated: false });
    vi.mocked(downloadDriveFile).mockResolvedValue(Buffer.from(CSV, "utf8"));

    const startRes = await request(app)
      .post("/admin/bulk-cba/preview/start")
      .send({ folderId: FOLDER_ID });
    const scanId = String(startRes.body.scanId);
    const done = await pollUntilDone(scanId);
    expect(done.body.status).toBe("done");

    // The job is reachable right after finishing.
    const fresh = await request(app).get(`/admin/bulk-cba/preview/status?scanId=${scanId}`);
    expect(fresh.status).toBe(200);

    // Jump Date.now() far past the TTL (currently 30m). Only Date.now is
    // stubbed, so setTimeout-based I/O keeps working; the next poll prunes the
    // idle job and 404s. Two hours comfortably exceeds BULK_SCAN_TTL_MS.
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + TWO_HOURS_MS);
    try {
      const expired = await request(app).get(
        `/admin/bulk-cba/preview/status?scanId=${scanId}`,
      );
      expect(expired.status).toBe(404);
      expect(String(expired.body.error)).toMatch(/no folder scan found|expired/i);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("transitions to status 'error' (with a message) when the scan throws unexpectedly", async () => {
    // listFolderTree resolves a malformed tree (no `files`), so the post-listing
    // step (tree.files.filter) throws an uncaught error that lands in the job's
    // outer catch. This is distinct from a Drive listing failure, which the scan
    // catches and returns as a done-result 502 (covered above).
    vi.mocked(listFolderTree).mockResolvedValue({ truncated: false } as unknown as {
      files: DriveFile[];
      truncated: boolean;
    });

    const startRes = await request(app)
      .post("/admin/bulk-cba/preview/start")
      .send({ folderId: FOLDER_ID });
    expect(startRes.status).toBe(200);
    const scanId = String(startRes.body.scanId);

    const done = await pollUntilDone(scanId);
    expect(done.body.status).toBe("error");
    expect(String(done.body.error ?? "").length).toBeGreaterThan(0);
    // An error job carries no finished result payload.
    expect(done.body.result ?? null).toBeNull();
  });

  it(
    "returns 429 once the active-scan cap is reached, and frees a slot when one finishes",
    async () => {
      // Each crawl hangs until we resolve it, so started scans stay 'running'
      // and occupy the concurrency cap (BULK_SCAN_MAX_ACTIVE).
      const resolvers: Array<(t: { files: DriveFile[]; truncated: boolean }) => void> = [];
      vi.mocked(listFolderTree).mockReset();
      vi.mocked(listFolderTree).mockImplementation(
        () =>
          new Promise<{ files: DriveFile[]; truncated: boolean }>((resolve) => {
            resolvers.push(resolve);
          }),
      );
      vi.mocked(downloadDriveFile).mockResolvedValue(Buffer.from(CSV, "utf8"));

      const scanIds: string[] = [];
      try {
        // Start scans until the cap rejects one with 429.
        let capRes: request.Response | undefined;
        for (let i = 0; i < 12; i++) {
          const r = await request(app)
            .post("/admin/bulk-cba/preview/start")
            .send({ folderId: FOLDER_ID });
          if (r.status === 429) {
            capRes = r;
            break;
          }
          expect(r.status).toBe(200);
          scanIds.push(String(r.body.scanId));
        }
        expect(capRes).toBeDefined();
        expect(String(capRes!.body.error)).toMatch(/too many folder scans/i);
        // Exactly BULK_SCAN_MAX_ACTIVE (4 in admin.ts) scans are accepted before
        // the cap kicks in; keep this in lockstep with that constant.
        expect(scanIds.length).toBe(4);

        // Every accepted scan is still running (occupying the cap).
        for (const id of scanIds) {
          const s = await request(app).get(`/admin/bulk-cba/preview/status?scanId=${id}`);
          expect(s.body.status).toBe("running");
        }

        // Finish one scan to free a slot, then a new start is accepted again.
        resolvers[0]({ files: treeFiles, truncated: false });
        await pollUntilDone(scanIds[0]);
        const retry = await request(app)
          .post("/admin/bulk-cba/preview/start")
          .send({ folderId: FOLDER_ID });
        expect(retry.status).toBe(200);
        scanIds.push(String(retry.body.scanId));
      } finally {
        // Resolve all crawls and drain so no 'running' jobs leak to other tests,
        // even if an assertion above failed first.
        for (const resolve of resolvers) resolve({ files: treeFiles, truncated: false });
        for (const id of scanIds) await pollUntilDone(id);
      }
    },
    15000,
  );
});
