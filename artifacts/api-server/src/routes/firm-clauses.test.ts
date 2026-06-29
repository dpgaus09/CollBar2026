import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Integration test for the Phase 4 clause search + clause compare routes.
//
// Runs against the REAL database (like firm-compare.test.ts) because the
// behavior under test — tsvector retrieval/ranking, latest-contract selection,
// the citation-required rule, and firm-scope authorization — lives in SQL and
// in the generated clause_tsv column. ONLY the Anthropic client is mocked, so
// synthesis is deterministic and we can assert the prompt is grounded in the
// retrieved verbatim clauses and that a model failure degrades to synthesis=null
// without dropping the clauses.
// ---------------------------------------------------------------------------

const messagesCreate = vi.fn(async (_args: { messages: unknown }) => ({
  content: [{ type: "text", text: "SYNTH" }],
}));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: messagesCreate } },
}));

const { db, pool } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const clausesRouter = (await import("./firm-clauses.js")).default;

type Session = { userId?: number; activeFirmId?: number };

function buildApp(session: Session): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Session }).session = session;
    next();
  });
  app.use("/", clausesRouter);
  return app;
}

const MARK = `tstclz-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let firmA: number;
let firmB: number;
let userA: number;
let userB: number;

let clientD: number; // matter client + roster — sick + grievance clauses (cited)
let peerD: number; // matter peer + roster — sick clause (cited)
let rosterD: number; // roster only — sick clause (cited)
let noCiteD: number; // roster — sick clause but NULL source_url (must be hidden)
let firmBD: number; // firm B only (cross-firm target)
let ohD: number; // OH (out-of-state) — must stay hidden even in "database" scope
let espD: number; // IL, support_staff unit — must be hidden when unit=teachers

let matterId: number;
let citedSrc = "";

// A unique token carried ONLY by the "database"-scope fixtures below. Because
// the whole-state scope searches the entire live IL corpus, asserting on it
// requires a term that no real clause contains; this keeps the assertions
// deterministic regardless of surrounding data. Alphanumeric (no hyphens) so it
// tokenizes as a single tsvector lexeme.
const DBWORD = `zdbprobe${Date.now()}`;

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

async function createDistrict(name: string, state = "IL"): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO districts (name, slug, state_district_id, state, county, district_type, enrollment)
    VALUES (${`${name}-${MARK}`}, ${`${name}-${MARK}`}, ${`${MARK}-${name}`}, ${state}, 'Cook', 'unit', 5000)
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
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

async function createContract(
  districtId: number,
  sourceDocId: number | null,
  unit = "teachers",
): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO contracts
      (district_id, bargaining_unit, unit_scope, effective_start, effective_end, source_doc_id)
    VALUES (${districtId}, ${unit}, 'standalone', '2023-08-01', '2026-07-31', ${sourceDocId})
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

async function addProvision(
  contractId: number,
  key: string,
  category: string,
  clause: string,
  opts: { humanVerified?: boolean; confidence?: number; valueNumeric?: number } = {},
): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO contract_provisions
      (contract_id, category, provision_key, value_numeric, unit, clause_excerpt,
       page_ref, confidence, human_verified)
    VALUES (${contractId}, ${category}, ${key}, ${opts.valueNumeric ?? null}, 'days',
            ${clause}, 12, ${opts.confidence ?? 0.9}, ${opts.humanVerified ?? false})
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

beforeAll(async () => {
  userA = await createUser("a");
  userB = await createUser("b");
  firmA = await createFirm("Firm A");
  firmB = await createFirm("Firm B");
  await addMember(firmA, userA);
  await addMember(firmB, userB);

  clientD = await createDistrict("Client District");
  peerD = await createDistrict("Peer District");
  rosterD = await createDistrict("Roster District");
  noCiteD = await createDistrict("NoCite District");
  firmBD = await createDistrict("FirmB District");

  await db.execute(sql`
    INSERT INTO tracked_districts (firm_id, district_id, created_by)
    VALUES (${firmA}, ${clientD}, ${userA}), (${firmA}, ${peerD}, ${userA}),
           (${firmA}, ${rosterD}, ${userA}), (${firmA}, ${noCiteD}, ${userA})
  `);
  await db.execute(sql`
    INSERT INTO tracked_districts (firm_id, district_id, created_by)
    VALUES (${firmB}, ${firmBD}, ${userB})
  `);

  const m = await db.execute(sql`
    INSERT INTO matters (firm_id, name, primary_district_id, created_by)
    VALUES (${firmA}, ${`Matter-${MARK}`}, ${clientD}, ${userA})
    RETURNING id
  `);
  matterId = Number((m.rows[0] as { id: string | number }).id);
  await db.execute(sql`
    INSERT INTO matter_districts (matter_id, district_id, role)
    VALUES (${matterId}, ${clientD}, 'client'), (${matterId}, ${peerD}, 'peer')
  `);

  // Client district: cited contract with a sick-leave clause + TWO grievance
  // rows (one human-verified, one not) so the compare best-row precedence can be
  // asserted (human_verified wins over higher confidence).
  citedSrc = `upload://${MARK}-client`;
  const clientDoc = await createSourceDoc(clientD, citedSrc);
  const clientContract = await createContract(clientD, clientDoc);
  await addProvision(
    clientContract,
    "sick_days_annual",
    "leave",
    "Each teacher shall receive twelve (12) sick days per year.",
    { humanVerified: true, confidence: 0.95, valueNumeric: 12 },
  );
  await addProvision(
    clientContract,
    "grievance_steps",
    "grievance",
    "Grievances proceed through four steps culminating in binding arbitration.",
    { humanVerified: false, confidence: 0.85, valueNumeric: 4 },
  );
  await addProvision(
    clientContract,
    "grievance_steps",
    "grievance",
    "VERIFIED: grievances proceed through three steps then mediation.",
    { humanVerified: true, confidence: 0.7, valueNumeric: 3 },
  );

  const peerDoc = await createSourceDoc(peerD, `upload://${MARK}-peer`);
  const peerContract = await createContract(peerD, peerDoc);
  await addProvision(
    peerContract,
    "sick_days_annual",
    "leave",
    "Employees earn ten (10) sick days annually.",
    { humanVerified: false, confidence: 0.6, valueNumeric: 10 },
  );

  const rosterDoc = await createSourceDoc(rosterD, `upload://${MARK}-roster`);
  const rosterContract = await createContract(rosterD, rosterDoc);
  await addProvision(
    rosterContract,
    "sick_days_annual",
    "leave",
    "Teachers accrue fifteen (15) sick leave days each school year.",
    { humanVerified: true, confidence: 0.9, valueNumeric: 15 },
  );

  // No-cite district: a matching clause whose source doc has a NULL source_url,
  // so it can never be cited and must be excluded from every result.
  const noCiteContract = await createContract(noCiteD, null);
  await addProvision(
    noCiteContract,
    "sick_days_annual",
    "leave",
    "Uncited sick days clause that must be hidden.",
    { humanVerified: true, confidence: 0.99, valueNumeric: 99 },
  );

  // Firm B district (cross-firm isolation target).
  const firmBDoc = await createSourceDoc(firmBD, `upload://${MARK}-firmb`);
  const firmBContract = await createContract(firmBD, firmBDoc);
  await addProvision(
    firmBContract,
    "sick_days_annual",
    "leave",
    "Firm B teachers receive nine (9) sick days per year.",
    { humanVerified: true, confidence: 0.9, valueNumeric: 9 },
  );

  // --- "database" (whole-state) scope fixtures -----------------------------
  // The unique DBWORD token + a dedicated provision_key isolate these rows from
  // the live IL corpus. We stamp the probe on:
  //   • clientD  — IL, in firm A's roster (teachers)
  //   • firmBD   — IL, NOT in firm A's roster (teachers) → proves database scope
  //                reaches beyond the firm's own workspace
  //   • ohD      — OH, out-of-state (teachers) → must stay hidden
  //   • espD     — IL, support_staff unit → must be hidden when unit=teachers
  const dbProbe = `Whole-state database probe clause ${DBWORD} text.`;
  await addProvision(clientContract, "database_probe", "leave", dbProbe, {
    humanVerified: true,
    confidence: 0.95,
  });
  await addProvision(firmBContract, "database_probe", "leave", dbProbe, {
    humanVerified: true,
    confidence: 0.9,
  });

  ohD = await createDistrict("OH District", "OH");
  const ohDoc = await createSourceDoc(ohD, `upload://${MARK}-oh`);
  const ohContract = await createContract(ohD, ohDoc);
  await addProvision(ohContract, "database_probe", "leave", dbProbe, {
    humanVerified: true,
    confidence: 0.9,
  });

  espD = await createDistrict("ESP District");
  const espDoc = await createSourceDoc(espD, `upload://${MARK}-esp`);
  const espContract = await createContract(espD, espDoc, "support_staff");
  await addProvision(espContract, "database_probe", "leave", dbProbe, {
    humanVerified: true,
    confidence: 0.9,
  });

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
  const markedContracts = sql`(SELECT id FROM contracts WHERE district_id IN ${markedDistricts})`;
  await db.execute(
    sql`DELETE FROM contract_provisions WHERE contract_id IN ${markedContracts}`,
  );
  await db.execute(
    sql`DELETE FROM contracts WHERE district_id IN ${markedDistricts}`,
  );
  await db.execute(sql`DELETE FROM firms WHERE name LIKE ${`%${MARK}%`}`);
  await db.execute(
    sql`DELETE FROM source_documents WHERE district_id IN ${markedDistricts}`,
  );
  await db.execute(sql`DELETE FROM districts WHERE name LIKE ${`%${MARK}%`}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%${MARK}%`}`);
  await pool.end();
});

interface Clause {
  provisionId: number;
  districtId: number;
  districtName: string;
  provisionKey: string | null;
  category: string | null;
  clauseExcerpt: string;
  sourceUrl: string | null;
  humanVerified: boolean;
}

describe("POST /firm/clause-search — auth + validation", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(appAnon)
      .post("/firm/clause-search")
      .send({ query: "sick days", scope: "all" });
    expect(res.status).toBe(401);
  });

  it("requires a non-empty query", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ scope: "all" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown category", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: "sick", scope: "tracked", category: "bogus" });
    expect(res.status).toBe(400);
  });
});

describe("POST /firm/clause-search — retrieval + scope", () => {
  it("returns verbatim, fully-cited clauses for a firm-owned matter", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: "sick days", scope: "matter", matterId, synthesize: false });
    expect(res.status).toBe(200);
    expect(res.body.matterId).toBe(matterId);
    const clauses = res.body.clauses as Clause[];
    const ids = new Set(clauses.map((c) => c.districtId));
    expect(ids.has(clientD)).toBe(true);
    expect(ids.has(peerD)).toBe(true);
    // Every returned clause is cited and verbatim.
    for (const c of clauses) {
      expect(c.sourceUrl).toBeTruthy();
      expect(c.clauseExcerpt.length).toBeGreaterThan(0);
      expect(typeof c.provisionId).toBe("number");
    }
    const client = clauses.find((c) => c.districtId === clientD)!;
    expect(client.clauseExcerpt).toBe(
      "Each teacher shall receive twelve (12) sick days per year.",
    );
  });

  it("scopes to the firm roster and excludes other firms + uncited clauses", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: "sick days", scope: "tracked", synthesize: false });
    expect(res.status).toBe(200);
    const ids = new Set((res.body.clauses as Clause[]).map((c) => c.districtId));
    expect(ids.has(clientD)).toBe(true);
    expect(ids.has(peerD)).toBe(true);
    expect(ids.has(rosterD)).toBe(true);
    // Uncited district hidden; other firm never in scope.
    expect(ids.has(noCiteD)).toBe(false);
    expect(ids.has(firmBD)).toBe(false);
  });

  it("authorizes an explicit districtIds subset of firm scope", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({
        query: "sick days",
        scope: "explicit",
        districtIds: [clientD],
        synthesize: false,
      });
    expect(res.status).toBe(200);
    const ids = new Set((res.body.clauses as Clause[]).map((c) => c.districtId));
    expect([...ids]).toEqual([clientD]);
  });

  it("rejects an explicit district outside firm scope with 403", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({
        query: "sick days",
        scope: "explicit",
        districtIds: [firmBD],
        synthesize: false,
      });
    expect(res.status).toBe(403);
  });

  it("404s another firm's matter id (no existence leak)", async () => {
    const res = await request(appB)
      .post("/firm/clause-search")
      .send({ query: "sick days", scope: "matter", matterId, synthesize: false });
    expect(res.status).toBe(404);
  });

  it("filters by category", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({
        query: "arbitration steps",
        scope: "tracked",
        category: "grievance",
        synthesize: false,
      });
    expect(res.status).toBe(200);
    const clauses = res.body.clauses as Clause[];
    expect(clauses.length).toBeGreaterThan(0);
    expect(clauses.every((c) => c.category === "grievance")).toBe(true);
  });

  it("filters by provisionKey", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({
        query: "sick",
        scope: "tracked",
        provisionKey: "sick_days_annual",
        synthesize: false,
      });
    expect(res.status).toBe(200);
    const clauses = res.body.clauses as Clause[];
    expect(clauses.length).toBeGreaterThan(0);
    expect(clauses.every((c) => c.provisionKey === "sick_days_annual")).toBe(true);
  });

  it("returns an empty result set (and no synthesis) when nothing matches", async () => {
    messagesCreate.mockClear();
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: "zzqqxnomatchterm", scope: "tracked" });
    expect(res.status).toBe(200);
    expect((res.body.clauses as Clause[]).length).toBe(0);
    expect(res.body.synthesis).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe("POST /firm/clause-search — grounded synthesis", () => {
  it("synthesizes over the retrieved verbatim clauses (grounded + cited)", async () => {
    messagesCreate.mockClear();
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: "sick days", scope: "matter", matterId });
    expect(res.status).toBe(200);
    expect(res.body.synthesis).toBe("SYNTH");
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    // The prompt is grounded: it carries the verbatim clause text + citation ids.
    const call = messagesCreate.mock.calls[0][0] as unknown as {
      messages: Array<{ content: string }>;
    };
    const prompt = call.messages[0].content;
    expect(prompt).toContain("[#");
    expect(prompt).toContain("sick days per year");
  });

  it("still returns the clauses when synthesis fails (synthesis=null)", async () => {
    messagesCreate.mockRejectedValueOnce(new Error("model down"));
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: "sick leave days", scope: "matter", matterId });
    expect(res.status).toBe(200);
    expect((res.body.clauses as Clause[]).length).toBeGreaterThan(0);
    expect(res.body.synthesis).toBeNull();
  });

  it("sends the static system prompt with an ephemeral cache breakpoint", async () => {
    messagesCreate.mockClear();
    // A unique query so the in-memory response cache doesn't short-circuit the
    // model call set up by a prior identical search.
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: "sick day", scope: "matter", matterId });
    expect(res.status).toBe(200);
    const call = messagesCreate.mock.calls[0][0] as unknown as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>;
    };
    expect(Array.isArray(call.system)).toBe(true);
    expect(call.system[0].type).toBe("text");
    expect(call.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  // NB: clause-compare uses the exact same shared synthesize() path, so the
  // cache breakpoint + 400 fallback proven here apply to it too. A separate
  // compare HTTP request is deliberately NOT added — every clause endpoint hit
  // counts against the per-user 20/min clauseAiLimiter, and the file already
  // runs near that ceiling within the limiter's 60s window.

  it("falls back to an uncached request when the proxy rejects cache_control (HTTP 400)", async () => {
    messagesCreate.mockClear();
    // First call rejects the cache_control field (request-validation 400); the
    // retry must drop the cache fields and still synthesize.
    messagesCreate.mockRejectedValueOnce(
      Object.assign(new Error("cache_control not supported"), { status: 400 }),
    );
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: "days sick", scope: "matter", matterId });
    expect(res.status).toBe(200);
    expect(res.body.synthesis).toBe("SYNTH");
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    // The retry sends the plain string system prompt (no cache breakpoint).
    const retry = messagesCreate.mock.calls[1][0] as unknown as { system: unknown };
    expect(typeof retry.system).toBe("string");
  });
});

describe("POST /firm/clause-compare", () => {
  it("lists the provision types available across the scope", async () => {
    const res = await request(appA)
      .post("/firm/clause-compare")
      .send({ scope: "matter", matterId, synthesize: false });
    expect(res.status).toBe(200);
    const types = res.body.availableTypes as Array<{
      provisionKey: string;
      districtCount: number;
    }>;
    const sick = types.find((t) => t.provisionKey === "sick_days_annual");
    expect(sick).toBeTruthy();
    expect(sick!.districtCount).toBe(2); // clientD + peerD
    expect(types.some((t) => t.provisionKey === "grievance_steps")).toBe(true);
  });

  it("returns one verbatim cited clause per district for a provision type", async () => {
    const res = await request(appA)
      .post("/firm/clause-compare")
      .send({
        scope: "matter",
        matterId,
        provisionKey: "sick_days_annual",
        synthesize: false,
      });
    expect(res.status).toBe(200);
    const clauses = res.body.clauses as Clause[];
    const ids = new Set(clauses.map((c) => c.districtId));
    expect(ids).toEqual(new Set([clientD, peerD]));
    // exactly one row per district, each cited + verbatim.
    expect(clauses).toHaveLength(2);
    for (const c of clauses) {
      expect(c.provisionKey).toBe("sick_days_annual");
      expect(c.sourceUrl).toBeTruthy();
      expect(c.clauseExcerpt.length).toBeGreaterThan(0);
    }
  });

  it("picks the human-verified row when a district has multiple", async () => {
    const res = await request(appA)
      .post("/firm/clause-compare")
      .send({
        scope: "explicit",
        districtIds: [clientD],
        provisionKey: "grievance_steps",
        synthesize: false,
      });
    expect(res.status).toBe(200);
    const clauses = res.body.clauses as Clause[];
    expect(clauses).toHaveLength(1);
    expect(clauses[0].humanVerified).toBe(true);
    expect(clauses[0].clauseExcerpt).toContain("VERIFIED");
  });
});

describe('POST /firm/clause-search — "database" (whole-state) scope', () => {
  it("the tracked roster still EXCLUDES non-roster in-state districts (baseline)", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: DBWORD, scope: "tracked", synthesize: false });
    expect(res.status).toBe(200);
    const ids = new Set((res.body.clauses as Clause[]).map((c) => c.districtId));
    expect(ids.has(clientD)).toBe(true); // in firm A roster
    expect(ids.has(firmBD)).toBe(false); // IL but NOT in firm A roster
  });

  it("spans ALL in-state districts beyond the firm roster, hides OH and other units", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({ query: DBWORD, scope: "database", synthesize: false });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("database");
    expect(res.body.matterId).toBeNull();
    const ids = new Set((res.body.clauses as Clause[]).map((c) => c.districtId));
    expect(ids.has(clientD)).toBe(true); // IL roster
    expect(ids.has(firmBD)).toBe(true); // IL, NON-roster → broader than roster
    expect(ids.has(ohD)).toBe(false); // out-of-state stays hidden
    expect(ids.has(espD)).toBe(false); // unit-scoped: support_staff filtered out
  });

  it("is unit-scoped — the same token resolves to the support_staff district under that unit", async () => {
    const res = await request(appA)
      .post("/firm/clause-search")
      .send({
        query: DBWORD,
        scope: "database",
        bargainingUnit: "support_staff",
        synthesize: false,
      });
    expect(res.status).toBe(200);
    const ids = new Set((res.body.clauses as Clause[]).map((c) => c.districtId));
    expect(ids.has(espD)).toBe(true); // support_staff contract now in scope
    expect(ids.has(clientD)).toBe(false); // teachers contract not in this unit
    expect(ids.has(firmBD)).toBe(false);
    expect(ids.has(ohD)).toBe(false);
  });
});

describe('POST /firm/clause-compare — "database" (whole-state) scope', () => {
  it("compares a provision across all in-state districts, beyond roster, OH + other units hidden", async () => {
    const res = await request(appA)
      .post("/firm/clause-compare")
      .send({
        scope: "database",
        provisionKey: "database_probe",
        synthesize: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("database");
    const ids = new Set((res.body.clauses as Clause[]).map((c) => c.districtId));
    expect(ids.has(clientD)).toBe(true);
    expect(ids.has(firmBD)).toBe(true); // beyond firm A's roster
    expect(ids.has(ohD)).toBe(false); // out-of-state hidden
    expect(ids.has(espD)).toBe(false); // unit-scoped (teachers default)
  });
});
