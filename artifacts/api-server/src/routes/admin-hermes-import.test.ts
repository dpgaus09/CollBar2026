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
import { createHash } from "crypto";
import { existsSync, rmSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// HERMES off-platform pipeline (Task #248).
//
// Two admin endpoints let the external fleet feed data back in:
//   POST /admin/extraction/link-pdf : store + attach a PDF, NO extraction queued.
//   POST /admin/extraction/import   : import normalized JSON, per-doc ledger.
//
// These tests assert the durability + auditability invariants that make the
// off-platform flow safe:
//   1. link-pdf is object-storage-first: if the object write fails, the link
//      fails (502) and NO source_documents row is left behind (else prod 404s).
//   2. link-pdf on success creates the doc/contract but queues NO extraction.
//   3. import returns a per-document ledger and never 500s on bad envelopes:
//      empty/oversized batches are rejected, and per-item validation failures
//      (bad unit, missing document) surface as failed rows, not thrown errors.
//
// Object Storage is mocked with a toggle so we can exercise both the failure
// and success paths without touching the real bucket.
// ---------------------------------------------------------------------------

const storage = vi.hoisted(() => ({ fail: false }));

vi.mock("../lib/objectStorage.js", () => ({
  uploadBuffer: vi.fn(async () => {
    if (storage.fail) throw new Error("simulated object storage outage");
  }),
  uploadedCbaKey: (h: string) => `il_cba/${h}.pdf`,
  streamObjectTo: vi.fn(),
  objectExists: vi.fn(),
}));

const adminRouter = (await import("./admin.js")).default;

const MARK = `tsthermes-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// A unique, valid (by magic bytes) PDF payload so its content hash is new.
const PDF = Buffer.from(`%PDF-1.4\n% ${MARK}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const FILE_HASH = createHash("sha256").update(PDF).digest("hex");
const FAIL_PDF = Buffer.from(`%PDF-1.4\n% ${MARK}-fail\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const FAIL_HASH = createHash("sha256").update(FAIL_PDF).digest("hex");

let districtId: number;
let otherDistrictId: number;

function buildApp(): Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { adminAuthenticated: boolean } }).session = {
      adminAuthenticated: true,
    };
    next();
  });
  // The import route needs JSON parsing (mounted app-wide in app.ts; here we add
  // a matching parser so supertest can post envelopes).
  app.use(express.json({ limit: "25mb" }));
  app.use("/", adminRouter);
  return app;
}

function localPath(hash: string): string {
  return join(process.cwd(), "..", "..", "pipeline", "data", "il_cba", `${hash}.pdf`);
}

beforeAll(async () => {
  const d = await db.execute(
    sql`SELECT id FROM districts WHERE state = 'IL' ORDER BY id LIMIT 2`,
  );
  districtId = Number((d.rows[0] as { id: string | number }).id);
  otherDistrictId = Number((d.rows[1] as { id: string | number }).id);
});

afterAll(async () => {
  for (const h of [FILE_HASH, FAIL_HASH]) {
    await db.execute(
      sql`DELETE FROM extraction_jobs WHERE source_doc_id IN (SELECT id FROM source_documents WHERE file_hash = ${h})`,
    );
    await db.execute(sql`DELETE FROM contracts WHERE source_doc_id IN (SELECT id FROM source_documents WHERE file_hash = ${h})`);
    await db.execute(sql`DELETE FROM source_documents WHERE file_hash = ${h}`);
    const local = localPath(h);
    if (existsSync(local)) rmSync(local);
  }
  await pool.end();
});

describe("POST /admin/extraction/link-pdf", () => {
  it("fails (502) and records no row when object storage write fails", async () => {
    storage.fail = true;
    const res = await request(buildApp())
      .post("/admin/extraction/link-pdf")
      .query({ district_id: districtId, bargaining_unit: "teachers" })
      .set("Content-Type", "application/pdf")
      .send(FAIL_PDF);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/durable storage/i);

    const rows = await db.execute(
      sql`SELECT id FROM source_documents WHERE file_hash = ${FAIL_HASH}`,
    );
    expect(rows.rows.length).toBe(0);
  });

  it("links the PDF and queues NO extraction on success", async () => {
    storage.fail = false;
    const res = await request(buildApp())
      .post("/admin/extraction/link-pdf")
      .query({ district_id: districtId, bargaining_unit: "teachers", school_year: "2026-27" })
      .set("Content-Type", "application/pdf")
      .send(PDF);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enqueued).toBe(false);
    expect(res.body.fileHash).toBe(FILE_HASH);
    expect(typeof res.body.sourceDocId).toBe("number");

    const sourceDocId = res.body.sourceDocId as number;

    // The source document row must exist...
    const docs = await db.execute(
      sql`SELECT id FROM source_documents WHERE file_hash = ${FILE_HASH}`,
    );
    expect(docs.rows.length).toBe(1);

    // ...but NO extraction job may have been queued (the whole point of the
    // off-platform move: linking never triggers in-app Vision).
    const jobs = await db.execute(
      sql`SELECT id FROM extraction_jobs WHERE source_doc_id = ${sourceDocId}`,
    );
    expect(jobs.rows.length).toBe(0);
  });

  it("rejects a non-PDF payload (400)", async () => {
    storage.fail = false;
    const res = await request(buildApp())
      .post("/admin/extraction/link-pdf")
      .query({ district_id: districtId, bargaining_unit: "teachers" })
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("this is not a pdf"));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pdf/i);
  });

  it("refuses to resolve any district under a non-IL state (404)", async () => {
    // District resolution is pinned to CUSTOMER_STATE (IL). `state` is
    // caller-controlled, so a supplied non-IL state is rejected outright — the
    // off-platform fleet can never link/import against a district outside the
    // customer's state, even by pairing a non-IL district with its own state.
    storage.fail = false;
    const res = await request(buildApp())
      .post("/admin/extraction/link-pdf")
      .query({ district_id: districtId, state: "OH", bargaining_unit: "teachers" })
      .set("Content-Type", "application/pdf")
      .send(PDF);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/district not found/i);
  });
});

describe("POST /admin/extraction/import", () => {
  it("rejects an empty batch (400)", async () => {
    const res = await request(buildApp())
      .post("/admin/extraction/import")
      .send({ documents: [] });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized batch (400)", async () => {
    const documents = Array.from({ length: 101 }, () => ({
      bargainingUnit: "teachers",
      domains: {},
    }));
    const res = await request(buildApp())
      .post("/admin/extraction/import")
      .send({ documents });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too many/i);
  });

  it("returns a failed ledger row for an invalid bargaining unit (no 500)", async () => {
    const res = await request(buildApp())
      .post("/admin/extraction/import")
      .send({
        documents: [{ bargainingUnit: "not-a-unit", domains: { salary: {} } }],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].reason).toMatch(/bargaining_unit/i);
    expect(res.body.summary.failed).toBe(1);
  });

  it("returns a failed ledger row when the referenced document is missing", async () => {
    const res = await request(buildApp())
      .post("/admin/extraction/import")
      .send({
        documents: [
          { sourceDocId: 2147483000, bargainingUnit: "teachers", domains: { salary: {} } },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].reason).toMatch(/missing_source_document/i);
  });

  it("rejects a bargaining unit that mismatches the referenced document", async () => {
    // The PDF linked above is a 'teachers' doc. Referencing it by id with a
    // different (valid) unit must fail: the supplied unit drives contract attach,
    // so a mismatch would promote data onto the wrong unit.
    const doc = await db.execute(
      sql`SELECT id FROM source_documents WHERE file_hash = ${FILE_HASH} LIMIT 1`,
    );
    const sourceDocId = Number((doc.rows[0] as { id: string | number }).id);
    const res = await request(buildApp())
      .post("/admin/extraction/import")
      .send({
        documents: [
          { sourceDocId, bargainingUnit: "paraprofessionals", domains: { salary: {} } },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].reason).toMatch(/unit_mismatch/i);
  });

  it("rejects a file hash that mismatches the referenced document", async () => {
    const doc = await db.execute(
      sql`SELECT id FROM source_documents WHERE file_hash = ${FILE_HASH} LIMIT 1`,
    );
    const sourceDocId = Number((doc.rows[0] as { id: string | number }).id);
    const wrongHash = "0".repeat(64);
    const res = await request(buildApp())
      .post("/admin/extraction/import")
      .send({
        documents: [
          {
            sourceDocId,
            bargainingUnit: "teachers",
            fileHash: wrongHash,
            domains: { salary: {} },
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].reason).toMatch(/file_hash_mismatch/i);
  });

  it("rejects a supplied district that mismatches the referenced document", async () => {
    // Referencing the doc by id while ALSO supplying a DIFFERENT (but valid IL)
    // district must fail: the identity fields must agree, so an importer cannot
    // promote against a different district than the one the doc belongs to.
    const doc = await db.execute(
      sql`SELECT id FROM source_documents WHERE file_hash = ${FILE_HASH} LIMIT 1`,
    );
    const sourceDocId = Number((doc.rows[0] as { id: string | number }).id);
    const res = await request(buildApp())
      .post("/admin/extraction/import")
      .send({
        documents: [
          {
            sourceDocId,
            bargainingUnit: "teachers",
            district: { districtId: otherDistrictId },
            domains: { salary: {} },
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].reason).toMatch(/district_mismatch/i);
  });
});
