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
// Tests for GET /dashboard/districts/:id/salary-schedules.
//
// Proves the salary-schedule grids are returned unit-scoped (default teachers),
// that teacher grids carry education lanes (BA/MA) while non-teacher units never
// do, and that the out-of-customer-state / unknown-district guards hold.
//
// Runs against the REAL dev DB. Discovers an IL district that has extracted
// salary schedules for teachers (and, when available, a second unit) rather than
// hard-coding ids.
// ---------------------------------------------------------------------------

const dashboardRouter = (await import("./dashboard.js")).default;

const MARK = `salgrid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let adminId: number;
let districtId: number;
let nonTeacherUnit: string | null = null;

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
    VALUES ('Salary Grid Admin', ${`${MARK}@test.collbar`}, 'admin', 'pro', true)
    RETURNING id
  `);
  adminId = Number((a.rows[0] as { id: string | number }).id);

  // An IL district with extracted teacher salary schedules. Prefer one that also
  // has a non-teacher unit with schedules so the unit-scoping assertions bite.
  const d = await db.execute(sql`
    SELECT c.district_id,
           array_agg(DISTINCT c.bargaining_unit) AS units
    FROM contract_salary_schedules s
    JOIN contracts c ON c.id = s.contract_id
    JOIN districts dd ON dd.id = c.district_id AND dd.state = 'IL'
    WHERE c.bargaining_unit IS NOT NULL
    GROUP BY c.district_id
    HAVING bool_or(c.bargaining_unit = 'teachers')
    ORDER BY COUNT(DISTINCT c.bargaining_unit) DESC, c.district_id
    LIMIT 1
  `);
  if (!d.rows.length) {
    throw new Error("No IL district with teacher salary schedules found for test");
  }
  const row = d.rows[0] as { district_id: number; units: string[] };
  districtId = Number(row.district_id);
  nonTeacherUnit = row.units.find((u) => u !== "teachers") ?? null;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM users WHERE id = ${adminId}`);
  await pool.end();
});

describe("salary-schedules endpoint", () => {
  it("returns teacher lane-grid schedules with education lanes and dollar cells", async () => {
    const res = await request(buildApp(adminId))
      .get(`/dashboard/districts/${districtId}/salary-schedules`)
      .query({ bargainingUnit: "teachers" });

    expect(res.status).toBe(200);
    expect(res.body.bargainingUnit).toBe("teachers");
    expect(Array.isArray(res.body.schedules)).toBe(true);
    expect(res.body.schedules.length).toBeGreaterThan(0);

    const grid = res.body.schedules.find(
      (s: { scheduleType: string }) => s.scheduleType === "lane_grid",
    );
    expect(grid).toBeTruthy();
    // Teacher grids have education lanes.
    expect(Array.isArray(grid.laneLabels)).toBe(true);
    expect(grid.laneLabels.length).toBeGreaterThanOrEqual(2);
    expect(grid.laneLabels.some((l: string) => /^BA/i.test(l))).toBe(true);
    expect(grid.laneLabels.some((l: string) => /^MA/i.test(l))).toBe(true);

    // Every cell is a positive dollar amount mapped to a real lane column.
    expect(grid.cells.length).toBeGreaterThan(0);
    for (const c of grid.cells) {
      expect(typeof c.salary).toBe("number");
      expect(c.salary).toBeGreaterThan(0);
      expect(c.laneOrder).toBeGreaterThanOrEqual(0);
      expect(c.laneOrder).toBeLessThan(grid.laneLabels.length);
    }
    // Selector metadata + derived summary present.
    expect(res.body.jobFamilies.length).toBeGreaterThan(0);
    expect(res.body.schoolYears.length).toBeGreaterThan(0);
    expect(res.body.summary).toBeTruthy();
    expect(typeof res.body.summary.baseSalary).toBe("number");
  });

  it("defaults to the teachers unit when no bargainingUnit is given", async () => {
    const res = await request(buildApp(adminId)).get(
      `/dashboard/districts/${districtId}/salary-schedules`,
    );
    expect(res.status).toBe(200);
    expect(res.body.bargainingUnit).toBe("teachers");
  });

  it("never returns BA/MA education lanes for a non-teacher unit", async () => {
    if (!nonTeacherUnit) return; // no second unit with schedules in dev data
    const res = await request(buildApp(adminId))
      .get(`/dashboard/districts/${districtId}/salary-schedules`)
      .query({ bargainingUnit: nonTeacherUnit });

    expect(res.status).toBe(200);
    expect(res.body.bargainingUnit).toBe(nonTeacherUnit);
    for (const s of res.body.schedules as { laneLabels: string[] | null }[]) {
      const labels = s.laneLabels ?? [];
      for (const l of labels) {
        expect(/^(BA|MA|BS|MS)\b/i.test(l)).toBe(false);
      }
    }
  });

  it("scopes schedules to the requested unit (teachers vs other unit differ)", async () => {
    if (!nonTeacherUnit) return;
    const app = buildApp(adminId);
    const ta = await request(app)
      .get(`/dashboard/districts/${districtId}/salary-schedules`)
      .query({ bargainingUnit: "teachers" });
    const tb = await request(app)
      .get(`/dashboard/districts/${districtId}/salary-schedules`)
      .query({ bargainingUnit: nonTeacherUnit });

    expect(ta.status).toBe(200);
    expect(tb.status).toBe(200);
    // Different units come from different contracts.
    expect(ta.body.contractId).not.toBe(tb.body.contractId);
    // The selector lists both units, teachers first.
    expect(ta.body.availableUnits[0]).toBe("teachers");
    expect(ta.body.availableUnits).toContain(nonTeacherUnit);
  });

  it("returns 404 for an unknown district", async () => {
    const res = await request(buildApp(adminId)).get(
      `/dashboard/districts/999999999/salary-schedules`,
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
      `/dashboard/districts/${ohId}/salary-schedules`,
    );
    expect(res.status).toBe(404);
  });
});
