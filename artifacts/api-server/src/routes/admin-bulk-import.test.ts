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
// Integration tests for POST /admin/bulk-import-customers. These run against
// the REAL database (like admin-review-queue.test.ts) because the behavior
// under test — district matching, the email upsert, idempotency, and per-batch
// row numbering — lives in SQL and the request pipeline.
//
// The production bug being guarded against: a single huge upload hashes ~900
// passwords with bcrypt in one request and is aborted by the deployment's 300s
// proxy timeout. The client now parses the CSV and POSTs JSON batches; each
// request is processed statelessly with an explicit `startRow` so reported row
// numbers still match the original spreadsheet lines. The legacy single-shot
// raw-CSV path is kept for backwards compatibility and is also covered here.
//
// Every account we create is tagged with a unique marker so the tests are
// robust against the existing rows, and everything is torn down in afterAll.
// ---------------------------------------------------------------------------

const adminRouter = (await import("./admin.js")).default;

function buildApp(): Express {
  const app = express();
  // Mirror the real app: a global json() parser (with its default 100kb limit)
  // runs before the router. Batches must stay well under that.
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

const MARK = `tstbi-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// 9-digit RCDTS prefix in the (nonexistent) region "99" so it can never collide
// with a real IL district's state_district_id.
const SID9 = `99${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const DISTRICT_NAME = `Test District ${MARK}`;
const HEADER = ["Entity Type", "District", "RCDTS", "Administrator", "Email", "Password"];
const email = (slot: string) => `${slot}-${MARK}@test.collbar`;

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
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%${MARK}%`}`);
  await db.execute(sql`DELETE FROM districts WHERE id = ${districtId}`);
  await pool.end();
});

// A batch with one match-by-RCDTS, one match-by-name, one ROE (skipped), one
// missing-password (skipped), and one unmatched-but-created row.
function sampleRows(): string[][] {
  return [
    ["District", "", SID9, "Alice", email("a"), "pw-a"], // matched by RCDTS
    ["District", DISTRICT_NAME, "", "Bob", email("b"), "pw-b"], // matched by name
    ["ROE", "Some ROE", "", "Carol", email("c"), "pw-c"], // skipped: entity
    ["District (add'l contact)", DISTRICT_NAME, "", "Dave", email("d"), ""], // skipped: no password
    ["District", `Ghost ${MARK}`, "", "Erin", email("e"), "pw-e"], // created, unmatched
  ];
}

describe("POST /admin/bulk-import-customers (JSON batch mode)", () => {
  it("creates accounts, resolves districts, skips bad rows, and numbers rows from startRow", async () => {
    const res = await request(app)
      .post("/admin/bulk-import-customers")
      .set("Content-Type", "application/json")
      .send({ header: HEADER, rows: sampleRows(), startRow: 2 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.created).toBe(3); // a, b, e
    expect(res.body.updated).toBe(0);
    expect(res.body.skippedCount).toBe(2); // c, d
    expect(res.body.unmatchedCount).toBe(1); // e

    const skippedByRow = Object.fromEntries(
      (res.body.skipped as { row: number; reason: string }[]).map((s) => [s.row, s.reason]),
    );
    // startRow=2 -> rows are spreadsheet lines 2..6.
    expect(skippedByRow[4]).toMatch(/roe/i); // ROE row
    expect(skippedByRow[5]).toMatch(/no password/i); // missing password row

    const unmatched = res.body.unmatchedDistrict as { row: number; email: string }[];
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].row).toBe(6);
    expect(unmatched[0].email).toBe(email("e"));

    // Verify the upsert actually wrote the matched account as pro/active and
    // linked it to our district.
    const a = await db.execute(
      sql`SELECT plan, active, district_id FROM users WHERE email = ${email("a")}`,
    );
    expect(a.rows).toHaveLength(1);
    const row = a.rows[0] as { plan: string; active: boolean; district_id: string | number };
    expect(row.plan).toBe("pro");
    expect(row.active).toBe(true);
    expect(Number(row.district_id)).toBe(districtId);
  });

  it("is idempotent: re-importing the same batch updates in place", async () => {
    const res = await request(app)
      .post("/admin/bulk-import-customers")
      .set("Content-Type", "application/json")
      .send({ header: HEADER, rows: sampleRows(), startRow: 2 });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.updated).toBe(3);
    expect(res.body.skippedCount).toBe(2);
    expect(res.body.unmatchedCount).toBe(1);
  });

  it("offsets reported row numbers by startRow (later batches)", async () => {
    const res = await request(app)
      .post("/admin/bulk-import-customers")
      .set("Content-Type", "application/json")
      .send({ header: HEADER, rows: [["ROE", "X", "", "Y", email("late"), "pw"]], startRow: 102 });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toHaveLength(1);
    expect((res.body.skipped as { row: number }[])[0].row).toBe(102);
  });

  it("rejects a batch missing required columns", async () => {
    const res = await request(app)
      .post("/admin/bulk-import-customers")
      .set("Content-Type", "application/json")
      .send({ header: ["Foo", "Bar"], rows: [["x", "y"]] });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/missing required columns/i);
  });

  it("rejects a malformed batch (no rows array)", async () => {
    const res = await request(app)
      .post("/admin/bulk-import-customers")
      .set("Content-Type", "application/json")
      .send({ header: HEADER });

    expect(res.status).toBe(400);
  });
});

describe("POST /admin/bulk-import-customers (legacy raw CSV mode)", () => {
  it("still parses a raw text/csv body in one shot", async () => {
    const csv =
      `${HEADER.join(",")}\n` + ["District", "", SID9, "Frank", email("f"), "pw-f"].join(",");
    const res = await request(app)
      .post("/admin/bulk-import-customers")
      .set("Content-Type", "text/csv")
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(1);
    expect(res.body.created + res.body.updated).toBe(1);

    const f = await db.execute(
      sql`SELECT district_id FROM users WHERE email = ${email("f")}`,
    );
    expect(Number((f.rows[0] as { district_id: string | number }).district_id)).toBe(districtId);
  });
});
