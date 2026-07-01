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
// Linked-but-unextracted backlog (Task #250).
//
// GET /admin/extraction/backlog lists IL cba_pdf source documents that have a
// contract attached (via link-pdf) but NO promoted version in any domain yet —
// the off-platform fleet's work queue. These tests assert the core invariant:
//   1. A freshly linked doc (contract, no promotion) APPEARS in the backlog.
//   2. Once a domain is promoted for that doc, it LEAVES the backlog.
//   3. ?format=csv returns a CSV attachment with the same rows.
// ---------------------------------------------------------------------------

vi.mock("../lib/objectStorage.js", () => ({
  uploadBuffer: vi.fn(async () => {}),
  uploadedCbaKey: (h: string) => `il_cba/${h}.pdf`,
  streamObjectTo: vi.fn(),
  objectExists: vi.fn(),
}));

const adminRouter = (await import("./admin.js")).default;

const MARK = `tstbacklog-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PDF = Buffer.from(`%PDF-1.4\n% ${MARK}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const FILE_HASH = createHash("sha256").update(PDF).digest("hex");

let districtId: number;
let sourceDocId: number;

function buildApp(): Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { adminAuthenticated: boolean } }).session = {
      adminAuthenticated: true,
    };
    next();
  });
  app.use(express.json({ limit: "25mb" }));
  app.use("/", adminRouter);
  return app;
}

function localPath(hash: string): string {
  return join(process.cwd(), "..", "..", "pipeline", "data", "il_cba", `${hash}.pdf`);
}

beforeAll(async () => {
  const d = await db.execute(
    sql`SELECT id FROM districts WHERE state = 'IL' ORDER BY id LIMIT 1`,
  );
  districtId = Number((d.rows[0] as { id: string | number }).id);

  // Link a PDF (creates source doc + contract, no promotion).
  const res = await request(buildApp())
    .post("/admin/extraction/link-pdf")
    .query({ district_id: districtId, bargaining_unit: "teachers", school_year: "2027-28" })
    .set("Content-Type", "application/pdf")
    .send(PDF);
  sourceDocId = res.body.sourceDocId as number;
});

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM extraction_promotions WHERE source_doc_id = ${sourceDocId}`,
  );
  await db.execute(
    sql`DELETE FROM extraction_versions WHERE source_doc_id = ${sourceDocId}`,
  );
  await db.execute(sql`DELETE FROM contracts WHERE source_doc_id = ${sourceDocId}`);
  await db.execute(sql`DELETE FROM source_documents WHERE id = ${sourceDocId}`);
  const local = localPath(FILE_HASH);
  if (existsSync(local)) rmSync(local);
  await pool.end();
});

describe("GET /admin/extraction/backlog", () => {
  it("lists a linked-but-unpromoted document", async () => {
    const res = await request(buildApp()).get("/admin/extraction/backlog");
    expect(res.status).toBe(200);
    const item = (res.body.items as Array<{ sourceDocId: number }>).find(
      (i) => i.sourceDocId === sourceDocId,
    );
    expect(item).toBeTruthy();
    expect((item as { fileHash: string }).fileHash).toBe(FILE_HASH);
    expect((item as { bargainingUnit: string }).bargainingUnit).toBe("teachers");
  });

  it("exports the backlog as CSV", async () => {
    const res = await request(buildApp()).get(
      "/admin/extraction/backlog?format=csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/extraction_backlog\.csv/);
    expect(res.text).toMatch(/source_doc_id,district_id/);
    expect(res.text).toContain(String(sourceDocId));
  });

  it("drops the document once a domain is promoted", async () => {
    // Simulate an import completing: record a promotion pointer for the doc.
    const v = await db.execute(sql`
      INSERT INTO extraction_versions
        (source_doc_id, domain, result_hash, normalized, summary, status)
      VALUES (${sourceDocId}, 'salary', ${"h".repeat(64)},
        '{"schedules":[]}'::jsonb, '{}'::jsonb, 'success')
      RETURNING id
    `);
    const versionId = (v.rows[0] as { id: string | number }).id;
    await db.execute(sql`
      INSERT INTO extraction_promotions (source_doc_id, domain, version_id, promoted_by)
      VALUES (${sourceDocId}, 'salary', ${versionId}, 'test')
    `);

    const res = await request(buildApp()).get("/admin/extraction/backlog");
    expect(res.status).toBe(200);
    const stillThere = (res.body.items as Array<{ sourceDocId: number }>).some(
      (i) => i.sourceDocId === sourceDocId,
    );
    expect(stillThere).toBe(false);
  });
});
