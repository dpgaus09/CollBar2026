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
// Integration test for the login_count aggregation on GET /admin/customers.
// Runs against the REAL database (like the other admin route tests) because the
// behavior under test lives entirely in SQL: a LEFT JOIN that counts rows in
// login_events per user and reports 0 for users who have never signed in.
//
// Every account is tagged with a unique marker so the assertions are robust
// against existing rows, and everything is torn down in afterAll.
// ---------------------------------------------------------------------------

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

const MARK = `tstlogins-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const email = (slot: string) => `${slot}-${MARK}@test.collbar`;

let frequentId: number;
let onceId: number;
let neverId: number;

async function createUser(slot: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO users (name, email, role, plan, active)
    VALUES (${`User ${slot}`}, ${email(slot)}, 'district_user', 'free', true)
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

beforeAll(async () => {
  // The table is normally created by app.ts runMigrations(); ensure it exists
  // here so the test does not depend on the dev server having booted first.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS login_events (
      id          bigserial PRIMARY KEY,
      user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  frequentId = await createUser("frequent");
  onceId = await createUser("once");
  neverId = await createUser("never");

  // frequent: 3 logins, once: 1 login, never: 0 logins.
  await db.execute(sql`
    INSERT INTO login_events (user_id) VALUES
      (${frequentId}), (${frequentId}), (${frequentId}), (${onceId})
  `);
});

afterAll(async () => {
  // login_events rows cascade-delete with their users.
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%${MARK}%`}`);
  await pool.end();
});

describe("GET /admin/customers (login_count aggregation)", () => {
  it("reports each customer's login count and 0 for users who never signed in", async () => {
    const res = await request(app).get("/admin/customers");
    expect(res.status).toBe(200);

    // user ids come back from pg as strings (bigint); coerce before matching.
    const byId = new Map<number, { login_count: number }>(
      (res.body.customers as { id: string | number; login_count: number }[]).map(
        (c) => [Number(c.id), c],
      ),
    );

    expect(byId.get(frequentId)?.login_count).toBe(3);
    expect(byId.get(onceId)?.login_count).toBe(1);
    expect(byId.get(neverId)?.login_count).toBe(0);
  });

  it("returns login_count as a number, not a string", async () => {
    const res = await request(app).get("/admin/customers");
    const frequent = (
      res.body.customers as { id: string | number; login_count: number }[]
    ).find((c) => Number(c.id) === frequentId);
    expect(typeof frequent?.login_count).toBe("number");
  });
});
