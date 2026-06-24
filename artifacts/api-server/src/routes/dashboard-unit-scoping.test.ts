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
// Regression guard for the customer-dashboard Overview bargaining-unit toggle.
//
// The bug: the Current Contract header and the Compensation/Insurance/etc.
// cards were NOT scoped to the selected bargaining unit, so toggling between
// employee groups (e.g. Teachers vs Custodial & Maintenance) left the whole UI
// frozen on a single contract. These tests prove the three Overview endpoints
// (`/districts/:id`, `/districts/:id/provisions`, `/districts/:id/settlements`)
// are unit-aware and default to teachers.
//
// Runs against the REAL database (like the other route tests), discovering a
// real IL district that has extracted provisions for teachers AND at least one
// other unit so a unit switch must change the contract + provisions.
// ---------------------------------------------------------------------------

const dashboardRouter = (await import("./dashboard.js")).default;

const MARK = `unittoggle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let adminId: number;
let districtId: number;
let unitA: string; // teachers
let unitB: string; // a non-teacher unit that also has provisions
let contractUnits: string[]; // every distinct contract bargaining_unit for the district
let medianCategory: string; // a provision category present for the chosen units (IL-wide)
let bothUnitsShareCategory: boolean; // true if both unitA and unitB have IL provisions in it

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
    VALUES ('Unit Toggle Admin', ${`${MARK}@test.collbar`}, 'admin', 'pro', true)
    RETURNING id
  `);
  adminId = Number((a.rows[0] as { id: string | number }).id);

  // A real IL district with extracted provisions for teachers AND >=1 other
  // unit. Picking a multi-unit district is what lets us assert that toggling the
  // unit actually changes the contract/provisions rather than returning the same
  // (frozen) data.
  const d = await db.execute(sql`
    SELECT c.district_id,
           array_agg(DISTINCT c.bargaining_unit) AS units
    FROM contract_provisions cp
    JOIN contracts c ON cp.contract_id = c.id
    JOIN districts dd ON dd.id = c.district_id AND dd.state = 'IL'
    WHERE c.bargaining_unit IS NOT NULL
    GROUP BY c.district_id
    HAVING COUNT(DISTINCT c.bargaining_unit) >= 2
       AND bool_or(c.bargaining_unit = 'teachers')
    LIMIT 1
  `);
  if (!d.rows.length) {
    throw new Error("No IL district with multi-unit provisions found for test");
  }
  const row = d.rows[0] as { district_id: number; units: string[] };
  districtId = Number(row.district_id);
  contractUnits = row.units;
  unitA = "teachers";
  unitB = contractUnits.find((u) => u !== "teachers")!;

  // Pick a provision category with numeric values that the chosen units have
  // IL-wide. Prefer one both units share so the median test can also prove the
  // two units yield different (non-mixed) medians.
  const cat = await db.execute(sql`
    SELECT cp.category,
           COUNT(DISTINCT c.bargaining_unit)::int AS units
    FROM contract_provisions cp
    JOIN contracts c ON cp.contract_id = c.id
    JOIN districts d ON c.district_id = d.id AND d.state = 'IL'
    WHERE cp.value_numeric IS NOT NULL
      AND c.bargaining_unit IN (${unitA}, ${unitB})
    GROUP BY cp.category
    ORDER BY (COUNT(DISTINCT c.bargaining_unit) = 2) DESC, COUNT(*) DESC
    LIMIT 1
  `);
  if (cat.rows.length) {
    const cr = cat.rows[0] as { category: string; units: number };
    medianCategory = cr.category;
    bothUnitsShareCategory = cr.units === 2;
  } else {
    medianCategory = "insurance";
    bothUnitsShareCategory = false;
  }
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM users WHERE id = ${adminId}`);
  await pool.end();
});

describe("Overview bargaining-unit scoping", () => {
  it("returns the contract for the requested unit (toggling changes the contract)", async () => {
    const app = buildApp(adminId);
    const ra = await request(app)
      .get(`/dashboard/districts/${districtId}`)
      .query({ bargainingUnit: unitA });
    const rb = await request(app)
      .get(`/dashboard/districts/${districtId}`)
      .query({ bargainingUnit: unitB });

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.body.currentContract?.bargaining_unit).toBe(unitA);
    expect(rb.body.currentContract?.bargaining_unit).toBe(unitB);
    // The frozen-UI bug returned the same contract regardless of unit.
    expect(ra.body.currentContract?.id).not.toBe(rb.body.currentContract?.id);
  });

  it("defaults to the teachers contract when no unit is given", async () => {
    const res = await request(buildApp(adminId)).get(
      `/dashboard/districts/${districtId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.currentContract?.bargaining_unit).toBe("teachers");
  });

  it("scopes provisions to the requested unit", async () => {
    const app = buildApp(adminId);
    const pa = await request(app)
      .get(`/dashboard/districts/${districtId}/provisions`)
      .query({ bargainingUnit: unitA });
    const pb = await request(app)
      .get(`/dashboard/districts/${districtId}/provisions`)
      .query({ bargainingUnit: unitB });

    expect(pa.status).toBe(200);
    expect(pb.status).toBe(200);

    const aProvs = pa.body.provisions as { contract_id: number }[];
    const bProvs = pb.body.provisions as { contract_id: number }[];
    expect(aProvs.length).toBeGreaterThan(0);
    expect(bProvs.length).toBeGreaterThan(0);

    // Map every contract referenced by the provisions back to its unit and
    // confirm each set is single-unit and matches the requested unit.
    const cmap = await db.execute(
      sql`SELECT id, bargaining_unit FROM contracts WHERE district_id = ${districtId}`,
    );
    const unitById = new Map(
      (cmap.rows as { id: number; bargaining_unit: string }[]).map((r) => [
        Number(r.id),
        r.bargaining_unit,
      ]),
    );
    for (const p of aProvs) expect(unitById.get(Number(p.contract_id))).toBe(unitA);
    for (const p of bProvs) expect(unitById.get(Number(p.contract_id))).toBe(unitB);
  });

  it("lists every CBA unit in availableUnits with teachers first", async () => {
    const res = await request(buildApp(adminId))
      .get(`/dashboard/districts/${districtId}/settlements`)
      .query({ bargainingUnit: unitA });
    expect(res.status).toBe(200);

    const avail = (res.body.availableUnits as { bargaining_unit: string }[]).map(
      (u) => u.bargaining_unit,
    );
    // The selector must list every unit that has a CBA, even one with no
    // settlement history, so the user can toggle to it.
    for (const u of contractUnits) expect(avail).toContain(u);
    // Teachers is ordered first so it is shown/selected by default.
    expect(avail[0]).toBe("teachers");
  });

  it("scopes provision medians to the requested unit", async () => {
    const app = buildApp(adminId);
    const resA = await request(app)
      .get(`/dashboard/provision-medians`)
      .query({ category: medianCategory, bargainingUnit: unitA });
    expect(resA.status).toBe(200);

    // The endpoint must compute medians from ONLY the requested unit's
    // provisions (state-wide, no county/band filter here). Compare against the
    // same computation done directly in SQL — a regression that drops the unit
    // filter would pull in other units and diverge from this.
    const expected = await db.execute(sql`
      SELECT cp.provision_key,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY cp.value_numeric) AS median_value
      FROM contract_provisions cp
      JOIN contracts c ON cp.contract_id = c.id
      JOIN districts d ON c.district_id = d.id
      WHERE cp.category = ${medianCategory}
        AND cp.value_numeric IS NOT NULL
        AND c.bargaining_unit = ${unitA}
        AND d.state = 'IL'
      GROUP BY cp.provision_key
    `);
    let compared = 0;
    for (const r of expected.rows as { provision_key: string; median_value: string | null }[]) {
      if (r.median_value == null) continue;
      expect(resA.body.medians[r.provision_key]).toBeCloseTo(parseFloat(r.median_value), 5);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);

    // When both units have provisions in this category, their medians must
    // differ — proving the benchmark is single-unit and not silently mixed.
    if (bothUnitsShareCategory) {
      const resB = await request(app)
        .get(`/dashboard/provision-medians`)
        .query({ category: medianCategory, bargainingUnit: unitB });
      expect(resB.status).toBe(200);
      expect(resA.body.medians).not.toEqual(resB.body.medians);
    }
  });
});
