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
// Integration test for GET /dashboard/document, which serves uploaded CBA PDFs.
//
// Production regression guard: uploaded PDFs live ONLY in Replit Object Storage
// (the local filesystem is dev-only and excluded from the deploy image, and
// autoscale instances are stateless). This test inserts a source_document whose
// file_hash points at a PDF the backfill persisted to object storage, but whose
// local storage_key is intentionally bogus — so a 200 here proves the bytes are
// served from object storage, not the local disk.
//
// Runs against the REAL database and REAL object storage (via the Replit
// sidecar), like the other route tests.
// ---------------------------------------------------------------------------

const dashboardRouter = (await import("./dashboard.js")).default;

// A real CBA PDF persisted to object storage by the backfill migration.
const UPLOADED_HASH =
  "d55a2b1a2c5a3083a884565a52055176a594e2320efd6e120e13f2aa9a14b369";

const MARK = `tstdoc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SRC_OK = `upload://${MARK}-ok`;
const SRC_MISSING = `upload://${MARK}-missing`;
// 64 hex chars that will not exist in object storage.
const MISSING_HASH = "f".repeat(64);

let adminId: number;
let districtId: number;

function buildApp(userId: number): Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { userId: number } }).session = { userId };
    next();
  });
  app.use("/", dashboardRouter);
  return app;
}

// Buffer the (binary) PDF response so we can inspect its bytes.
function getBinary(app: Express, src: string) {
  return request(app)
    .get("/dashboard/document")
    .query({ src })
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
}

beforeAll(async () => {
  const a = await db.execute(sql`
    INSERT INTO users (name, email, role, plan, active)
    VALUES ('Doc Test Admin', ${`${MARK}@test.collbar`}, 'admin', 'pro', true)
    RETURNING id
  `);
  adminId = Number((a.rows[0] as { id: string | number }).id);

  // Pick an IL district that does NOT already reference this hash, so the
  // (district_id, bargaining_unit, file_hash) unique constraint won't conflict.
  const d = await db.execute(sql`
    SELECT id FROM districts
    WHERE state = 'IL'
      AND id NOT IN (
        SELECT district_id FROM source_documents
        WHERE file_hash = ${UPLOADED_HASH} AND district_id IS NOT NULL
      )
    LIMIT 1
  `);
  districtId = Number((d.rows[0] as { id: string | number }).id);

  await db.execute(sql`
    INSERT INTO source_documents
      (district_id, source_url, source_type, doc_type, storage_key, file_hash)
    VALUES
      (${districtId}, ${SRC_OK}, 'cba_pdf', 'cba_pdf',
       'local:/nonexistent/forces-object-storage.pdf', ${UPLOADED_HASH}),
      (${districtId}, ${SRC_MISSING}, 'cba_pdf', 'cba_pdf',
       'local:/nonexistent/also-missing.pdf', ${MISSING_HASH})
  `);
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM source_documents WHERE source_url IN (${SRC_OK}, ${SRC_MISSING})`,
  );
  await db.execute(sql`DELETE FROM users WHERE id = ${adminId}`);
  await pool.end();
});

describe("GET /dashboard/document (object storage serving)", () => {
  it("streams an uploaded CBA PDF from object storage (not local disk)", async () => {
    const res = await getBinary(buildApp(adminId), SRC_OK);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const body = res.body as Buffer;
    expect(body.length).toBeGreaterThan(1000);
    // A valid PDF starts with the "%PDF" magic bytes.
    expect(body.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("404s when the object is absent and there is no local fallback", async () => {
    const res = await request(buildApp(adminId))
      .get("/dashboard/document")
      .query({ src: SRC_MISSING });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Document file missing");
  });

  it("401s without an authenticated session", async () => {
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { session: Record<string, unknown> }).session = {};
      next();
    });
    app.use("/", dashboardRouter);
    const res = await request(app)
      .get("/dashboard/document")
      .query({ src: SRC_OK });
    expect(res.status).toBe(401);
  });
});
