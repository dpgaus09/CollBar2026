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
// Tests for GET /api/firm/settlements/districts/:id — the firm workspace
// district detail endpoint, focused on the state-reported baseline panels.
//
// The firm district page surfaces the same ISBE Salary Study (TSS) + EIS
// baseline as the customer dashboard, served via the shared queryDistrictBaseline
// reader. There is already coverage for the dashboard baseline endpoint
// (dashboard-baseline.test.ts); this mirrors it for the firm route so a future
// change to the firm route or the shared reader can't silently drop the
// `baseline` field or break IL-scoping.
//
// Runs against the REAL dev DB. Discovers an IL district that actually has both
// a TSS snapshot and EIS statistics rather than hard-coding ids, and creates a
// real firm + firm member so requireFirmSession resolves.
// ---------------------------------------------------------------------------

const firmSettlementsRouter = (await import("./firm-settlements.js")).default;

const MARK = `firm-baseline-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let userId: number;
let firmId: number;
let districtId: number;

type Session = { userId?: number; activeFirmId?: number };

function buildApp(session: Session): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Session }).session = session;
    next();
  });
  app.use("/api", firmSettlementsRouter);
  return app;
}

beforeAll(async () => {
  const u = await db.execute(sql`
    INSERT INTO users (name, email, role, plan, active)
    VALUES ('Firm Baseline User', ${`${MARK}@test.collbar`}, 'district_user', 'free', true)
    RETURNING id
  `);
  userId = Number((u.rows[0] as { id: string | number }).id);

  const f = await db.execute(sql`
    INSERT INTO firms (name, plan_tier) VALUES (${`Firm ${MARK}`}, 'state')
    RETURNING id
  `);
  firmId = Number((f.rows[0] as { id: string | number }).id);

  await db.execute(sql`
    INSERT INTO firm_members (firm_id, user_id, role)
    VALUES (${firmId}, ${userId}, 'firm_admin')
  `);

  // An IL district that carries both a TSS snapshot AND EIS district stats so
  // the baseline.tss and baseline.eis assertions have something to bind to.
  const d = await db.execute(sql`
    SELECT d.id
    FROM districts d
    WHERE d.state = 'IL'
      AND EXISTS (SELECT 1 FROM tss_annual t
                  WHERE t.state_district_id = d.state_district_id AND t.state = 'IL')
      AND EXISTS (SELECT 1 FROM il_eis_district e
                  WHERE e.state_district_id = d.state_district_id)
    ORDER BY d.id
    LIMIT 1
  `);
  if (!d.rows.length) {
    throw new Error("No IL district with TSS + EIS baseline data found for test");
  }
  districtId = Number((d.rows[0] as { id: number | string }).id);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM firm_members WHERE firm_id = ${firmId}`);
  await db.execute(sql`DELETE FROM firms WHERE id = ${firmId}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  await pool.end();
});

describe("firm settlements district detail — baseline", () => {
  it("includes baseline { tss, eis } for an IL district with state data", async () => {
    const res = await request(buildApp({ userId, activeFirmId: firmId })).get(
      `/api/firm/settlements/districts/${districtId}`,
    );

    expect(res.status).toBe(200);
    // The baseline panels must always be present on the firm district page.
    expect(res.body).toHaveProperty("baseline");
    const baseline = res.body.baseline;
    expect(baseline).toBeTruthy();
    expect(baseline).toHaveProperty("tss");
    expect(baseline).toHaveProperty("eis");

    // The discovered district has both, so neither side is null.
    expect(baseline.tss).toBeTruthy();
    expect(typeof baseline.tss.schoolYear).toBe("string");
    expect(baseline.tss.salarySchedule).toBeTruthy();

    expect(baseline.eis).toBeTruthy();
    expect(baseline.eis.district).toBeTruthy();
  });

  it("rejects a malformed district id with 400", async () => {
    const res = await request(buildApp({ userId, activeFirmId: firmId })).get(
      `/api/firm/settlements/districts/10588abc`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown district", async () => {
    const res = await request(buildApp({ userId, activeFirmId: firmId })).get(
      `/api/firm/settlements/districts/999999999`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a district outside the customer state (IDOR guard)", async () => {
    const oh = await db.execute(sql`
      SELECT id FROM districts WHERE state <> 'IL' LIMIT 1
    `);
    if (!oh.rows.length) return; // only IL districts in dev data
    const ohId = Number((oh.rows[0] as { id: number | string }).id);
    const res = await request(buildApp({ userId, activeFirmId: firmId })).get(
      `/api/firm/settlements/districts/${ohId}`,
    );
    expect(res.status).toBe(404);
  });
});
