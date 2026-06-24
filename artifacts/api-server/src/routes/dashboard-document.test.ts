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
const { signDocumentAccessToken } = await import("../lib/documentToken.js");

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
let freeUserId: number;
let otherDistrictId: number;

function buildApp(userId: number): Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { userId: number } }).session = { userId };
    next();
  });
  app.use("/", dashboardRouter);
  return app;
}

// An app with NO session at all — exercises the signed-token auth path used by
// "View source PDF" links that open in a new tab without the session cookie.
function buildTokenApp(): Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {};
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

  // A second IL district + a free user assigned to it, to prove the signed
  // token does NOT let a free customer reach another district's document.
  const d2 = await db.execute(sql`
    SELECT id FROM districts
    WHERE state = 'IL' AND id <> ${districtId}
    LIMIT 1
  `);
  otherDistrictId = Number((d2.rows[0] as { id: string | number }).id);

  const f = await db.execute(sql`
    INSERT INTO users (name, email, role, plan, district_id, active)
    VALUES ('Doc Test Free', ${`${MARK}-free@test.collbar`}, 'district_user', 'free', ${otherDistrictId}, true)
    RETURNING id
  `);
  freeUserId = Number((f.rows[0] as { id: string | number }).id);
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM source_documents WHERE source_url IN (${SRC_OK}, ${SRC_MISSING})`,
  );
  await db.execute(sql`DELETE FROM users WHERE id IN (${adminId}, ${freeUserId})`);
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

describe("GET /dashboard/document (signed-token auth, new-tab links)", () => {
  it("streams the PDF for a valid token with no session cookie", async () => {
    const token = signDocumentAccessToken(adminId);
    const res = await request(buildTokenApp())
      .get("/dashboard/document")
      .query({ src: SRC_OK, token })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect((res.body as Buffer).subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("401s for a tampered token", async () => {
    const token = signDocumentAccessToken(adminId) + "x";
    const res = await request(buildTokenApp())
      .get("/dashboard/document")
      .query({ src: SRC_OK, token });
    expect(res.status).toBe(401);
  });

  it("401s for an expired token", async () => {
    const token = signDocumentAccessToken(adminId, -1000);
    const res = await request(buildTokenApp())
      .get("/dashboard/document")
      .query({ src: SRC_OK, token });
    expect(res.status).toBe(401);
  });

  it("403s a free user's token for another district's document", async () => {
    const token = signDocumentAccessToken(freeUserId);
    const res = await request(buildTokenApp())
      .get("/dashboard/document")
      .query({ src: SRC_OK, token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN_DISTRICT");
  });

  it("returns an HTML error page for top-level browser navigations", async () => {
    const res = await request(buildTokenApp())
      .get("/dashboard/document")
      .set("Sec-Fetch-Dest", "document")
      .query({ src: SRC_OK }); // no token → 401, but as HTML
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Sign-in required");
  });
});
