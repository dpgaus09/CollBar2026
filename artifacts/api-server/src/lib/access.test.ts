import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Unit tests for the shared access gate (lib/access.ts).
//
// The DB client is mocked so no real database is needed: each test scripts the
// single users-row the gate reads via loadAccess(). We mount the gate on tiny
// throwaway routes and assert the status/JSON for every plan/role combination.
// ---------------------------------------------------------------------------

const execute = vi.fn(async () => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("@workspace/db", () => ({
  db: { execute },
}));

const { gate, UPGRADE_MESSAGE, isFree } = await import("./access.js");
// The real dashboard router imports the real gate from ./access.js (NOT mocked
// here), so mounting it proves the routes are actually wired to the gate.
const dashboardRouter = (await import("../routes/dashboard.js")).default;

// The row shape loadAccess SELECTs. null userRow simulates a deleted account.
type UserRow = {
  id: number;
  role: string;
  plan: string;
  district_id: number | null;
  active: boolean;
};
let userRow: UserRow | null = null;
let sessionUserId: number | undefined;

beforeEach(() => {
  execute.mockReset();
  execute.mockImplementation(async () => ({ rows: userRow ? [userRow] : [] }));
  userRow = null;
  sessionUserId = undefined;
});

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: sessionUserId,
    };
    next();
  });
  // Paid-only route, and an own-district-scoped route with an :id param.
  app.get("/paid", gate({ paid: true }), (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/district/:id", gate({ ownDistrict: true }), (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/district/:id/paid", gate({ ownDistrict: true, paid: true }), (_req, res) => {
    res.json({ ok: true });
  });
  // Shared aggregate-median style route: free users may only filter by their
  // own district's county/band.
  app.get("/medians", gate({ ownFilters: true }), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

// A second app mounting the REAL dashboard router (which imports the real,
// un-mocked gate) so we can prove the routes are actually wired to it.
function buildDashboardApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: sessionUserId,
    };
    next();
  });
  app.use("/api", dashboardRouter);
  return app;
}

const app = buildApp();

describe("isFree", () => {
  it("treats a non-admin on the free plan as free", () => {
    expect(isFree({ userId: 1, role: "district_user", plan: "free", districtId: 1, active: true })).toBe(true);
  });
  it("never gates admins, even on the free plan", () => {
    expect(isFree({ userId: 1, role: "admin", plan: "free", districtId: null, active: true })).toBe(false);
  });
  it("never gates pro customers", () => {
    expect(isFree({ userId: 1, role: "district_user", plan: "pro", districtId: 1, active: true })).toBe(false);
  });
});

describe("gate – authentication", () => {
  it("401 when there is no session", async () => {
    const res = await request(app).get("/paid");
    expect(res.status).toBe(401);
  });

  it("401 when the user no longer exists in the DB", async () => {
    sessionUserId = 99;
    userRow = null;
    const res = await request(app).get("/paid");
    expect(res.status).toBe(401);
  });

  it("401 when the account is deactivated", async () => {
    sessionUserId = 7;
    userRow = { id: 7, role: "district_user", plan: "pro", district_id: 5, active: false };
    const res = await request(app).get("/paid");
    expect(res.status).toBe(401);
  });

  it("500 when the DB read throws", async () => {
    sessionUserId = 7;
    execute.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).get("/paid");
    expect(res.status).toBe(500);
  });
});

describe("gate({ paid: true })", () => {
  it("403 with the verbatim upgrade message for a free customer", async () => {
    sessionUserId = 1;
    userRow = { id: 1, role: "district_user", plan: "free", district_id: 3, active: true };
    const res = await request(app).get("/paid");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "PAID_FEATURE", message: UPGRADE_MESSAGE });
  });

  it("200 for a pro customer", async () => {
    sessionUserId = 2;
    userRow = { id: 2, role: "district_user", plan: "pro", district_id: 3, active: true };
    const res = await request(app).get("/paid");
    expect(res.status).toBe(200);
  });

  it("200 for an admin on the free plan", async () => {
    sessionUserId = 3;
    userRow = { id: 3, role: "admin", plan: "free", district_id: null, active: true };
    const res = await request(app).get("/paid");
    expect(res.status).toBe(200);
  });
});

describe("gate({ ownDistrict: true })", () => {
  it("200 when a free customer requests their own district", async () => {
    sessionUserId = 1;
    userRow = { id: 1, role: "district_user", plan: "free", district_id: 42, active: true };
    const res = await request(app).get("/district/42");
    expect(res.status).toBe(200);
  });

  it("403 with the upgrade message for a different district", async () => {
    sessionUserId = 1;
    userRow = { id: 1, role: "district_user", plan: "free", district_id: 42, active: true };
    const res = await request(app).get("/district/43");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "FORBIDDEN_DISTRICT", message: UPGRADE_MESSAGE });
  });

  it("400 on a non-numeric district id for a free customer", async () => {
    sessionUserId = 1;
    userRow = { id: 1, role: "district_user", plan: "free", district_id: 42, active: true };
    const res = await request(app).get("/district/abc");
    expect(res.status).toBe(400);
  });

  it("200 for a pro customer requesting any district", async () => {
    sessionUserId = 2;
    userRow = { id: 2, role: "district_user", plan: "pro", district_id: 42, active: true };
    const res = await request(app).get("/district/999");
    expect(res.status).toBe(200);
  });
});

describe("gate({ ownDistrict: true, paid: true })", () => {
  it("403 (paid) for a free customer even on their own district", async () => {
    sessionUserId = 1;
    userRow = { id: 1, role: "district_user", plan: "free", district_id: 42, active: true };
    const res = await request(app).get("/district/42/paid");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "PAID_FEATURE", message: UPGRADE_MESSAGE });
  });

  it("200 for a pro customer", async () => {
    sessionUserId = 2;
    userRow = { id: 2, role: "district_user", plan: "pro", district_id: 42, active: true };
    const res = await request(app).get("/district/100/paid");
    expect(res.status).toBe(200);
  });
});

describe("gate({ ownFilters: true })", () => {
  // A free user assigned to district 1 (Cook county, 3000 enrollment -> "large").
  const freeUser = { id: 1, role: "district_user", plan: "free", district_id: 1, active: true };
  const ownDistrict = { county: "Cook", enrollment: 3000 };

  it("200 with no county/band filter (statewide aggregate)", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute.mockResolvedValueOnce({ rows: [freeUser] });
    const res = await request(app).get("/medians");
    expect(res.status).toBe(200);
  });

  it("200 when filtering by the free user's OWN county", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute
      .mockResolvedValueOnce({ rows: [freeUser] })
      .mockResolvedValueOnce({ rows: [ownDistrict] });
    const res = await request(app).get("/medians?county=Cook");
    expect(res.status).toBe(200);
  });

  it("200 when filtering by the free user's OWN enrollment band", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute
      .mockResolvedValueOnce({ rows: [freeUser] })
      .mockResolvedValueOnce({ rows: [ownDistrict] });
    const res = await request(app).get("/medians?band=large");
    expect(res.status).toBe(200);
  });

  it("403 when filtering by a DIFFERENT county", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute
      .mockResolvedValueOnce({ rows: [freeUser] })
      .mockResolvedValueOnce({ rows: [ownDistrict] });
    const res = await request(app).get("/medians?county=DuPage");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "FORBIDDEN_DISTRICT", message: UPGRADE_MESSAGE });
  });

  it("403 when filtering by a DIFFERENT enrollment band", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute
      .mockResolvedValueOnce({ rows: [freeUser] })
      .mockResolvedValueOnce({ rows: [ownDistrict] });
    const res = await request(app).get("/medians?band=tiny");
    expect(res.status).toBe(403);
  });

  it("403 when a free user has no assigned district but filters", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute.mockResolvedValueOnce({
      rows: [{ id: 1, role: "district_user", plan: "free", district_id: null, active: true }],
    });
    const res = await request(app).get("/medians?county=Cook");
    expect(res.status).toBe(403);
  });

  it("200 for a pro customer filtering by ANY county", async () => {
    sessionUserId = 2;
    execute.mockReset();
    execute.mockResolvedValueOnce({
      rows: [{ id: 2, role: "district_user", plan: "pro", district_id: 1, active: true }],
    });
    const res = await request(app).get("/medians?county=DuPage&band=tiny");
    expect(res.status).toBe(200);
  });
});

// Mounting the real dashboard router proves the routes are wired to the real
// gate (not a test double), so a free user is blocked at the API even by direct
// URL. These free-user requests short-circuit inside the gate, so the route
// handlers' own DB queries never run.
describe("dashboard routes are wired to the real gate", () => {
  const dashApp = buildDashboardApp();
  const freeUser = { id: 1, role: "district_user", plan: "free", district_id: 1, active: true };

  it("403 (paid) for a free user hitting /api/dashboard/comparables", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute.mockResolvedValueOnce({ rows: [freeUser] });
    const res = await request(dashApp).get("/api/dashboard/comparables");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "PAID_FEATURE", message: UPGRADE_MESSAGE });
  });

  it("403 (own-district) for a free user requesting another district's detail", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute.mockResolvedValueOnce({ rows: [freeUser] });
    const res = await request(dashApp).get("/api/dashboard/districts/999");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "FORBIDDEN_DISTRICT", message: UPGRADE_MESSAGE });
  });

  it("403 for a free user pulling medians for a county that isn't theirs", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute
      .mockResolvedValueOnce({ rows: [freeUser] })
      .mockResolvedValueOnce({ rows: [{ county: "Cook", enrollment: 3000 }] });
    const res = await request(dashApp).get("/api/dashboard/medians?county=DuPage");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "FORBIDDEN_DISTRICT", message: UPGRADE_MESSAGE });
  });

  // Key Clauses is a paid feature. Its full data endpoint must 403 a free user
  // even for their OWN district, so the paywall can't be bypassed by direct API.
  const proUser = { id: 2, role: "district_user", plan: "pro", district_id: 1, active: true };

  it("403 (paid) for a free user hitting their OWN district's /clauses", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute.mockResolvedValueOnce({ rows: [freeUser] });
    const res = await request(dashApp).get("/api/dashboard/districts/1/clauses");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "PAID_FEATURE", message: UPGRADE_MESSAGE });
  });

  it("200 for a pro user hitting /clauses (full excerpts returned)", async () => {
    sessionUserId = 2;
    execute.mockReset();
    execute
      .mockResolvedValueOnce({ rows: [proUser] }) // loadAccess
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] }) // isCustomerDistrict
      .mockResolvedValueOnce({ rows: [{ id: 9, clause_excerpt: "verbatim clause text" }] });
    const res = await request(dashApp).get("/api/dashboard/districts/1/clauses");
    expect(res.status).toBe(200);
    expect(res.body.provisions[0].clause_excerpt).toBe("verbatim clause text");
  });

  // The Overview's /provisions stays readable for a free user's own district,
  // but the verbatim clause text (the paid Key Clauses content) is stripped
  // while the summary values remain.
  it("strips clause_excerpt for a free user on /provisions, keeps values", async () => {
    sessionUserId = 1;
    execute.mockReset();
    execute
      .mockResolvedValueOnce({ rows: [freeUser] }) // loadAccess
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] }) // isCustomerDistrict
      .mockResolvedValueOnce({
        rows: [
          {
            id: 9,
            provision_key: "starting_salary",
            value_numeric: "40000",
            clause_excerpt: "verbatim clause text",
          },
        ],
      });
    const res = await request(dashApp).get("/api/dashboard/districts/1/provisions");
    expect(res.status).toBe(200);
    expect(res.body.provisions[0].clause_excerpt).toBeNull();
    expect(res.body.provisions[0].value_numeric).toBe("40000");
  });

  it("keeps clause_excerpt for a pro user on /provisions", async () => {
    sessionUserId = 2;
    execute.mockReset();
    execute
      .mockResolvedValueOnce({ rows: [proUser] }) // loadAccess
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] }) // isCustomerDistrict
      .mockResolvedValueOnce({ rows: [{ id: 9, clause_excerpt: "verbatim clause text" }] });
    const res = await request(dashApp).get("/api/dashboard/districts/1/provisions");
    expect(res.status).toBe(200);
    expect(res.body.provisions[0].clause_excerpt).toBe("verbatim clause text");
  });
});
