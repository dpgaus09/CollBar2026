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
// Durability guard for the manual CBA upload (POST /admin/upload-cba).
//
// Uploaded PDFs are only servable in production from Object Storage (the local
// filesystem is dev-only and autoscale instances are stateless). If the Object
// Storage write fails, the upload MUST fail too — we must never insert a
// source_documents row whose only copy is a local: path, because in prod that
// link would 404 ("Document file missing"), which is the bug this guards.
//
// We mock the Object Storage helper to simulate an outage and assert the route
// returns an error AND records no row.
// ---------------------------------------------------------------------------

vi.mock("../lib/objectStorage.js", () => ({
  uploadBuffer: vi.fn(async () => {
    throw new Error("simulated object storage outage");
  }),
  uploadedCbaKey: (h: string) => `il_cba/${h}.pdf`,
  streamObjectTo: vi.fn(),
  objectExists: vi.fn(),
}));

const adminRouter = (await import("./admin.js")).default;

const MARK = `tstupload-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// A unique, valid (by magic bytes) PDF payload so its content hash is new.
const PDF = Buffer.from(`%PDF-1.4\n% ${MARK}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const FILE_HASH = createHash("sha256").update(PDF).digest("hex");

let districtId: number;

function buildApp(): Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { adminAuthenticated: boolean } }).session = {
      adminAuthenticated: true,
    };
    next();
  });
  app.use("/", adminRouter);
  return app;
}

beforeAll(async () => {
  const d = await db.execute(sql`SELECT id FROM districts WHERE state = 'IL' LIMIT 1`);
  districtId = Number((d.rows[0] as { id: string | number }).id);
});

afterAll(async () => {
  // Defensive: ensure nothing leaked, and remove the local file the route wrote
  // before the (simulated) storage failure.
  await db.execute(sql`DELETE FROM source_documents WHERE file_hash = ${FILE_HASH}`);
  const local = join(process.cwd(), "..", "..", "pipeline", "data", "il_cba", `${FILE_HASH}.pdf`);
  if (existsSync(local)) rmSync(local);
  await pool.end();
});

describe("POST /admin/upload-cba (object storage durability)", () => {
  it("fails the upload and records no row when object storage write fails", async () => {
    const res = await request(buildApp())
      .post("/admin/upload-cba")
      .query({ district_id: districtId, bargaining_unit: "teachers" })
      .set("Content-Type", "application/pdf")
      .send(PDF);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/durable storage/i);

    // The critical invariant: no source_documents row was created, so there is
    // no link that would 404 in production.
    const rows = await db.execute(
      sql`SELECT id FROM source_documents WHERE file_hash = ${FILE_HASH}`,
    );
    expect(rows.rows.length).toBe(0);
  });
});
