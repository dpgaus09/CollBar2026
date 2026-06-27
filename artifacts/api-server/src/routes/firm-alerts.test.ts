import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Integration test for the Phase 6 settlement-alert routes + detection service.
//
// Runs against the REAL database (like firm-exports/firm-compare) because the
// behavior under test — firm-scope authorization, cross-firm 404 isolation, and
// the EXACTLY-ONE / idempotent detection writes into the shared global `alerts`
// table — lives entirely in SQL (firm-scope filters + partial unique indexes +
// ON CONFLICT). Nothing is mocked.
// ---------------------------------------------------------------------------

const { db, pool } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const alertsRouter = (await import("./firm-alerts.js")).default;
const { recordSettlementAlertsForDoc, recordNewContractAlert } = await import(
  "../lib/alert-detection.js"
);

type Session = { userId?: number; activeFirmId?: number };

function buildApp(session: Session): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Session }).session = session;
    next();
  });
  app.use("/", alertsRouter);
  return app;
}

const MARK = `tstalert-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let firmA: number;
let firmB: number;
let userA: number;
let userB: number;
let districtIn: number; // tracked by firm A, pre-subscribed (detection + feed)
let districtIn2: number; // tracked by firm A, NOT pre-subscribed (CRUD tests)
let districtOut: number; // tracked by nobody (out of firm A scope)
let districtB: number; // tracked by firm B (isolation)
let districtNoSub: number; // tracked by firm A, NEVER subscribed (detection neg.)

const sessionA: Session = {};
const sessionB: Session = {};
let appA: Express;
let appB: Express;
let appAnon: Express;

async function createUser(slot: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO users (name, email, role, plan, active)
    VALUES (${`User ${slot}`}, ${`${slot}-${MARK}@test.collbar`}, 'district_user', 'free', true)
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

async function createFirm(name: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO firms (name, plan_tier) VALUES (${`${name}-${MARK}`}, 'state')
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

async function addMember(firmId: number, userId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO firm_members (firm_id, user_id, role)
    VALUES (${firmId}, ${userId}, 'firm_admin')
  `);
}

async function createDistrict(name: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO districts (name, slug, state_district_id, state, county, district_type, enrollment)
    VALUES (${`${name}-${MARK}`}, ${`${name}-${MARK}`}, ${`${MARK}-${name}`}, 'IL', 'Cook', 'unit', 5000)
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

async function track(firmId: number, districtId: number, by: number) {
  await db.execute(sql`
    INSERT INTO tracked_districts (firm_id, district_id, created_by)
    VALUES (${firmId}, ${districtId}, ${by})
  `);
}

async function createSourceDoc(
  districtId: number,
  sourceUrl: string | null,
): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO source_documents
      (district_id, source_url, source_type, doc_type, storage_key, retrieved_at)
    VALUES (${districtId}, ${sourceUrl}, 'cba_pdf', 'cba_pdf',
            'local:/nonexistent/test.pdf', now())
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

async function alertCount(
  districtId: number,
  alertType: string,
): Promise<number> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS n FROM alerts
    WHERE district_id = ${districtId} AND alert_type = ${alertType}
  `);
  return Number((r.rows[0] as { n: number }).n);
}

beforeAll(async () => {
  userA = await createUser("a");
  userB = await createUser("b");
  firmA = await createFirm("Firm A");
  firmB = await createFirm("Firm B");
  await addMember(firmA, userA);
  await addMember(firmB, userB);

  districtIn = await createDistrict("In Scope");
  districtIn2 = await createDistrict("In Scope 2");
  districtOut = await createDistrict("Out Of Scope");
  districtB = await createDistrict("Firm B District");
  districtNoSub = await createDistrict("No Sub");

  await track(firmA, districtIn, userA);
  await track(firmA, districtIn2, userA);
  await track(firmA, districtNoSub, userA);
  await track(firmB, districtB, userB);

  // districtIn is pre-subscribed by firm A to BOTH events: the detection EXISTS
  // gate keys off any subscription, and the feed join needs a subscription to
  // surface the resulting alert rows.
  await db.execute(sql`
    INSERT INTO alert_subscriptions (firm_id, district_id, event_type, created_by)
    VALUES (${firmA}, ${districtIn}, 'new_settlement', ${userA}),
           (${firmA}, ${districtIn}, 'new_doc', ${userA})
    ON CONFLICT DO NOTHING
  `);

  sessionA.userId = userA;
  sessionA.activeFirmId = firmA;
  sessionB.userId = userB;
  sessionB.activeFirmId = firmB;

  appA = buildApp(sessionA);
  appB = buildApp(sessionB);
  appAnon = buildApp({});
});

afterAll(async () => {
  const markedDistricts = sql`(SELECT id FROM districts WHERE name LIKE ${`%${MARK}%`})`;
  // alerts is a shared global table with no cascade from districts — purge the
  // rows this run created before deleting the districts they reference.
  await db.execute(
    sql`DELETE FROM alerts WHERE district_id IN ${markedDistricts}`,
  );
  // firms cascade to firm_members / tracked_districts / alert_subscriptions.
  await db.execute(sql`DELETE FROM firms WHERE name LIKE ${`%${MARK}%`}`);
  await db.execute(
    sql`DELETE FROM source_documents WHERE district_id IN ${markedDistricts}`,
  );
  await db.execute(sql`DELETE FROM districts WHERE name LIKE ${`%${MARK}%`}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%${MARK}%`}`);
  await pool.end();
});

describe("POST /firm/alert-subscriptions — auth + validation", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(appAnon)
      .post("/firm/alert-subscriptions")
      .send({ districtId: districtIn2, eventType: "new_settlement" });
    expect(res.status).toBe(401);
  });

  it("requires a districtId", async () => {
    const res = await request(appA)
      .post("/firm/alert-subscriptions")
      .send({ eventType: "new_settlement" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid eventType", async () => {
    const res = await request(appA)
      .post("/firm/alert-subscriptions")
      .send({ districtId: districtIn2, eventType: "bogus" });
    expect(res.status).toBe(400);
  });

  it("normalizes the 'new_contract' alias to 'new_doc'", async () => {
    const res = await request(appA)
      .post("/firm/alert-subscriptions")
      .send({ districtId: districtIn2, eventType: "new_contract" });
    expect(res.status).toBe(201);
    expect(res.body.eventType).toBe("new_doc");
  });
});

describe("POST /firm/alert-subscriptions — scope + idempotency", () => {
  it("404s a district outside the firm's scope (no leak)", async () => {
    const res = await request(appA)
      .post("/firm/alert-subscriptions")
      .send({ districtId: districtOut, eventType: "new_settlement" });
    expect(res.status).toBe(404);
  });

  it("404s another firm's district", async () => {
    const res = await request(appA)
      .post("/firm/alert-subscriptions")
      .send({ districtId: districtB, eventType: "new_settlement" });
    expect(res.status).toBe(404);
  });

  it("creates a subscription for an in-scope district", async () => {
    const res = await request(appA)
      .post("/firm/alert-subscriptions")
      .send({ districtId: districtIn2, eventType: "new_settlement" });
    expect(res.status).toBe(201);
    expect(res.body.districtId).toBe(districtIn2);
    expect(res.body.eventType).toBe("new_settlement");
    expect(typeof res.body.id).toBe("number");
  });

  it("is idempotent — a repeat subscribe returns the same row", async () => {
    const first = await request(appA)
      .post("/firm/alert-subscriptions")
      .send({ districtId: districtIn2, eventType: "new_settlement" });
    const second = await request(appA)
      .post("/firm/alert-subscriptions")
      .send({ districtId: districtIn2, eventType: "new_settlement" });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);

    const r = await db.execute(sql`
      SELECT count(*)::int AS n FROM alert_subscriptions
      WHERE firm_id = ${firmA} AND district_id = ${districtIn2}
        AND event_type = 'new_settlement'
    `);
    expect(Number((r.rows[0] as { n: number }).n)).toBe(1);
  });
});

describe("GET /firm/alert-subscriptions — list + firm isolation", () => {
  it("returns only the caller firm's in-scope subscriptions", async () => {
    const res = await request(appA).get("/firm/alert-subscriptions");
    expect(res.status).toBe(200);
    const subs = res.body.subscriptions as Array<{ districtId: number }>;
    expect(subs.length).toBeGreaterThan(0);
    // Every listed subscription is for a firm-A district (never districtB).
    expect(subs.every((s) => s.districtId !== districtB)).toBe(true);
    expect(subs.some((s) => s.districtId === districtIn)).toBe(true);
  });

  it("firm B sees none of firm A's subscriptions", async () => {
    const res = await request(appB).get("/firm/alert-subscriptions");
    expect(res.status).toBe(200);
    const subs = res.body.subscriptions as Array<{ districtId: number }>;
    expect(subs.every((s) => s.districtId !== districtIn)).toBe(true);
    expect(subs.every((s) => s.districtId !== districtIn2)).toBe(true);
  });
});

describe("DELETE /firm/alert-subscriptions/:id — cross-firm isolation", () => {
  let subId: number;

  beforeAll(async () => {
    const res = await request(appA)
      .post("/firm/alert-subscriptions")
      .send({ districtId: districtIn2, eventType: "new_doc" });
    subId = res.body.id;
  });

  it("404s another firm's subscription id (no existence leak)", async () => {
    const res = await request(appB).delete(
      `/firm/alert-subscriptions/${subId}`,
    );
    expect(res.status).toBe(404);
    // Still present after the cross-firm attempt.
    const r = await db.execute(
      sql`SELECT count(*)::int AS n FROM alert_subscriptions WHERE id = ${subId}`,
    );
    expect(Number((r.rows[0] as { n: number }).n)).toBe(1);
  });

  it("deletes the caller firm's own subscription", async () => {
    const res = await request(appA).delete(
      `/firm/alert-subscriptions/${subId}`,
    );
    expect(res.status).toBe(200);
    const r = await db.execute(
      sql`SELECT count(*)::int AS n FROM alert_subscriptions WHERE id = ${subId}`,
    );
    expect(Number((r.rows[0] as { n: number }).n)).toBe(0);
  });
});

describe("detection — recordSettlementAlertsForDoc", () => {
  it("writes EXACTLY ONE alert for a subscribed district, and is idempotent", async () => {
    const doc = await createSourceDoc(
      districtIn,
      `https://example.com/${MARK}-settlement.pdf`,
    );
    const settlement = {
      districtId: districtIn,
      bargainingUnit: "teachers",
      fromYear: "2024-25",
      toYear: "2026-27",
    };

    const first = await recordSettlementAlertsForDoc(doc, [settlement]);
    expect(first).toBe(1);
    expect(await alertCount(districtIn, "new_settlement")).toBe(1);

    // Re-running the same ingest (re-promotion) writes nothing new.
    const second = await recordSettlementAlertsForDoc(doc, [settlement]);
    expect(second).toBe(0);
    expect(await alertCount(districtIn, "new_settlement")).toBe(1);
  });

  it("writes nothing for an unsubscribed district", async () => {
    const doc = await createSourceDoc(
      districtNoSub,
      `https://example.com/${MARK}-unsub-settlement.pdf`,
    );
    const n = await recordSettlementAlertsForDoc(doc, [
      {
        districtId: districtNoSub,
        bargainingUnit: "teachers",
        fromYear: "2024-25",
        toYear: "2026-27",
      },
    ]);
    expect(n).toBe(0);
    expect(await alertCount(districtNoSub, "new_settlement")).toBe(0);
  });
});

describe("detection — recordNewContractAlert", () => {
  it("writes EXACTLY ONE alert for a subscribed district, and is idempotent", async () => {
    const doc = await createSourceDoc(
      districtIn,
      `https://example.com/${MARK}-contract.pdf`,
    );
    const input = {
      sourceDocId: doc,
      districtId: districtIn,
      docName: `Contract ${MARK}`,
      sourceUrl: `https://example.com/${MARK}-contract.pdf`,
      fileHash: null,
    };

    const first = await recordNewContractAlert(input);
    expect(first).toBe(true);
    expect(await alertCount(districtIn, "new_doc")).toBe(1);

    const second = await recordNewContractAlert(input);
    expect(second).toBe(false);
    expect(await alertCount(districtIn, "new_doc")).toBe(1);
  });

  it("writes nothing for an unsubscribed district", async () => {
    const doc = await createSourceDoc(
      districtNoSub,
      `https://example.com/${MARK}-unsub-contract.pdf`,
    );
    const wrote = await recordNewContractAlert({
      sourceDocId: doc,
      districtId: districtNoSub,
      docName: `Contract2 ${MARK}`,
      sourceUrl: null,
      fileHash: null,
    });
    expect(wrote).toBe(false);
    expect(await alertCount(districtNoSub, "new_doc")).toBe(0);
  });
});

describe("GET /firm/alerts — feed + firm isolation", () => {
  it("surfaces the subscribed district's alerts to the owning firm", async () => {
    const res = await request(appA).get("/firm/alerts");
    expect(res.status).toBe(200);
    const alerts = res.body.alerts as Array<{
      districtId: number;
      eventType: string;
    }>;
    // The detection tests wrote a settlement + a contract alert on districtIn.
    expect(
      alerts.some(
        (a) => a.districtId === districtIn && a.eventType === "new_settlement",
      ),
    ).toBe(true);
    expect(
      alerts.some(
        (a) => a.districtId === districtIn && a.eventType === "new_doc",
      ),
    ).toBe(true);
  });

  it("firm B sees none of firm A's alerts", async () => {
    const res = await request(appB).get("/firm/alerts");
    expect(res.status).toBe(200);
    const alerts = res.body.alerts as Array<{ districtId: number }>;
    expect(alerts.every((a) => a.districtId !== districtIn)).toBe(true);
  });
});
