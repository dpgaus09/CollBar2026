import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
// Integration tests for the two endpoints an admin watches AFTER a bulk CBA
// import (the ingest step itself is covered in admin-bulk-cba-ingest.test.ts):
//
//   GET  /admin/bulk-cba/progress?runId=... — rolls up the per-(run,file) ledger
//        plus the LATEST extraction job status per ingested doc and the count of
//        docs with a successful extraction run. The job rollup must be scoped to
//        domain='cba' and to the run's own docs, or the progress page miscounts.
//
//   POST /admin/bulk-cba/retry — bounded re-enqueue of the run's docs that have
//        NEITHER an active/done cba job NOR a successful run. It must skip docs
//        that are already finished/in-flight (so it never re-bills a contract),
//        respect BULK_RETRY_CAP, and report candidates/enqueued/capped. It 409s
//        when enqueue is disabled in the environment.
//
// Everything is seeded directly against the REAL database (ledger rows, source
// documents, extraction jobs/runs); enqueueJob in the retry path is the REAL
// queue insert, so the "one active job per doc" dedupe is exercised for real.
// A throwaway IL district is created and fully torn down in afterAll.
//
// BULK_RETRY_CAP is a module-private constant in admin.ts; it is 200. The cap
// test seeds CAP+1 candidates and asserts the route stops at exactly CAP.
// ---------------------------------------------------------------------------

const BULK_RETRY_CAP = 200;

// The retry route reads bulkShouldEnqueue() at call time, which is true when
// NODE_ENV==='production' OR BULK_IMPORT_ALLOW_DEV_ENQUEUE==='1'. Default it on
// so the happy-path tests enqueue; the 409 test deletes it for one call.
process.env.BULK_IMPORT_ALLOW_DEV_ENQUEUE = "1";

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

const MARK = `tstbcipr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SID9 = `99${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const DISTRICT_NAME = `Test District ${MARK}`;

let districtId: number;

async function insertDoc(label: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO source_documents (district_id, doc_type, source_url)
    VALUES (${districtId}, 'cba_pdf', ${`https://example.test/${MARK}/${label}.pdf`})
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

async function insertLedger(p: {
  runId: string;
  driveFileId: string;
  status: string;
  sourceDocId?: number | null;
  error?: string | null;
  driveFileName?: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO bulk_cba_imports
      (run_id, drive_file_id, drive_file_name, district_id, bargaining_unit,
       source_doc_id, status, error)
    VALUES (
      ${p.runId}, ${p.driveFileId}, ${p.driveFileName ?? `${p.driveFileId}.pdf`},
      ${districtId}, 'teachers', ${p.sourceDocId ?? null}, ${p.status},
      ${p.error ?? null}
    )
  `);
}

async function insertJob(
  sourceDocId: number,
  domain: string,
  status: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO extraction_jobs (source_doc_id, domain, status)
    VALUES (${sourceDocId}, ${domain}, ${status})
  `);
}

async function insertRun(sourceDocId: number, status: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO extraction_runs (source_doc_id, status, run_at)
    VALUES (${sourceDocId}, ${status}, NOW())
  `);
}

// Active (queued|running) cba jobs for a doc — the real "one job per contract".
async function activeCbaJobCount(sourceDocId: number): Promise<number> {
  const r = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM extraction_jobs
    WHERE source_doc_id = ${sourceDocId} AND domain = 'cba'
      AND status IN ('queued', 'running')
  `);
  return Number((r.rows[0] as { n: number }).n);
}

beforeAll(async () => {
  const r = await db.execute(sql`
    INSERT INTO districts (state, state_district_id, name, slug)
    VALUES ('IL', ${SID9}, ${DISTRICT_NAME}, ${MARK})
    RETURNING id
  `);
  districtId = Number((r.rows[0] as { id: string | number }).id);
});

afterAll(async () => {
  await db.execute(sql`
    DELETE FROM extraction_jobs WHERE source_doc_id IN (
      SELECT id FROM source_documents WHERE district_id = ${districtId}
    )
  `);
  await db.execute(sql`
    DELETE FROM extraction_runs WHERE source_doc_id IN (
      SELECT id FROM source_documents WHERE district_id = ${districtId}
    )
  `);
  await db.execute(sql`DELETE FROM bulk_cba_imports WHERE run_id LIKE ${`${MARK}%`}`);
  await db.execute(sql`DELETE FROM source_documents WHERE district_id = ${districtId}`);
  await db.execute(sql`DELETE FROM districts WHERE id = ${districtId}`);
  await pool.end();
});

describe("GET /admin/bulk-cba/progress", () => {
  it("returns correct ingest, extraction-job, and extracted counts for a seeded run", async () => {
    const runId = `${MARK}-prog1`;
    // docA: ingested → cba done job + successful run  (extracted)
    // docB: ingested → cba running job
    // docC: ingested → cba failed job, no successful run
    // docD: duplicate → no job
    // plus one failed ledger row with no source doc.
    const docA = await insertDoc("progA");
    const docB = await insertDoc("progB");
    const docC = await insertDoc("progC");
    const docD = await insertDoc("progD");

    await insertLedger({ runId, driveFileId: "pgA", status: "ingested", sourceDocId: docA });
    await insertLedger({ runId, driveFileId: "pgB", status: "ingested", sourceDocId: docB });
    await insertLedger({ runId, driveFileId: "pgC", status: "ingested", sourceDocId: docC });
    await insertLedger({ runId, driveFileId: "pgD", status: "duplicate", sourceDocId: docD });
    await insertLedger({
      runId,
      driveFileId: "pgE",
      status: "failed",
      sourceDocId: null,
      error: "download failed",
    });

    await insertJob(docA, "cba", "done");
    await insertRun(docA, "success");
    await insertJob(docB, "cba", "running");
    await insertJob(docC, "cba", "failed");

    const res = await request(app).get("/admin/bulk-cba/progress").query({ runId });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBe(runId);

    // Ingest rollup = ledger grouped by status + total.
    expect(res.body.ingest).toEqual({
      total: 5,
      ingested: 3,
      duplicate: 1,
      failed: 1,
    });

    // Latest cba job status per ingested doc.
    expect(res.body.extraction.jobs).toEqual({ done: 1, running: 1, failed: 1 });

    // Only docA has a successful extraction run.
    expect(res.body.extraction.extracted).toBe(1);

    // The failed ledger row surfaces in the failures list with its error.
    const failures = res.body.failures as Array<{ error: string; driveFileName: string }>;
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe("download failed");

    // Queue stats block is present.
    expect(res.body.queue).toBeTypeOf("object");
  });

  it("scopes the job rollup to domain='cba': a non-cba job on the same doc is not counted", async () => {
    const runId = `${MARK}-prog2`;
    // docF carries a cba 'done' job AND a salary 'failed' job. The rollup must
    // report the cba 'done' only — the salary job must never leak in as a
    // 'failed' (which would scare an admin into a needless retry).
    const docF = await insertDoc("progF");
    await insertLedger({ runId, driveFileId: "pgF", status: "ingested", sourceDocId: docF });
    await insertJob(docF, "cba", "done");
    await insertJob(docF, "salary", "failed");

    const res = await request(app).get("/admin/bulk-cba/progress").query({ runId });

    expect(res.status).toBe(200);
    expect(res.body.extraction.jobs).toEqual({ done: 1 });
  });

  it("404s for a well-formed but unknown runId", async () => {
    const res = await request(app)
      .get("/admin/bulk-cba/progress")
      .query({ runId: `${MARK}-ghost` });
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/no bulk import/i);
  });

  it("400s for a missing/invalid runId", async () => {
    const res = await request(app).get("/admin/bulk-cba/progress");
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/runId is required/i);
  });
});

describe("POST /admin/bulk-cba/retry", () => {
  it("re-enqueues only docs with neither an active/done cba job nor a successful run", async () => {
    const runId = `${MARK}-retry1`;
    // docG: no job, no run                     → candidate (enqueued)
    // docH: cba 'done' job                     → skip (already finished)
    // docI: cba 'queued' (active) job          → skip (in flight)
    // docJ: successful run, no job             → skip (already extracted)
    // docK: cba 'failed' job, no success run   → candidate (genuine re-run)
    // docL: only a salary 'done' job           → candidate (cba never ran)
    const docG = await insertDoc("retG");
    const docH = await insertDoc("retH");
    const docI = await insertDoc("retI");
    const docJ = await insertDoc("retJ");
    const docK = await insertDoc("retK");
    const docL = await insertDoc("retL");

    await insertLedger({ runId, driveFileId: "rG", status: "ingested", sourceDocId: docG });
    await insertLedger({ runId, driveFileId: "rH", status: "ingested", sourceDocId: docH });
    await insertLedger({ runId, driveFileId: "rI", status: "ingested", sourceDocId: docI });
    await insertLedger({ runId, driveFileId: "rJ", status: "ingested", sourceDocId: docJ });
    await insertLedger({ runId, driveFileId: "rK", status: "ingested", sourceDocId: docK });
    await insertLedger({ runId, driveFileId: "rL", status: "ingested", sourceDocId: docL });

    await insertJob(docH, "cba", "done");
    await insertJob(docI, "cba", "queued");
    await insertRun(docJ, "success");
    await insertJob(docK, "cba", "failed");
    await insertJob(docL, "salary", "done");

    const res = await request(app).post("/admin/bulk-cba/retry").send({ runId });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.candidates).toBe(3);
    expect(res.body.enqueued).toBe(3);
    expect(res.body.capped).toBe(false);

    // The three candidates now have exactly one active cba job each…
    expect(await activeCbaJobCount(docG)).toBe(1);
    expect(await activeCbaJobCount(docK)).toBe(1);
    expect(await activeCbaJobCount(docL)).toBe(1);
    // …and the skipped docs were not touched (docI still has its one pre-seeded
    // active job; docH/docJ remain with no active cba job).
    expect(await activeCbaJobCount(docI)).toBe(1);
    expect(await activeCbaJobCount(docH)).toBe(0);
    expect(await activeCbaJobCount(docJ)).toBe(0);
  });

  it("caps the re-enqueue at BULK_RETRY_CAP and reports capped=true", async () => {
    const runId = `${MARK}-retrycap`;
    // Seed CAP+1 fresh candidate docs (no jobs, no runs) for this run.
    const n = BULK_RETRY_CAP + 1;
    const capPrefix = `https://example.test/${MARK}/cap-`;
    await db.execute(sql`
      INSERT INTO source_documents (district_id, doc_type, source_url)
      SELECT ${districtId}, 'cba_pdf', ${capPrefix} || g::text
      FROM generate_series(1, ${n}) g
    `);
    await db.execute(sql`
      INSERT INTO bulk_cba_imports
        (run_id, drive_file_id, district_id, bargaining_unit, source_doc_id, status)
      SELECT ${runId}, 'cap-' || sd.id, ${districtId}, 'teachers', sd.id, 'ingested'
      FROM source_documents sd
      WHERE sd.district_id = ${districtId} AND sd.source_url LIKE ${`${capPrefix}%`}
    `);

    const res = await request(app).post("/admin/bulk-cba/retry").send({ runId });

    expect(res.status).toBe(200);
    expect(res.body.candidates).toBe(BULK_RETRY_CAP);
    expect(res.body.enqueued).toBe(BULK_RETRY_CAP);
    expect(res.body.capped).toBe(true);
  });

  it("400s for a missing/invalid runId", async () => {
    const res = await request(app).post("/admin/bulk-cba/retry").send({});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/runId is required/i);
  });

  it("409s when extraction enqueue is disabled in the environment", async () => {
    const runId = `${MARK}-retry409`;
    const docM = await insertDoc("retM");
    await insertLedger({ runId, driveFileId: "rM", status: "ingested", sourceDocId: docM });

    const prev = process.env.BULK_IMPORT_ALLOW_DEV_ENQUEUE;
    delete process.env.BULK_IMPORT_ALLOW_DEV_ENQUEUE;
    try {
      const res = await request(app).post("/admin/bulk-cba/retry").send({ runId });
      expect(res.status).toBe(409);
      expect(String(res.body.error)).toMatch(/disabled in this environment/i);
    } finally {
      if (prev !== undefined) process.env.BULK_IMPORT_ALLOW_DEV_ENQUEUE = prev;
    }
    // Nothing was enqueued.
    expect(await activeCbaJobCount(docM)).toBe(0);
  });
});
