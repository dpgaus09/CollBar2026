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
});
