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
// Tests for GET /dashboard/districts/:id/baseline.
//
// Proves the state-reported baseline (ISBE Teacher Salary Study + EIS) is
// returned aggregates-only, with the documented camelCase shape, and that the
// unknown-district / out-of-customer-state (IDOR) guards hold.
//
// Runs against the REAL dev DB. Discovers an IL district that actually has both
// a TSS snapshot and EIS statistics (incl. per-position rows) rather than
// hard-coding ids.
// ---------------------------------------------------------------------------

const dashboardRouter = (await import("./dashboard.js")).default;

const MARK = `baseline-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

beforeAll(async () => {
  const a = await db.execute(sql`
    INSERT INTO users (name, email, role, plan, active)
    VALUES ('Baseline Admin', ${`${MARK}@test.collbar`}, 'admin', 'pro', true)
    RETURNING id
  `);
  adminId = Number((a.rows[0] as { id: string | number }).id);

  // An IL district that carries a TSS snapshot AND EIS district stats AND at
  // least one per-position row, so every assertion below has something to bind.
  const d = await db.execute(sql`
    SELECT d.id
    FROM districts d
    WHERE d.state = 'IL'
      AND EXISTS (SELECT 1 FROM tss_annual t
                  WHERE t.state_district_id = d.state_district_id AND t.state = 'IL')
      AND EXISTS (SELECT 1 FROM il_eis_district e
                  WHERE e.state_district_id = d.state_district_id)
      AND EXISTS (SELECT 1 FROM il_eis_position_summary p
                  WHERE p.state_district_id = d.state_district_id)
    ORDER BY d.id
    LIMIT 1
  `);
  if (!d.rows.length) {
    throw new Error("No IL district with TSS + EIS baseline data found for test");
  }
  districtId = Number((d.rows[0] as { id: number | string }).id);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM users WHERE id = ${adminId}`);
  await pool.end();
});

describe("baseline endpoint", () => {
  it("returns the TSS + EIS baseline in the documented shape", async () => {
    const res = await request(buildApp(adminId)).get(
      `/dashboard/districts/${districtId}/baseline`,
    );

    expect(res.status).toBe(200);
    // Top-level shape.
    expect(res.body).toHaveProperty("tss");
    expect(res.body).toHaveProperty("eis");

    // TSS snapshot: schedule lanes + the six insurance coverage types.
    const tss = res.body.tss;
    expect(tss).toBeTruthy();
    expect(typeof tss.schoolYear).toBe("string");
    expect(tss.salarySchedule).toBeTruthy();
    for (const k of [
      "baBegin", "baMax", "maBegin", "maMax",
      "ma30Begin", "highestScheduledSalary", "masters10thYearSalary",
    ]) {
      expect(tss.salarySchedule).toHaveProperty(k);
    }
    for (const cov of ["health", "dental", "vision", "life", "prescription", "disability"]) {
      expect(tss.insurance).toHaveProperty(cov);
      for (const f of ["premiumEmployee", "pctEmployerEmployee", "premiumFamily", "pctEmployerFamily"]) {
        expect(tss.insurance[cov]).toHaveProperty(f);
      }
    }
    expect(tss.retirement).toHaveProperty("trsBoardPaidPct");
    expect(tss.leave).toHaveProperty("sickDays");
    expect(tss.longevity).toHaveProperty("longevityBaMax");

    // EIS: district-level stats + per-position aggregates.
    const eis = res.body.eis;
    expect(eis).toBeTruthy();
    expect(eis.district).toBeTruthy();
    for (const k of [
      "avgTeacherSalary", "medianTeacherSalary", "p25Salary", "p75Salary",
      "teacherHeadcount", "teacherFte",
    ]) {
      expect(eis.district).toHaveProperty(k);
    }
    expect(Array.isArray(eis.positions)).toBe(true);
    expect(eis.positions.length).toBeGreaterThan(0);
  });

  it("returns aggregates only — never individual-person fields", async () => {
    const res = await request(buildApp(adminId)).get(
      `/dashboard/districts/${districtId}/baseline`,
    );
    expect(res.status).toBe(200);

    // No person-identifying keys anywhere in the payload.
    const blob = JSON.stringify(res.body).toLowerCase();
    expect(blob).not.toContain('"name"');
    expect(blob).not.toContain('"firstname"');
    expect(blob).not.toContain('"lastname"');
    expect(blob).not.toContain('"email"');

    // Every position row exposes only aggregate columns.
    const allowed = new Set([
      "schoolYear", "positionDescription", "positionGroup", "headcount",
      "totalFte", "avgSalary", "medianSalary", "p25Salary", "p75Salary",
    ]);
    for (const p of res.body.eis.positions as Record<string, unknown>[]) {
      for (const key of Object.keys(p)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  it("returns 404 for an unknown district", async () => {
    const res = await request(buildApp(adminId)).get(
      `/dashboard/districts/999999999/baseline`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a district outside the customer state (IDOR guard)", async () => {
    const oh = await db.execute(sql`
      SELECT id FROM districts WHERE state <> 'IL' LIMIT 1
    `);
    if (!oh.rows.length) return; // only IL districts in dev data
    const ohId = Number((oh.rows[0] as { id: number | string }).id);
    const res = await request(buildApp(adminId)).get(
      `/dashboard/districts/${ohId}/baseline`,
    );
    expect(res.status).toBe(404);
  });
});
