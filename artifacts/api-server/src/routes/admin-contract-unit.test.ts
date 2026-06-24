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
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Admin "fix a contract's bargaining unit" endpoints (Task #158).
//
// Exercises the reassign endpoint against the real DB with an isolated, far-
// future temp district so it can't collide with live data:
//   - invalid unit -> 400
//   - unknown contract -> 404
//   - success: contract + settlements re-unit, unit_override pinned, and for an
//     uploaded doc the authoritative source_documents.bargaining_unit too
//   - no-op (same unit) -> 200 + pins it
//   - contract-key collision -> 409, no changes
//   - settlement-key collision -> 409, full rollback (nothing changed)
// ---------------------------------------------------------------------------

const adminRouter = (await import("./admin.js")).default;

const MARK = `tstunit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const UPLOAD_URL = `upload://${MARK}`;
const FILE_HASH = createHash("sha256").update(MARK).digest("hex"); // 64 hex chars

// A second uploaded doc deliberately shared by TWO contracts (Task #162). Its
// authoritative unit must survive a reassignment of one of those contracts.
const SHARED_URL = `upload://${MARK}-shared`;
const SHARED_HASH = createHash("sha256").update(`${MARK}-shared`).digest("hex");

let distId: number;
let cSuccess: number; // teachers, upload-linked -> reassign to nurses
let cColl1: number; // paraprofessionals -> reassign to food_service (collides w/ cColl2)
let cSettColl: number; // transportation -> reassign to nurses (settlement collides)
let cNoop: number; // administrators -> reassign to administrators (no-op pin)
let cShared1: number; // teachers, shares an uploaded doc with cShared2 -> reassign to nurses
let cShared2: number; // teachers, shares the same uploaded doc (must keep doc unit)

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

async function insertContract(
  unit: string,
  scope: string,
  start: string,
  sourceDocId: number | null = null,
): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO contracts (district_id, bargaining_unit, unit_scope, effective_start, source_doc_id)
    VALUES (${distId}, ${unit}, ${scope}, ${start}, ${sourceDocId})
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

async function insertSettlement(
  unit: string,
  fromY: string,
  toY: string,
  contractId: number | null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO settlements (district_id, bargaining_unit, from_year, to_year, contract_id)
    VALUES (${distId}, ${unit}, ${fromY}, ${toY}, ${contractId})
  `);
}

beforeAll(async () => {
  const d = await db.execute(sql`
    INSERT INTO districts (state, state_district_id, name, slug)
    VALUES ('IL', ${"TST" + MARK}, ${"ZZ Unit Test " + MARK}, ${"zz-unit-test-" + MARK})
    RETURNING id
  `);
  distId = Number((d.rows[0] as { id: string | number }).id);

  const sd = await db.execute(sql`
    INSERT INTO source_documents (district_id, doc_type, bargaining_unit, source_url, file_hash, source_type)
    VALUES (${distId}, 'cba_pdf', 'teachers', ${UPLOAD_URL}, ${FILE_HASH}, 'pdf')
    RETURNING id
  `);
  const sdId = Number((sd.rows[0] as { id: string | number }).id);

  // Success fixture (uploaded doc).
  cSuccess = await insertContract("teachers", "certificated", "2099-08-01", sdId);
  await insertSettlement("teachers", "2099-00", "2099-00", cSuccess);

  // Contract-collision fixture: two siblings on the same (scope, start).
  cColl1 = await insertContract("paraprofessionals", "ps", "2097-08-01");
  await insertContract("food_service", "ps", "2097-08-01");

  // Settlement-collision fixture: a standalone settlement already occupies the
  // (district, nurses, 2096-00, 2096-00) slot.
  cSettColl = await insertContract("transportation", "ts", "2096-08-01");
  await insertSettlement("transportation", "2096-00", "2096-00", cSettColl);
  await insertSettlement("nurses", "2096-00", "2096-00", null);

  // No-op fixture.
  cNoop = await insertContract("administrators", "ns", "2095-08-01");

  // Shared-doc fixture (Task #162): one uploaded doc backing TWO contracts. The
  // doc's authoritative unit must NOT be touched when one contract is reassigned.
  const sharedSd = await db.execute(sql`
    INSERT INTO source_documents (district_id, doc_type, bargaining_unit, source_url, file_hash, source_type)
    VALUES (${distId}, 'cba_pdf', 'teachers', ${SHARED_URL}, ${SHARED_HASH}, 'pdf')
    RETURNING id
  `);
  const sharedSdId = Number((sharedSd.rows[0] as { id: string | number }).id);
  cShared1 = await insertContract("teachers", "sh1", "2094-08-01", sharedSdId);
  await insertSettlement("teachers", "2094-00", "2094-00", cShared1);
  cShared2 = await insertContract("teachers", "sh2", "2093-08-01", sharedSdId);
});

afterAll(async () => {
  if (distId) {
    await db.execute(sql`DELETE FROM settlements WHERE district_id = ${distId}`);
    await db.execute(sql`DELETE FROM contracts WHERE district_id = ${distId}`);
    await db.execute(sql`DELETE FROM source_documents WHERE district_id = ${distId}`);
    await db.execute(sql`DELETE FROM districts WHERE id = ${distId}`);
  }
  await pool.end();
});

describe("PATCH /admin/contracts/:id/bargaining-unit", () => {
  it("rejects an invalid bargaining unit with 400", async () => {
    const res = await request(buildApp())
      .patch(`/admin/contracts/${cSuccess}/bargaining-unit`)
      .send({ bargainingUnit: "not_a_real_unit" });
    expect(res.status).toBe(400);
    // unchanged
    const c = await db.execute(
      sql`SELECT bargaining_unit FROM contracts WHERE id = ${cSuccess}`,
    );
    expect((c.rows[0] as { bargaining_unit: string }).bargaining_unit).toBe("teachers");
  });

  it("returns 404 for an unknown contract id", async () => {
    const res = await request(buildApp())
      .patch(`/admin/contracts/2147480000/bargaining-unit`)
      .send({ bargainingUnit: "nurses" });
    expect(res.status).toBe(404);
  });

  it("reassigns the contract, propagates to settlements + source doc, and pins it", async () => {
    const res = await request(buildApp())
      .patch(`/admin/contracts/${cSuccess}/bargaining-unit`)
      .send({ bargainingUnit: "nurses" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.bargainingUnit).toBe("nurses");
    expect(res.body.settlementsUpdated).toBe(1);

    const c = await db.execute(
      sql`SELECT bargaining_unit, unit_override FROM contracts WHERE id = ${cSuccess}`,
    );
    const crow = c.rows[0] as { bargaining_unit: string; unit_override: boolean };
    expect(crow.bargaining_unit).toBe("nurses");
    expect(crow.unit_override).toBe(true);

    const s = await db.execute(
      sql`SELECT bargaining_unit FROM settlements WHERE contract_id = ${cSuccess}`,
    );
    expect((s.rows[0] as { bargaining_unit: string }).bargaining_unit).toBe("nurses");

    // Uploaded doc's authoritative unit must follow, or re-extraction reverts.
    const sd = await db.execute(
      sql`SELECT bargaining_unit FROM source_documents WHERE source_url = ${UPLOAD_URL}`,
    );
    expect((sd.rows[0] as { bargaining_unit: string }).bargaining_unit).toBe("nurses");
  });

  it("no-ops on the same unit but pins it", async () => {
    const res = await request(buildApp())
      .patch(`/admin/contracts/${cNoop}/bargaining-unit`)
      .send({ bargainingUnit: "administrators" });
    expect(res.status).toBe(200);
    expect(res.body.unchanged).toBe(true);
    const c = await db.execute(
      sql`SELECT bargaining_unit, unit_override FROM contracts WHERE id = ${cNoop}`,
    );
    const crow = c.rows[0] as { bargaining_unit: string; unit_override: boolean };
    expect(crow.bargaining_unit).toBe("administrators");
    expect(crow.unit_override).toBe(true);
  });

  it("reassigns one contract of a shared upload doc without touching the doc's unit", async () => {
    const res = await request(buildApp())
      .patch(`/admin/contracts/${cShared1}/bargaining-unit`)
      .send({ bargainingUnit: "nurses" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.bargainingUnit).toBe("nurses");
    expect(res.body.settlementsUpdated).toBe(1);

    // The reassigned contract + its settlement re-unit and the override pins.
    const c = await db.execute(
      sql`SELECT bargaining_unit, unit_override FROM contracts WHERE id = ${cShared1}`,
    );
    const crow = c.rows[0] as { bargaining_unit: string; unit_override: boolean };
    expect(crow.bargaining_unit).toBe("nurses");
    expect(crow.unit_override).toBe(true);

    const s = await db.execute(
      sql`SELECT bargaining_unit FROM settlements WHERE contract_id = ${cShared1}`,
    );
    expect((s.rows[0] as { bargaining_unit: string }).bargaining_unit).toBe("nurses");

    // The sibling contract sharing the same doc is left alone.
    const c2 = await db.execute(
      sql`SELECT bargaining_unit FROM contracts WHERE id = ${cShared2}`,
    );
    expect((c2.rows[0] as { bargaining_unit: string }).bargaining_unit).toBe("teachers");

    // The guard: a doc shared by >1 contract keeps its authoritative unit, so a
    // re-extraction can't silently relabel the sibling contract.
    const sd = await db.execute(
      sql`SELECT bargaining_unit FROM source_documents WHERE source_url = ${SHARED_URL}`,
    );
    expect((sd.rows[0] as { bargaining_unit: string }).bargaining_unit).toBe("teachers");
  });

  it("returns 409 on a contract-key collision and changes nothing", async () => {
    const res = await request(buildApp())
      .patch(`/admin/contracts/${cColl1}/bargaining-unit`)
      .send({ bargainingUnit: "food_service" });
    expect(res.status).toBe(409);
    const c = await db.execute(
      sql`SELECT bargaining_unit, unit_override FROM contracts WHERE id = ${cColl1}`,
    );
    const crow = c.rows[0] as { bargaining_unit: string; unit_override: boolean };
    expect(crow.bargaining_unit).toBe("paraprofessionals");
    expect(crow.unit_override).toBe(false);
  });

  it("returns 409 on a settlement-key collision and rolls back fully", async () => {
    const res = await request(buildApp())
      .patch(`/admin/contracts/${cSettColl}/bargaining-unit`)
      .send({ bargainingUnit: "nurses" });
    expect(res.status).toBe(409);
    // Contract reverted (transaction rollback)…
    const c = await db.execute(
      sql`SELECT bargaining_unit, unit_override FROM contracts WHERE id = ${cSettColl}`,
    );
    const crow = c.rows[0] as { bargaining_unit: string; unit_override: boolean };
    expect(crow.bargaining_unit).toBe("transportation");
    expect(crow.unit_override).toBe(false);
    // …and its settlement is untouched.
    const s = await db.execute(
      sql`SELECT bargaining_unit FROM settlements WHERE contract_id = ${cSettColl}`,
    );
    expect((s.rows[0] as { bargaining_unit: string }).bargaining_unit).toBe("transportation");
  });
});

describe("GET /admin/districts/:id/contracts", () => {
  it("lists the district's contracts with unit + settlement count", async () => {
    const res = await request(buildApp()).get(`/admin/districts/${distId}/contracts`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.contracts)).toBe(true);
    const ids = (res.body.contracts as { id: string }[]).map((c) => String(c.id));
    expect(ids).toContain(String(cSuccess));
    const success = (res.body.contracts as { id: string; settlementCount: number }[]).find(
      (c) => String(c.id) === String(cSuccess),
    );
    expect(success?.settlementCount).toBe(1);
  });

  it("returns 404 for an unknown district", async () => {
    const res = await request(buildApp()).get(`/admin/districts/2147480000/contracts`);
    expect(res.status).toBe(404);
  });
});
