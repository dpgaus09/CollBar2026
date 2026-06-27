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
// Integration test for the firm workspace roster & matters routes (Phase 2).
// Runs against the REAL database (like the other route tests) because the
// behavior under test — firm-scoped reads/writes, the client/peer role
// invariant, and cross-firm isolation — lives in SQL.
//
// Two firms are created with a unique marker so cross-firm isolation can be
// asserted, and everything is torn down in afterAll (deleting the firms cascades
// to tracked_districts / matters / matter_districts).
// ---------------------------------------------------------------------------

const mattersRouter = (await import("./matters.js")).default;

type Session = {
  userId?: number;
  activeFirmId?: number;
  activeMatterId?: number | null;
  firmRole?: string;
};

// Each app is bound to a single shared, mutable session object so session
// mutations (e.g. setting the active matter) persist across requests, exactly
// as they would behind a real session store.
function buildApp(session: Session): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Session }).session = session;
    next();
  });
  app.use("/", mattersRouter);
  return app;
}

const MARK = `tstmatters-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let firmA: number;
let firmB: number;
let userA: number;
let userB: number;
let districtIds: number[] = [];
let clientD: number;
let peer1: number;
let peer2: number;
let peer3: number;
let soloD: number;
let clientName: string;

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

beforeAll(async () => {
  userA = await createUser("a");
  userB = await createUser("b");
  firmA = await createFirm("Firm A");
  firmB = await createFirm("Firm B");
  await addMember(firmA, userA);
  await addMember(firmB, userB);

  const dr = await db.execute(sql`
    SELECT id, name FROM districts ORDER BY id LIMIT 5
  `);
  const rows = dr.rows as Array<{ id: string | number; name: string }>;
  districtIds = rows.map((r) => Number(r.id));
  [clientD, peer1, peer2, peer3, soloD] = districtIds;
  clientName = String(rows[0].name);

  sessionA.userId = userA;
  sessionA.activeFirmId = firmA;
  sessionB.userId = userB;
  sessionB.activeFirmId = firmB;

  appA = buildApp(sessionA);
  appB = buildApp(sessionB);
  appAnon = buildApp({});
});

afterAll(async () => {
  // Deleting the firms cascades to tracked_districts / matters / matter_districts.
  await db.execute(sql`DELETE FROM firms WHERE name LIKE ${`%${MARK}%`}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%${MARK}%`}`);
  await pool.end();
});

describe("firm matters routes — auth", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(appAnon).get("/firm/matters");
    expect(res.status).toBe(401);
  });
});

describe("firm roster CRUD", () => {
  it("adds, lists, and removes a tracked district", async () => {
    const add = await request(appA)
      .post("/firm/roster")
      .send({ districtId: soloD, label: "Lead: J. Smith" });
    expect(add.status).toBe(201);

    const list = await request(appA).get("/firm/roster");
    expect(list.status).toBe(200);
    const row = (list.body.roster as Array<{ districtId: number; label: string }>).find(
      (r) => r.districtId === soloD,
    );
    expect(row).toBeTruthy();
    expect(row?.label).toBe("Lead: J. Smith");

    const del = await request(appA).delete(`/firm/roster/${soloD}`);
    expect(del.status).toBe(204);

    const after = await request(appA).get("/firm/roster");
    expect(
      (after.body.roster as Array<{ districtId: number }>).some(
        (r) => r.districtId === soloD,
      ),
    ).toBe(false);
  });

  it("rejects a non-existent district", async () => {
    const res = await request(appA)
      .post("/firm/roster")
      .send({ districtId: 999_999_999 });
    expect(res.status).toBe(404);
  });
});

describe("firm district search", () => {
  it("returns matches for a >=2 char query and empty for short queries", async () => {
    const ok = await request(appA).get(
      `/firm/districts/search?q=${encodeURIComponent(clientName.slice(0, 4))}`,
    );
    expect(ok.status).toBe(200);
    expect(
      (ok.body.districts as Array<{ id: number }>).some((d) => d.id === clientD),
    ).toBe(true);

    const short = await request(appA).get("/firm/districts/search?q=a");
    expect(short.status).toBe(200);
    expect(short.body.districts).toEqual([]);
  });
});

describe("firm matters lifecycle", () => {
  let matterId: number;

  it("creates a matter with a client and peers (and back-fills the roster)", async () => {
    const res = await request(appA).post("/firm/matters").send({
      name: "Test Matter",
      primaryDistrictId: clientD,
      peerDistrictIds: [peer1, peer2],
    });
    expect(res.status).toBe(201);
    const m = res.body.matter as {
      id: number;
      primaryDistrictId: number;
      districts: Array<{ districtId: number; role: string }>;
    };
    matterId = m.id;
    expect(m.primaryDistrictId).toBe(clientD);
    expect(m.districts.filter((d) => d.role === "client")).toHaveLength(1);
    expect(m.districts.filter((d) => d.role === "peer")).toHaveLength(2);

    // The matter's districts are auto-tracked on the firm roster.
    const roster = await request(appA).get("/firm/roster");
    const ids = (roster.body.roster as Array<{ districtId: number }>).map(
      (r) => r.districtId,
    );
    expect(ids).toEqual(expect.arrayContaining([clientD, peer1, peer2]));
  });

  it("lists the matter with a peer count and client name", async () => {
    const res = await request(appA).get("/firm/matters");
    expect(res.status).toBe(200);
    const m = (res.body.matters as Array<{ id: number; peerCount: number; primaryDistrictName: string | null }>).find(
      (x) => x.id === matterId,
    );
    expect(m).toBeTruthy();
    expect(m?.peerCount).toBe(2);
    expect(m?.primaryDistrictName).toBe(clientName);
  });

  it("renames and archives via PUT", async () => {
    const res = await request(appA)
      .put(`/firm/matters/${matterId}`)
      .send({ name: "Renamed Matter", status: "archived" });
    expect(res.status).toBe(200);
    expect(res.body.matter.name).toBe("Renamed Matter");
    expect(res.body.matter.status).toBe("archived");

    const bad = await request(appA)
      .put(`/firm/matters/${matterId}`)
      .send({ status: "bogus" });
    expect(bad.status).toBe(400);
  });

  it("attaches and detaches peer districts", async () => {
    const attach = await request(appA)
      .post(`/firm/matters/${matterId}/districts`)
      .send({ districtId: peer3, role: "peer" });
    expect(attach.status).toBe(200);
    expect(
      (attach.body.matter.districts as Array<{ districtId: number; role: string }>).filter(
        (d) => d.role === "peer",
      ),
    ).toHaveLength(3);

    const detach = await request(appA).delete(
      `/firm/matters/${matterId}/districts/${peer1}`,
    );
    expect(detach.status).toBe(200);
    const peers = (detach.body.matter.districts as Array<{ districtId: number; role: string }>).filter(
      (d) => d.role === "peer",
    );
    expect(peers).toHaveLength(2);
    expect(peers.some((d) => d.districtId === peer1)).toBe(false);
  });

  it("reassigns the client and keeps exactly one client row", async () => {
    // Promote peer2 to client; the old client (clientD) is dropped from the role
    // set and primary_district_id is repointed.
    const res = await request(appA)
      .post(`/firm/matters/${matterId}/districts`)
      .send({ districtId: peer2, role: "client" });
    expect(res.status).toBe(200);
    const districts = res.body.matter.districts as Array<{
      districtId: number;
      role: string;
    }>;
    expect(res.body.matter.primaryDistrictId).toBe(peer2);
    const clients = districts.filter((d) => d.role === "client");
    expect(clients).toHaveLength(1);
    expect(clients[0].districtId).toBe(peer2);
  });

  it("refuses to add the current client as a peer", async () => {
    const res = await request(appA)
      .post(`/firm/matters/${matterId}/districts`)
      .send({ districtId: peer2, role: "peer" });
    expect(res.status).toBe(400);
  });

  it("detaching the client clears primary_district_id atomically", async () => {
    // peer2 is the current client; detaching it must drop the client row AND
    // null primary_district_id together (no half-applied dual-storage state).
    const res = await request(appA).delete(
      `/firm/matters/${matterId}/districts/${peer2}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.matter.primaryDistrictId).toBeNull();
    expect(
      (res.body.matter.districts as Array<{ role: string }>).filter(
        (d) => d.role === "client",
      ),
    ).toHaveLength(0);
  });

  it("sets and clears the active matter on the session", async () => {
    const set = await request(appA)
      .post("/firm/active-matter")
      .send({ matterId });
    expect(set.status).toBe(200);
    expect(set.body.matter.id).toBe(matterId);
    expect(sessionA.activeMatterId).toBe(matterId);

    const get = await request(appA).get("/firm/active-matter");
    expect(get.body.matter.id).toBe(matterId);

    const clear = await request(appA).post("/firm/active-matter").send({ matterId: null });
    expect(clear.status).toBe(200);
    expect(clear.body.matter).toBeNull();
    expect(sessionA.activeMatterId).toBeNull();
  });

  it("isolates matters across firms (no cross-firm read or write)", async () => {
    // Firm B cannot see Firm A's matter in its list…
    const list = await request(appB).get("/firm/matters");
    expect(
      (list.body.matters as Array<{ id: number }>).some((m) => m.id === matterId),
    ).toBe(false);

    // …nor read, update, delete, attach, or detach it by id.
    expect((await request(appB).get(`/firm/matters/${matterId}`)).status).toBe(404);
    expect(
      (await request(appB).put(`/firm/matters/${matterId}`).send({ name: "hax" })).status,
    ).toBe(404);
    expect(
      (await request(appB)
        .post(`/firm/matters/${matterId}/districts`)
        .send({ districtId: soloD, role: "peer" })).status,
    ).toBe(404);
    expect(
      (await request(appB).delete(`/firm/matters/${matterId}/districts/${peer2}`)).status,
    ).toBe(404);
    expect((await request(appB).delete(`/firm/matters/${matterId}`)).status).toBe(404);

    // Setting it active from Firm B is rejected.
    expect(
      (await request(appB).post("/firm/active-matter").send({ matterId })).status,
    ).toBe(404);
  });

  it("deletes the matter", async () => {
    const del = await request(appA).delete(`/firm/matters/${matterId}`);
    expect(del.status).toBe(204);
    const get = await request(appA).get(`/firm/matters/${matterId}`);
    expect(get.status).toBe(404);
  });
});
