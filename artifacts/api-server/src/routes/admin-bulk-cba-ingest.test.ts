import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Integration tests for POST /admin/bulk-cba/ingest — the step that actually
// performs a bulk CBA import (the folder-scan PREVIEW is covered separately in
// admin-bulk-cba-preview.test.ts). The route takes client-batched entries
// (<=25/request), downloads each PDF, writes it to Object Storage, records a
// per-(run,file) ledger row, dedups by (district, unit, content-hash), and
// enqueues exactly one extraction job per matched contract.
//
// We mock only the two external side-effects:
//   - downloadDriveFile (../lib/google-drive.js) → returns in-memory PDF bytes
//     keyed by drive file id, so each entry gets a deterministic content hash.
//   - uploadBuffer (../lib/objectStorage.js) → counts calls instead of hitting
//     GCS, so we can assert the Object-Storage write happens on BOTH the new
//     and the duplicate path.
// enqueueJob is wrapped in a PASS-THROUGH mock whose default implementation is
// the REAL queue insert (it just writes an extraction_jobs row; the worker is
// not running in tests), so the "exactly one job per matched entry / no
// duplicate job" guarantees are still asserted against the real table and its
// partial-unique active-job index. The wrapper lets the failure-path tests
// override it once (mockRejectedValueOnce) to simulate a post-source-doc step
// throwing. We opt the dev environment into enqueueing via
// BULK_IMPORT_ALLOW_DEV_ENQUEUE=1.
//
// District matching uses the REAL database, so we seed one throwaway IL
// district and tear everything down in afterAll.
// ---------------------------------------------------------------------------

process.env.BULK_IMPORT_ALLOW_DEV_ENQUEUE = "1";
// Redirect the route's best-effort local PDF copies (IL_CBA_PDF_DIR, derived
// from COLLBAR_PIPELINE_DIR at import time) to a throwaway temp dir so the test
// never writes real PDFs into the repo's pipeline/data/il_cba folder.
const TMP_PIPELINE_DIR = mkdtempSync(join(tmpdir(), "bci-pipeline-"));
// resolvePipelineDir only honors the override when it actually contains the
// pipeline's marker script; drop a stub so our temp dir is accepted.
writeFileSync(join(TMP_PIPELINE_DIR, "06_extract_contracts.py"), "");
process.env.COLLBAR_PIPELINE_DIR = TMP_PIPELINE_DIR;

vi.mock("../lib/google-drive.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/google-drive.js")>();
  return { ...actual, downloadDriveFile: vi.fn() };
});

vi.mock("../lib/objectStorage.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/objectStorage.js")>();
  return { ...actual, uploadBuffer: vi.fn(async () => {}) };
});

vi.mock("../extraction/jobs/queue.js", async (importActual) => {
  const actual = await importActual<typeof import("../extraction/jobs/queue.js")>();
  // Default implementation is the REAL enqueueJob so the functional tests above
  // keep asserting against the real extraction_jobs table + active-doc unique
  // index. The failure-path tests below override it ONCE
  // (mockRejectedValueOnce) to simulate a post-source-doc step throwing
  // mid-import; the override is consumed by the single call and reverts to the
  // real impl for later tests.
  return { ...actual, enqueueJob: vi.fn(actual.enqueueJob) };
});

const { downloadDriveFile } = await import("../lib/google-drive.js");
const { uploadBuffer, uploadedCbaKey } = await import("../lib/objectStorage.js");
const { enqueueJob } = await import("../extraction/jobs/queue.js");
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

const MARK = `tstbci-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// 9-digit RCDTS prefix in the (nonexistent) region "99" so it can never collide
// with a real IL district's state_district_id.
const SID9 = `99${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const DISTRICT_NAME = `Test District ${MARK}`;

let districtId: number;

// Deterministic in-memory PDF bytes per drive file id. Each starts with the
// %PDF magic the route requires and embeds a unique marker so its sha256 hash
// is distinct (unless two ids intentionally share content for the dedup test).
const contentById = new Map<string, Buffer>();
function pdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% bulk-cba-ingest test ${marker}\n%%EOF\n`, "utf8");
}
function hashOf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

beforeAll(async () => {
  const r = await db.execute(sql`
    INSERT INTO districts (state, state_district_id, name, slug)
    VALUES ('IL', ${SID9}, ${DISTRICT_NAME}, ${MARK})
    RETURNING id
  `);
  districtId = Number((r.rows[0] as { id: string | number }).id);

  vi.mocked(downloadDriveFile).mockImplementation(async (id: string) => {
    const buf = contentById.get(id);
    if (!buf) throw new Error(`no test content for drive file ${id}`);
    return buf;
  });
});

afterAll(async () => {
  // Order matters: extraction_jobs + contracts + alerts reference source_documents.
  await db.execute(sql`
    DELETE FROM extraction_jobs WHERE source_doc_id IN (
      SELECT id FROM source_documents WHERE district_id = ${districtId}
    )
  `);
  await db.execute(sql`DELETE FROM contracts WHERE district_id = ${districtId}`);
  await db.execute(sql`DELETE FROM alerts WHERE district_id = ${districtId}`);
  await db.execute(sql`DELETE FROM source_documents WHERE district_id = ${districtId}`);
  await db.execute(sql`DELETE FROM bulk_cba_imports WHERE run_id LIKE ${`${MARK}%`}`);
  await db.execute(sql`DELETE FROM districts WHERE id = ${districtId}`);
  rmSync(TMP_PIPELINE_DIR, { recursive: true, force: true });
  await pool.end();
});

beforeEach(() => {
  vi.mocked(uploadBuffer).mockClear();
});

function entry(p: {
  driveFileId: string;
  unit?: string;
  schoolYear?: string | null;
  filename?: string;
  driveMd5?: string;
}) {
  return {
    driveFileId: p.driveFileId,
    districtId,
    unit: p.unit ?? "teachers",
    schoolYear: p.schoolYear ?? "2024-25",
    filename: p.filename ?? `${p.driveFileId}.pdf`,
    driveFileName: `${p.driveFileId}.pdf`,
    driveMd5: p.driveMd5 ?? `md5-${p.driveFileId}`,
    driveSize: 1234,
    driveModifiedTime: "2026-01-01T00:00:00Z",
  };
}

// Count active (queued|running) extraction jobs for a given content hash, via
// the source document it produced. This is the real "one job per contract".
async function activeJobCountForHash(fileHash: string): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM extraction_jobs ej
    JOIN source_documents sd ON sd.id = ej.source_doc_id
    WHERE sd.district_id = ${districtId} AND sd.file_hash = ${fileHash}
      AND ej.domain = 'cba' AND ej.status IN ('queued', 'running')
  `);
  return Number((r.rows[0] as { n: number }).n);
}

async function ledgerStatus(runId: string, driveFileId: string): Promise<string | null> {
  const r = await db.execute(sql`
    SELECT status FROM bulk_cba_imports WHERE run_id = ${runId} AND drive_file_id = ${driveFileId} LIMIT 1
  `);
  return r.rows.length ? String((r.rows[0] as { status: string }).status) : null;
}

// Full ledger row (status + the retained source_doc_id) for a (run, file).
async function ledgerRow(
  runId: string,
  driveFileId: string,
): Promise<{ status: string; source_doc_id: number | null } | null> {
  const r = await db.execute(sql`
    SELECT status, source_doc_id FROM bulk_cba_imports
    WHERE run_id = ${runId} AND drive_file_id = ${driveFileId} LIMIT 1
  `);
  if (!r.rows.length) return null;
  const row = r.rows[0] as { status: string; source_doc_id: number | string | null };
  return {
    status: String(row.status),
    source_doc_id: row.source_doc_id == null ? null : Number(row.source_doc_id),
  };
}

// Snapshot of everything an entry can create, scoped to the throwaway district,
// so a "no partial writes" assertion can compare before/after.
async function districtCounts(): Promise<{ docs: number; contracts: number; jobs: number }> {
  const r = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM source_documents WHERE district_id = ${districtId}) AS docs,
      (SELECT COUNT(*)::int FROM contracts WHERE district_id = ${districtId}) AS contracts,
      (SELECT COUNT(*)::int FROM extraction_jobs ej JOIN source_documents sd ON sd.id = ej.source_doc_id
         WHERE sd.district_id = ${districtId} AND ej.domain = 'cba' AND ej.status IN ('queued', 'running')) AS jobs
  `);
  return r.rows[0] as { docs: number; contracts: number; jobs: number };
}

async function docCountForHash(fileHash: string): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM source_documents WHERE district_id = ${districtId} AND file_hash = ${fileHash}
  `);
  return Number((r.rows[0] as { n: number }).n);
}

describe("POST /admin/bulk-cba/ingest — enqueue + Object Storage", () => {
  it("ingests each matched entry once: 1 source doc, 1 contract, 1 job, 1 upload", async () => {
    const runId = `${MARK}-run1`;
    const idA = `bciA-${MARK}`;
    const idB = `bciB-${MARK}`;
    contentById.set(idA, pdf(idA));
    contentById.set(idB, pdf(idB));
    const hashA = hashOf(contentById.get(idA)!);
    const hashB = hashOf(contentById.get(idB)!);

    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({
        runId,
        entries: [
          entry({ driveFileId: idA, unit: "teachers" }),
          entry({ driveFileId: idB, unit: "paraprofessionals" }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enqueued).toBe(true);
    expect(res.body.counts).toEqual({ ingested: 2 });
    expect(res.body.results).toHaveLength(2);
    for (const r of res.body.results as Array<{ status: string; sourceDocId: number | null }>) {
      expect(r.status).toBe("ingested");
      expect(typeof r.sourceDocId).toBe("number");
    }

    // One Object-Storage write per entry, with the content-hash key.
    expect(uploadBuffer).toHaveBeenCalledTimes(2);
    const keys = vi.mocked(uploadBuffer).mock.calls.map((c) => c[0]);
    expect(keys).toContain(uploadedCbaKey(hashA));
    expect(keys).toContain(uploadedCbaKey(hashB));

    // Exactly one source document + one contract per matched entry.
    const docs = await db.execute(sql`
      SELECT file_hash, bargaining_unit FROM source_documents WHERE district_id = ${districtId}
    `);
    const byHash = new Map(
      (docs.rows as Array<{ file_hash: string; bargaining_unit: string }>).map((d) => [
        d.file_hash,
        d.bargaining_unit,
      ]),
    );
    expect(byHash.get(hashA)).toBe("teachers");
    expect(byHash.get(hashB)).toBe("paraprofessionals");

    const contracts = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM contracts WHERE district_id = ${districtId}
    `);
    expect(Number((contracts.rows[0] as { n: number }).n)).toBe(2);

    // Exactly one active extraction job per matched entry.
    expect(await activeJobCountForHash(hashA)).toBe(1);
    expect(await activeJobCountForHash(hashB)).toBe(1);

    // Ledger recorded both as ingested.
    expect(await ledgerStatus(runId, idA)).toBe("ingested");
    expect(await ledgerStatus(runId, idB)).toBe("ingested");
  });

  it("is idempotent within the same run: re-posting the same entry adds no doc/contract/job", async () => {
    const runId = `${MARK}-run1`; // same run as above
    const idA = `bciA-${MARK}`; // already ingested above

    const before = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM source_documents WHERE district_id = ${districtId}) AS docs,
        (SELECT COUNT(*)::int FROM contracts WHERE district_id = ${districtId}) AS contracts,
        (SELECT COUNT(*)::int FROM extraction_jobs ej JOIN source_documents sd ON sd.id = ej.source_doc_id
           WHERE sd.district_id = ${districtId} AND ej.domain = 'cba') AS jobs
    `);
    const b = before.rows[0] as { docs: number; contracts: number; jobs: number };

    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ runId, entries: [entry({ driveFileId: idA, unit: "teachers" })] });

    expect(res.status).toBe(200);
    // The same (run, file) resumes from the ledger and short-circuits.
    expect((res.body.results as Array<{ status: string }>)[0].status).toBe("ingested");
    // The resume path does not re-download or re-upload.
    expect(uploadBuffer).not.toHaveBeenCalled();

    const after = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM source_documents WHERE district_id = ${districtId}) AS docs,
        (SELECT COUNT(*)::int FROM contracts WHERE district_id = ${districtId}) AS contracts,
        (SELECT COUNT(*)::int FROM extraction_jobs ej JOIN source_documents sd ON sd.id = ej.source_doc_id
           WHERE sd.district_id = ${districtId} AND ej.domain = 'cba') AS jobs
    `);
    expect(after.rows[0]).toEqual(b);
  });

  it("re-importing the same content under a new run is a duplicate: no new doc/contract/job, but Object Storage is re-ensured", async () => {
    const newRun = `${MARK}-run2`;
    const idA = `bciA-${MARK}`; // same drive file + same content as run1
    const hashA = hashOf(contentById.get(idA)!);

    const docsBefore = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM source_documents WHERE district_id = ${districtId} AND file_hash = ${hashA}
    `);
    expect(Number((docsBefore.rows[0] as { n: number }).n)).toBe(1);
    const contractsBefore = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM contracts WHERE district_id = ${districtId}
    `);

    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ runId: newRun, entries: [entry({ driveFileId: idA, unit: "teachers" })] });

    expect(res.status).toBe(200);
    expect((res.body.results as Array<{ status: string }>)[0].status).toBe("duplicate");
    expect(res.body.counts).toEqual({ duplicate: 1 });

    // The duplicate path STILL ensures the Object-Storage object exists (the
    // prod fs is ephemeral; a pre-existing doc may have only a stale local copy).
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadBuffer).mock.calls[0][0]).toBe(uploadedCbaKey(hashA));

    // No new source document and no new contract were created.
    const docsAfter = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM source_documents WHERE district_id = ${districtId} AND file_hash = ${hashA}
    `);
    expect(Number((docsAfter.rows[0] as { n: number }).n)).toBe(1);
    const contractsAfter = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM contracts WHERE district_id = ${districtId}
    `);
    expect(contractsAfter.rows[0]).toEqual(contractsBefore.rows[0]);

    // Still exactly one active job — enqueueJob dedups on the active-doc index.
    expect(await activeJobCountForHash(hashA)).toBe(1);

    // The new run's ledger records it as a duplicate.
    expect(await ledgerStatus(newRun, idA)).toBe("duplicate");
  });

  it("rejects a missing/invalid runId without any writes", async () => {
    contentById.set("bci-norun", pdf("bci-norun"));
    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ entries: [entry({ driveFileId: "bci-norun" })] });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/runId/i);
    expect(uploadBuffer).not.toHaveBeenCalled();
    const ledger = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM bulk_cba_imports WHERE drive_file_id = 'bci-norun'
    `);
    expect(Number((ledger.rows[0] as { n: number }).n)).toBe(0);
  });

  it("rejects a batch with no entries[] array (malformed) without any writes", async () => {
    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ runId: `${MARK}-bad` });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/entries\[\] is required/i);
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it("rejects an empty entries[] (no partial writes)", async () => {
    const runId = `${MARK}-empty`;
    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ runId, entries: [] });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/at least one entry/i);
    expect(uploadBuffer).not.toHaveBeenCalled();
    const ledger = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM bulk_cba_imports WHERE run_id = ${runId}
    `);
    expect(Number((ledger.rows[0] as { n: number }).n)).toBe(0);
  });

  it("rejects a batch larger than the per-request cap without any writes", async () => {
    const runId = `${MARK}-toobig`;
    const entries = Array.from({ length: 26 }, (_v, i) =>
      entry({ driveFileId: `bci-big-${i}-${MARK}` }),
    );
    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ runId, entries });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/too many entries/i);
    expect(uploadBuffer).not.toHaveBeenCalled();
    const ledger = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM bulk_cba_imports WHERE run_id = ${runId}
    `);
    expect(Number((ledger.rows[0] as { n: number }).n)).toBe(0);
  });
});

// Each entry runs through several side-effecting steps after download (the
// Object-Storage write, the source_documents insert, ensureContractForUpload,
// enqueueJob). A failure must never leave a contract silently dropped or a PDF
// that 404s in prod. bulkIngestOneFile is written to fail-closed BEFORE any DB
// write if an early step fails, and — once the source doc exists — to record a
// 'failed' ledger row that RETAINS the source_doc_id so the progress/retry
// tooling can re-drive it. These tests pin that contract.
describe("POST /admin/bulk-cba/ingest — failure paths never silently drop a contract", () => {
  it("Object-Storage write throws → entry 'failed', fail-closed before any DB write", async () => {
    const runId = `${MARK}-failup`;
    const id = `bciUp-${MARK}`;
    const buf = pdf(id);
    contentById.set(id, buf);
    const hash = hashOf(buf);

    // Nothing exists for this content yet.
    expect(await docCountForHash(hash)).toBe(0);
    const before = await districtCounts();

    // The single upload attempt for this entry rejects.
    vi.mocked(uploadBuffer).mockRejectedValueOnce(new Error("gcs unavailable"));

    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ runId, entries: [entry({ driveFileId: id, unit: "teachers" })] });

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ failed: 1 });
    const r0 = (
      res.body.results as Array<{ status: string; sourceDocId: number | null; error: string }>
    )[0];
    expect(r0.status).toBe("failed");
    expect(r0.sourceDocId).toBeNull();
    expect(r0.error).toMatch(/object storage upload failed/i);

    // The write was attempted once, then failed-closed: no source doc, contract,
    // or job for this content — nothing partially written.
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    expect(await docCountForHash(hash)).toBe(0);
    expect(await activeJobCountForHash(hash)).toBe(0);
    expect(await districtCounts()).toEqual(before);

    // The ledger records the failure with no source_doc_id (nothing to attach).
    const led = await ledgerRow(runId, id);
    expect(led?.status).toBe("failed");
    expect(led?.source_doc_id).toBeNull();
  });

  it("post-source-doc step (enqueue) throws → ledger 'failed' but RETAINS source_doc_id for retry", async () => {
    const runId = `${MARK}-failpost`;
    const id = `bciPost-${MARK}`;
    const buf = pdf(id);
    contentById.set(id, buf);
    const hash = hashOf(buf);

    expect(await docCountForHash(hash)).toBe(0);
    const before = await districtCounts();

    // Download, %PDF check, Object-Storage write, source_documents insert and
    // ensureContractForUpload all succeed; the LAST post-source-doc side-effect
    // (enqueueJob) throws.
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("queue down"));

    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ runId, entries: [entry({ driveFileId: id, unit: "teachers" })] });

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ failed: 1 });
    const r0 = (
      res.body.results as Array<{ status: string; sourceDocId: number | null; error: string }>
    )[0];
    expect(r0.status).toBe("failed");
    expect(typeof r0.sourceDocId).toBe("number");
    expect(r0.error).toMatch(/post-ingest step failed/i);

    // The source document was created and persists (its PDF is in Object
    // Storage) — it is NOT silently lost.
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    expect(await docCountForHash(hash)).toBe(1);
    // The enqueue threw, so no active extraction job exists for it.
    expect(await activeJobCountForHash(hash)).toBe(0);

    // Crucially, the 'failed' ledger row carries the source_doc_id, so the
    // progress/retry tooling can find and re-drive it instead of losing it.
    const led = await ledgerRow(runId, id);
    expect(led?.status).toBe("failed");
    expect(led?.source_doc_id).toBe(r0.sourceDocId);

    // Exactly one new source doc; no orphaned active job.
    const after = await districtCounts();
    expect(after.docs).toBe(before.docs + 1);
    expect(after.jobs).toBe(before.jobs);
  });

  it("a not-a-PDF download (missing %PDF header) → 'failed' with no partial writes", async () => {
    const runId = `${MARK}-nopdf`;
    const id = `bciNoPdf-${MARK}`;
    // Bytes that do NOT start with %PDF (e.g. an HTML error page Drive returned).
    contentById.set(id, Buffer.from("<html>not a pdf</html>", "utf8"));
    const before = await districtCounts();

    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ runId, entries: [entry({ driveFileId: id, unit: "teachers" })] });

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ failed: 1 });
    const r0 = (
      res.body.results as Array<{ status: string; sourceDocId: number | null; error: string }>
    )[0];
    expect(r0.status).toBe("failed");
    expect(r0.sourceDocId).toBeNull();
    expect(r0.error).toMatch(/not a valid pdf/i);

    // The %PDF check runs before the Object-Storage write and any DB insert.
    expect(uploadBuffer).not.toHaveBeenCalled();
    expect(await districtCounts()).toEqual(before);
    const led = await ledgerRow(runId, id);
    expect(led?.status).toBe("failed");
    expect(led?.source_doc_id).toBeNull();
  });

  it("a download error → 'failed' with no partial writes", async () => {
    const runId = `${MARK}-dlerr`;
    const id = `bciDlErr-${MARK}`;
    const before = await districtCounts();

    // The download itself rejects (e.g. Drive 5xx / revoked access).
    vi.mocked(downloadDriveFile).mockRejectedValueOnce(new Error("drive 503"));

    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({ runId, entries: [entry({ driveFileId: id, unit: "teachers" })] });

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ failed: 1 });
    const r0 = (
      res.body.results as Array<{ status: string; sourceDocId: number | null; error: string }>
    )[0];
    expect(r0.status).toBe("failed");
    expect(r0.sourceDocId).toBeNull();
    expect(r0.error).toMatch(/download failed/i);

    // Download is the first side-effect: nothing downstream ran.
    expect(uploadBuffer).not.toHaveBeenCalled();
    expect(await districtCounts()).toEqual(before);
    const led = await ledgerRow(runId, id);
    expect(led?.status).toBe("failed");
    expect(led?.source_doc_id).toBeNull();
  });
});

// The endpoint processes up to 25 entries per request with concurrency 4
// (mapLimit). The single-entry failure tests above prove a broken file is
// recorded 'failed', but NOT that the failure is isolated to its own entry: an
// admin importing a folder relies on the good contracts landing even when a few
// files are broken. These tests post a MIXED batch (one broken + one valid
// entry in the same request) and assert per-entry isolation — the bad entry
// must not roll back, skip, or poison the sibling that succeeds — plus a
// recovery case where re-posting the run after fixing the bad file re-drives
// ONLY the previously-failed entry without duplicating the good one.
describe("POST /admin/bulk-cba/ingest — one bad file does not block the rest of the batch", () => {
  // Globally-unique (unit, schoolYear) combos so each good entry creates a
  // FRESH contract (contracts are unique on (district, unit, unit_scope,
  // effective_start); earlier tests already used teachers/paraprofessionals at
  // 2024-25), keeping the districtCounts() deltas an unambiguous +1.
  const runId = `${MARK}-mixed`;
  const goodId = `bciMixGood-${MARK}`;
  const badId = `bciMixBad-${MARK}`;
  const goodUnit = "teachers";
  const goodYear = "2030-31";
  const badUnit = "paraprofessionals";
  const badYear = "2031-32";

  it("mixed batch (1 broken + 1 valid) → { ingested: 1, failed: 1 }, failure isolated to its own entry", async () => {
    const goodBuf = pdf(goodId);
    contentById.set(goodId, goodBuf);
    // Deliberately leave badId WITHOUT content: the shared download mock throws
    // "no test content for drive file <id>", deterministically failing only this
    // entry's download. (mockRejectedValueOnce would be racy here because both
    // entries download concurrently under the concurrency-4 mapLimit.)
    const goodHash = hashOf(goodBuf);

    expect(await docCountForHash(goodHash)).toBe(0);
    const before = await districtCounts();

    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({
        runId,
        entries: [
          entry({ driveFileId: badId, unit: badUnit, schoolYear: badYear }),
          entry({ driveFileId: goodId, unit: goodUnit, schoolYear: goodYear }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ ingested: 1, failed: 1 });

    const byId = new Map(
      (
        res.body.results as Array<{
          driveFileId: string;
          status: string;
          sourceDocId: number | null;
          error: string | null;
        }>
      ).map((r) => [r.driveFileId, r]),
    );
    const good = byId.get(goodId)!;
    const bad = byId.get(badId)!;
    expect(good.status).toBe("ingested");
    expect(typeof good.sourceDocId).toBe("number");
    expect(bad.status).toBe("failed");
    expect(bad.sourceDocId).toBeNull();
    expect(bad.error).toMatch(/download failed/i);

    // The bad entry's failure caused exactly ONE Object-Storage write — the good
    // entry's — and it carried the good content hash.
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadBuffer).mock.calls[0][0]).toBe(uploadedCbaKey(goodHash));

    // The good entry produced exactly 1 source doc / 1 contract / 1 active job;
    // the bad entry left NO writes. The +1/+1/+1 delta proves both at once.
    const after = await districtCounts();
    expect(after).toEqual({
      docs: before.docs + 1,
      contracts: before.contracts + 1,
      jobs: before.jobs + 1,
    });
    expect(await docCountForHash(goodHash)).toBe(1);
    expect(await activeJobCountForHash(goodHash)).toBe(1);

    // Ledger: good ingested (with its doc id), bad failed (no doc to attach).
    const goodLed = await ledgerRow(runId, goodId);
    expect(goodLed?.status).toBe("ingested");
    expect(goodLed?.source_doc_id).toBe(good.sourceDocId);
    const badLed = await ledgerRow(runId, badId);
    expect(badLed?.status).toBe("failed");
    expect(badLed?.source_doc_id).toBeNull();
  });

  it("re-posting the run after fixing the bad file re-drives ONLY the failed entry, no duplicate of the good one", async () => {
    // "Fix" the previously-broken file: its content is now downloadable.
    const badBuf = pdf(badId);
    contentById.set(badId, badBuf);
    const badHash = hashOf(badBuf);
    const goodHash = hashOf(contentById.get(goodId)!);

    expect(await docCountForHash(badHash)).toBe(0); // never ingested before
    expect(await docCountForHash(goodHash)).toBe(1); // already ingested above
    const before = await districtCounts();

    const res = await request(app)
      .post("/admin/bulk-cba/ingest")
      .send({
        runId,
        entries: [
          entry({ driveFileId: badId, unit: badUnit, schoolYear: badYear }),
          entry({ driveFileId: goodId, unit: goodUnit, schoolYear: goodYear }),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ ingested: 2 });

    // Only the previously-failed entry was re-driven: exactly ONE new upload,
    // the fixed bad file. The good entry resumes from its 'ingested' ledger row
    // and short-circuits before any download/upload.
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadBuffer).mock.calls[0][0]).toBe(uploadedCbaKey(badHash));

    // The good entry is NOT duplicated; the fixed bad entry now lands exactly once.
    expect(await docCountForHash(goodHash)).toBe(1);
    expect(await docCountForHash(badHash)).toBe(1);
    expect(await activeJobCountForHash(badHash)).toBe(1);

    // Net effect is a single new entry's worth of writes (the recovered one).
    const after = await districtCounts();
    expect(after).toEqual({
      docs: before.docs + 1,
      contracts: before.contracts + 1,
      jobs: before.jobs + 1,
    });

    // The bad entry's ledger row flips from failed → ingested with a real doc id.
    const badLed = await ledgerRow(runId, badId);
    expect(badLed?.status).toBe("ingested");
    expect(typeof badLed?.source_doc_id).toBe("number");
  });
});

// #238 proved isolation for a minimal 2-entry mixed batch. The endpoint really
// runs up to 25 entries at concurrency 4 (mapLimit), so the worst realistic
// case is several broken entries interleaved with several good ones inside one
// concurrency window. A regression where a rejected promise (or a shared
// transaction/connection) takes down its siblings in the same mapLimit wave
// would slip past a 2-entry test. This test posts a wider batch (4 good + 2
// download failures + 2 non-PDF failures) interleaved so the first window holds
// both, and uses a deterministic barrier to PROVE a bad and a good entry are in
// flight together — no timing flakiness — before asserting every good entry
// landed independently and every bad entry left no writes.
describe("POST /admin/bulk-cba/ingest — a bad file mid-batch can't poison the concurrent group", () => {
  it("wide mixed batch (4 good + 2 download-fail + 2 non-PDF) isolates every failure", async () => {
    const runId = `${MARK}-wide`;

    // Each good entry gets a globally-unique (unit, schoolYear) so it creates a
    // FRESH contract (contracts are unique on district, unit, unit_scope,
    // effective_start), keeping each districtCounts() delta an unambiguous +1.
    const goods = [
      { id: `bciWideGood1-${MARK}`, unit: "custodial_maintenance", year: "2040-41" },
      { id: `bciWideGood2-${MARK}`, unit: "transportation", year: "2041-42" },
      { id: `bciWideGood3-${MARK}`, unit: "secretarial_clerical", year: "2042-43" },
      { id: `bciWideGood4-${MARK}`, unit: "food_service", year: "2043-44" },
    ];
    // Download fails: content left unset → the shared download mock throws.
    const badDl = [
      { id: `bciWideDl1-${MARK}`, unit: "nurses", year: "2050-51" },
      { id: `bciWideDl2-${MARK}`, unit: "administrators", year: "2051-52" },
    ];
    // Non-PDF: downloads fine but fails the %PDF header check before any write.
    const badNoPdf = [
      { id: `bciWideNoPdf1-${MARK}`, unit: "support_staff", year: "2052-53" },
      { id: `bciWideNoPdf2-${MARK}`, unit: "other", year: "2053-54" },
    ];

    for (const g of goods) contentById.set(g.id, pdf(g.id));
    for (const b of badNoPdf) {
      contentById.set(b.id, Buffer.from(`<html>not a pdf ${b.id}</html>`, "utf8"));
    }
    // badDl ids intentionally have NO content.

    const goodHash = new Map(goods.map((g) => [g.id, hashOf(contentById.get(g.id)!)]));
    const goodIds = new Set(goods.map((g) => g.id));
    const badIds = new Set([...badDl, ...badNoPdf].map((b) => b.id));

    // Interleave so the first concurrency-4 window (indices 0-3) is
    // [badDl1, good1, badNoPdf1, good2] — two bad + two good in the same wave.
    const ordered = [
      entry({ driveFileId: badDl[0].id, unit: badDl[0].unit, schoolYear: badDl[0].year }),
      entry({ driveFileId: goods[0].id, unit: goods[0].unit, schoolYear: goods[0].year }),
      entry({ driveFileId: badNoPdf[0].id, unit: badNoPdf[0].unit, schoolYear: badNoPdf[0].year }),
      entry({ driveFileId: goods[1].id, unit: goods[1].unit, schoolYear: goods[1].year }),
      entry({ driveFileId: badDl[1].id, unit: badDl[1].unit, schoolYear: badDl[1].year }),
      entry({ driveFileId: goods[2].id, unit: goods[2].unit, schoolYear: goods[2].year }),
      entry({ driveFileId: badNoPdf[1].id, unit: badNoPdf[1].unit, schoolYear: badNoPdf[1].year }),
      entry({ driveFileId: goods[3].id, unit: goods[3].unit, schoolYear: goods[3].year }),
    ];

    // Deterministic concurrency probe: hold every download until CONCURRENCY of
    // them are simultaneously in flight, then release. Because mapLimit runs
    // exactly 4 workers and none can free its slot until its download returns,
    // all 4 first-window downloads reach the barrier — proving (without timing
    // flakiness) that a good and a bad entry share a window.
    const CONCURRENCY = 4;
    const original = vi.mocked(downloadDriveFile).getMockImplementation();
    let inFlight = 0;
    let maxInFlight = 0;
    let overlapSeen = false;
    const live = new Set<string>();
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let safetyFired = false;
    vi.mocked(downloadDriveFile).mockImplementation(async (id: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      live.add(id);
      if ([...live].some((x) => goodIds.has(x)) && [...live].some((x) => badIds.has(x))) {
        overlapSeen = true;
      }
      if (++arrived >= CONCURRENCY) release();
      try {
        await gate;
        const buf = contentById.get(id);
        if (!buf) throw new Error(`no test content for drive file ${id}`);
        return buf;
      } finally {
        inFlight--;
        live.delete(id);
      }
    });

    const before = await districtCounts();
    // Safety net against a hang if the concurrency model ever changes. Started
    // only around the request and generously long so it cannot fire on a slow
    // CI run before the 4 downloads arrive (that would falsely fail the
    // maxInFlight assertion); safetyFired is asserted below to make any
    // premature release explicit rather than silent.
    const safety = setTimeout(() => {
      safetyFired = true;
      release();
    }, 10000);
    const res = await (async () => {
      try {
        return await request(app)
          .post("/admin/bulk-cba/ingest")
          .send({ runId, entries: ordered });
      } finally {
        clearTimeout(safety);
        vi.mocked(downloadDriveFile).mockImplementation(original!);
      }
    })();

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ ingested: 4, failed: 4 });

    // The barrier released because the real concurrency reached 4, not because
    // the safety timer bailed us out.
    expect(safetyFired).toBe(false);
    // The concurrency window genuinely interleaved a bad and a good entry.
    expect(maxInFlight).toBe(CONCURRENCY);
    expect(overlapSeen).toBe(true);

    const byId = new Map(
      (
        res.body.results as Array<{
          driveFileId: string;
          status: string;
          sourceDocId: number | null;
          error: string | null;
        }>
      ).map((r) => [r.driveFileId, r]),
    );

    // Every good entry succeeded independently: 1 doc, 1 active job, ledger row.
    for (const g of goods) {
      const r = byId.get(g.id)!;
      expect(r.status).toBe("ingested");
      expect(typeof r.sourceDocId).toBe("number");
      expect(await docCountForHash(goodHash.get(g.id)!)).toBe(1);
      expect(await activeJobCountForHash(goodHash.get(g.id)!)).toBe(1);
      const led = await ledgerRow(runId, g.id);
      expect(led?.status).toBe("ingested");
      expect(led?.source_doc_id).toBe(r.sourceDocId);
    }

    // Every download-failure entry is isolated: failed, no doc id.
    for (const b of badDl) {
      const r = byId.get(b.id)!;
      expect(r.status).toBe("failed");
      expect(r.sourceDocId).toBeNull();
      expect(r.error).toMatch(/download failed/i);
      const led = await ledgerRow(runId, b.id);
      expect(led?.status).toBe("failed");
      expect(led?.source_doc_id).toBeNull();
    }

    // Every non-PDF entry is isolated the same way (failed at the %PDF check).
    for (const b of badNoPdf) {
      const r = byId.get(b.id)!;
      expect(r.status).toBe("failed");
      expect(r.sourceDocId).toBeNull();
      expect(r.error).toMatch(/not a valid pdf/i);
      const led = await ledgerRow(runId, b.id);
      expect(led?.status).toBe("failed");
      expect(led?.source_doc_id).toBeNull();
    }

    // Only the 4 good entries were uploaded — nothing from the 4 bad ones.
    expect(uploadBuffer).toHaveBeenCalledTimes(4);
    const uploadedKeys = new Set(vi.mocked(uploadBuffer).mock.calls.map((c) => c[0]));
    for (const g of goods) {
      expect(uploadedKeys.has(uploadedCbaKey(goodHash.get(g.id)!))).toBe(true);
    }

    // Aggregate: exactly the 4 good entries' worth of writes leaked through.
    const after = await districtCounts();
    expect(after).toEqual({
      docs: before.docs + 4,
      contracts: before.contracts + 4,
      jobs: before.jobs + 4,
    });
  }, 20000);
});
