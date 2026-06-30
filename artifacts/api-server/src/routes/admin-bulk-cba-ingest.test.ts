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
// enqueueJob is the REAL queue insert (it just writes an extraction_jobs row;
// the worker is not running in tests), so the "exactly one job per matched
// entry / no duplicate job" guarantees are asserted against the real table and
// its partial-unique active-job index — not a mocked stand-in. We opt the dev
// environment into enqueueing via BULK_IMPORT_ALLOW_DEV_ENQUEUE=1.
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

const { downloadDriveFile } = await import("../lib/google-drive.js");
const { uploadBuffer, uploadedCbaKey } = await import("../lib/objectStorage.js");
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
