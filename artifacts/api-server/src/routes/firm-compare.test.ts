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
// Integration test for the Phase 3 comparison matrix + firm document routes.
// Runs against the REAL database (like the other route tests) because the
// behavior under test — latest-contract/settlement selection, the
// citation-required rule, and firm-scope authorization — lives in SQL.
//
// Two firms are created with a unique marker, each with its own user, roster,
// matter, districts, source docs, contracts, provisions, and settlements, so
// cross-firm isolation and the "uncited value is hidden" rule can be asserted.
// Everything is torn down in afterAll (deleting firms cascades roster/matters;
// the seeded districts/docs/contracts/etc. are deleted explicitly by id).
// ---------------------------------------------------------------------------

const compareRouter = (await import("./firm-compare.js")).default;
const { signDocumentAccessToken } = await import("../lib/documentToken.js");

type Session = { userId?: number; activeFirmId?: number };

function buildApp(session: Session): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Session }).session = session;
    next();
  });
  app.use("/", compareRouter);
  return app;
}

const MARK = `tstcmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let firmA: number;
let firmB: number;
let userA: number;
let userB: number;
let userNonMember: number; // belongs to no firm — doc access is always 403

// District A: fully cited (settlement + provisions w/ source doc + clause).
let clientD: number;
// District B (peer): a settlement whose source_doc is NULL -> uncited -> hidden.
let peerD: number;
// District with an OLDER cited settlement + a NEWER uncited one: the latest
// (uncited) must win, so the district shows NO settlement (no stale fallback).
let staleD: number;
// District whose provision is cited but has a BLANK clause excerpt -> must be
// withheld (provision cells require a verbatim excerpt).
let noExcerptD: number;
// District in firm B only (cross-firm isolation target).
let firmBD: number;
// IL district in NO firm's roster/matter — backs the "Entire database" scope:
// firm members may open its upload:// doc even though it's outside their workspace.
let ilNonRosterD: number;
// OH (out-of-state) district — must stay 403 even for a firm member.
let ohD: number;

let matterId: number;
let cited_src = "";
let ilNonRosterSrc = "";
let ohSrc = "";

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

// Insert a source document. Returns its id. A null source_url models an
// uncitable document; storage_key/file_hash are present so the row is valid.
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
): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO contracts
      (district_id, bargaining_unit, unit_scope, effective_start, effective_end, source_doc_id)
    VALUES (${districtId}, 'teachers', 'standalone', '2023-08-01', '2026-07-31', ${sourceDocId})
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

async function addProvision(
  contractId: number,
  key: string,
  valueNumeric: number,
  opts: { humanVerified?: boolean; confidence?: number; clause?: string } = {},
): Promise<void> {
  await db.execute(sql`
    INSERT INTO contract_provisions
      (contract_id, category, provision_key, value_numeric, unit, clause_excerpt,
       page_ref, confidence, human_verified)
    VALUES (${contractId}, 'compensation', ${key}, ${valueNumeric}, 'USD',
            ${opts.clause ?? `Verbatim clause for ${key}.`}, 12,
            ${opts.confidence ?? 0.9}, ${opts.humanVerified ?? false})
  `);
}

async function addSettlement(
  districtId: number,
  sourceDocId: number | null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO settlements
      (district_id, bargaining_unit, from_year, to_year, base_increase_pct,
       year2_pct, year3_pct, off_schedule_payment, term_years, insurance_changed,
       method, confidence, human_verified, verified_by, page_ref, source_doc_id)
    VALUES (${districtId}, 'teachers', '2023-24', '2025-26', 3.25,
            3.50, 3.75, 1500.00, 3.0, true, 'tentative_agreement', 0.88, true,
            'internal', 7, ${sourceDocId})
  `);
}

// Settlement with explicit years + base pct, for latest-vs-citation ordering.
async function addSettlementYears(
  districtId: number,
  sourceDocId: number | null,
  fromYear: string,
  toYear: string,
  basePct: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO settlements
      (district_id, bargaining_unit, from_year, to_year, base_increase_pct,
       year2_pct, year3_pct, off_schedule_payment, term_years, insurance_changed,
       method, confidence, human_verified, verified_by, page_ref, source_doc_id)
    VALUES (${districtId}, 'teachers', ${fromYear}, ${toYear}, ${basePct},
            3.50, 3.75, 1500.00, 3.0, true, 'tentative_agreement', 0.88, true,
            'internal', 7, ${sourceDocId})
  `);
}

beforeAll(async () => {
  userA = await createUser("a");
  userB = await createUser("b");
  userNonMember = await createUser("nomember");
  firmA = await createFirm("Firm A");
  firmB = await createFirm("Firm B");
  await addMember(firmA, userA);
  await addMember(firmB, userB);

  clientD = await createDistrict("Client District");
  peerD = await createDistrict("Peer District");
  staleD = await createDistrict("Stale District");
  noExcerptD = await createDistrict("NoExcerpt District");
  firmBD = await createDistrict("FirmB District");

  // Firm A roster: client + peer + stale + no-excerpt. Firm B: its own district.
  await db.execute(sql`
    INSERT INTO tracked_districts (firm_id, district_id, created_by)
    VALUES (${firmA}, ${clientD}, ${userA}), (${firmA}, ${peerD}, ${userA}),
           (${firmA}, ${staleD}, ${userA}), (${firmA}, ${noExcerptD}, ${userA})
  `);
  await db.execute(sql`
    INSERT INTO tracked_districts (firm_id, district_id, created_by)
    VALUES (${firmB}, ${firmBD}, ${userB})
  `);

  // Firm A matter: clientD (client) + peerD (peer).
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

  // Client district: a fully-cited contract (with provisions) + cited settlement.
  cited_src = `upload://${MARK}-client`;
  const clientDoc = await createSourceDoc(clientD, cited_src);
  const clientContract = await createContract(clientD, clientDoc);
  await addProvision(clientContract, "ba_min_salary", 42000, {
    humanVerified: true,
    confidence: 0.95,
    clause: "BA Step 1 shall be $42,000.",
  });
  await addProvision(clientContract, "ma_min_salary", 47000, {
    humanVerified: false,
    confidence: 0.6,
  });
  await addProvision(clientContract, "salary_steps_count", 24);
  await addSettlement(clientD, clientDoc);

  // Peer district: a settlement with NO source doc (uncitable -> must be hidden)
  // and provisions on a contract with NO source doc (source_documents.source_url
  // is NOT NULL, so the only way to be uncitable is to have no source doc at
  // all). Both must be omitted from the matrix.
  const peerContract = await createContract(peerD, null);
  await addProvision(peerContract, "ba_min_salary", 39000, {
    humanVerified: true,
  });
  await addSettlement(peerD, null);

  // Stale district: an OLDER cited settlement plus a NEWER uncited one. The
  // latest-first selection must pick the newer (uncited) row and then withhold
  // it for lack of a citation — it must NOT fall back to the older cited value.
  const staleDoc = await createSourceDoc(staleD, `upload://${MARK}-stale`);
  await addSettlementYears(staleD, staleDoc, "2020-21", "2022-23", 2.0);
  await addSettlementYears(staleD, null, "2023-24", "2025-26", 4.0);

  // No-excerpt district: a cited contract whose provision has a BLANK clause
  // excerpt. The value is cited, but provision cells require a verbatim excerpt,
  // so the cell must be withheld.
  const noExcerptDoc = await createSourceDoc(
    noExcerptD,
    `upload://${MARK}-noexcerpt`,
  );
  const noExcerptContract = await createContract(noExcerptD, noExcerptDoc);
  await addProvision(noExcerptContract, "ba_min_salary", 41000, {
    humanVerified: true,
    confidence: 0.95,
    clause: "",
  });

  // "Entire database" doc-auth fixtures: an IL district outside every firm's
  // workspace, and an OH district. Both carry an upload:// doc. A firm member
  // may open the IL one (state == CUSTOMER_STATE) but never the OH one.
  ilNonRosterD = await createDistrict("IL NonRoster District");
  ilNonRosterSrc = `upload://${MARK}-il-nonroster`;
  await createSourceDoc(ilNonRosterD, ilNonRosterSrc);

  ohD = await createDistrict("OH District", "OH");
  ohSrc = `upload://${MARK}-oh`;
  await createSourceDoc(ohD, ohSrc);

  sessionA.userId = userA;
  sessionA.activeFirmId = firmA;
  sessionB.userId = userB;
  sessionB.activeFirmId = firmB;

  appA = buildApp(sessionA);
  appB = buildApp(sessionB);
  appAnon = buildApp({});
});

afterAll(async () => {
  // MARK-anchored, FK-ordered teardown. district-scoped rows are resolved via a
  // subquery on the marked districts (robust even if beforeAll failed partway,
  // unlike an id-list which can be empty and produce `IN ()`).
  const markedDistricts = sql`(SELECT id FROM districts WHERE name LIKE ${`%${MARK}%`})`;
  const markedContracts = sql`(SELECT id FROM contracts WHERE district_id IN ${markedDistricts})`;
  await db.execute(
    sql`DELETE FROM contract_provisions WHERE contract_id IN ${markedContracts}`,
  );
  await db.execute(
    sql`DELETE FROM settlements WHERE district_id IN ${markedDistricts}`,
  );
  await db.execute(
    sql`DELETE FROM contracts WHERE district_id IN ${markedDistricts}`,
  );
  // firms cascade to tracked_districts / matters / matter_districts / firm_members.
  await db.execute(sql`DELETE FROM firms WHERE name LIKE ${`%${MARK}%`}`);
  await db.execute(
    sql`DELETE FROM source_documents WHERE district_id IN ${markedDistricts}`,
  );
  await db.execute(sql`DELETE FROM districts WHERE name LIKE ${`%${MARK}%`}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%${MARK}%`}`);
  await pool.end();
});

describe("POST /firm/compare — auth", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(appAnon).post("/firm/compare").send({ matterId });
    expect(res.status).toBe(401);
  });

  it("requires a matterId or districtIds", async () => {
    const res = await request(appA).post("/firm/compare").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /firm/compare — matrix", () => {
  it("builds a cited matrix for a firm-owned matter", async () => {
    const res = await request(appA).post("/firm/compare").send({ matterId });
    expect(res.status).toBe(200);
    expect(res.body.matterId).toBe(matterId);

    // Districts present, client ordered before peer.
    const ids = (res.body.districts as Array<{ districtId: number; role: string }>).map(
      (d) => d.districtId,
    );
    expect(ids).toEqual([clientD, peerD]);
    expect(res.body.districts[0].role).toBe("client");

    // Client district cells are populated and carry provenance.
    const cClient = res.body.cells[String(clientD)] as Record<
      string,
      { value: unknown; sourceUrl: string | null; clauseExcerpt: string | null }
    >;
    expect(cClient["settlement.base_increase_pct"].value).toBe(3.25);
    expect(cClient["settlement.base_increase_pct"].sourceUrl).toBe(cited_src);
    expect(cClient["provision.ba_min_salary"].value).toBe(42000);
    expect(cClient["provision.ba_min_salary"].sourceUrl).toBe(cited_src);
  });

  it("returns the verbatim clause excerpt to a free-plan firm member", async () => {
    const res = await request(appA)
      .post("/firm/compare")
      .send({ matterId, columns: ["provision.ba_min_salary"] });
    expect(res.status).toBe(200);
    const cell = res.body.cells[String(clientD)]["provision.ba_min_salary"];
    expect(cell.clauseExcerpt).toBe("BA Step 1 shall be $42,000.");
    expect(cell.humanVerified).toBe(true);
  });

  it("marks an unreviewed provision as machine-extracted (human_verified=false)", async () => {
    const res = await request(appA)
      .post("/firm/compare")
      .send({ matterId, columns: ["provision.ma_min_salary"] });
    const cell = res.body.cells[String(clientD)]["provision.ma_min_salary"];
    expect(cell.value).toBe(47000);
    expect(cell.humanVerified).toBe(false);
  });

  it("never surfaces an uncited value (settlement w/o source doc, provision w/ null source_url)", async () => {
    const res = await request(appA).post("/firm/compare").send({ matterId });
    const peerCells = res.body.cells[String(peerD)] ?? {};
    // The peer's settlement has no source doc and its provision's doc has a null
    // source_url, so NO peer cell may appear.
    expect(Object.keys(peerCells)).toHaveLength(0);
  });

  it("supports an explicit districtIds request inside firm scope", async () => {
    const res = await request(appA)
      .post("/firm/compare")
      .send({ districtIds: [clientD] });
    expect(res.status).toBe(200);
    expect(res.body.matterId).toBeNull();
    expect(
      (res.body.districts as Array<{ districtId: number }>).map((d) => d.districtId),
    ).toEqual([clientD]);
  });

  it("validates the column catalog (bogus columns rejected)", async () => {
    const res = await request(appA)
      .post("/firm/compare")
      .send({ matterId, columns: ["provision.__not_real__"] });
    expect(res.status).toBe(400);
  });

  it("rejects a request that mixes valid and unknown column ids", async () => {
    const res = await request(appA)
      .post("/firm/compare")
      .send({
        matterId,
        columns: ["provision.ba_min_salary", "provision.__nope__"],
      });
    expect(res.status).toBe(400);
  });

  it("rejects providing both matterId and districtIds (XOR)", async () => {
    const res = await request(appA)
      .post("/firm/compare")
      .send({ matterId, districtIds: [clientD] });
    expect(res.status).toBe(400);
  });

  it("never falls back to an older cited settlement when the latest is uncited", async () => {
    const res = await request(appA)
      .post("/firm/compare")
      .send({
        districtIds: [staleD],
        columns: ["settlement.base_increase_pct"],
      });
    expect(res.status).toBe(200);
    // Latest settlement (2023-24→2025-26) is uncited, so the district shows NO
    // settlement cell. The older 2020-21 cited value (2.0) must NOT leak in.
    const cells = res.body.cells[String(staleD)] ?? {};
    expect(Object.keys(cells)).toHaveLength(0);
  });

  it("withholds a cited provision that has no verbatim clause excerpt", async () => {
    const res = await request(appA)
      .post("/firm/compare")
      .send({
        districtIds: [noExcerptD],
        columns: ["provision.ba_min_salary"],
      });
    expect(res.status).toBe(200);
    // The value (41000) is cited, but the clause excerpt is blank, so the
    // provision cell must be withheld rather than shown without source language.
    const cells = res.body.cells[String(noExcerptD)] ?? {};
    expect(Object.keys(cells)).toHaveLength(0);
  });
});

describe("POST /firm/compare — cross-firm isolation", () => {
  it("rejects a districtId outside the caller's firm scope with 403", async () => {
    const res = await request(appA)
      .post("/firm/compare")
      .send({ districtIds: [firmBD] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN_DISTRICT");
  });

  it("404s another firm's matter id (no existence leak)", async () => {
    const res = await request(appB).post("/firm/compare").send({ matterId });
    expect(res.status).toBe(404);
  });
});

describe("GET /firm/document — firm-scope authorization", () => {
  it("401s without a session or token", async () => {
    const res = await request(appAnon)
      .get("/firm/document")
      .query({ src: cited_src });
    expect(res.status).toBe(401);
  });

  it("403s a token for a user who belongs to no firm", async () => {
    // Firm membership is the entitlement for the document route. A user in no
    // firm is denied even for an in-state, otherwise-accessible district.
    const token = signDocumentAccessToken(userNonMember);
    const res = await request(appAnon)
      .get("/firm/document")
      .query({ src: cited_src, token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN_DISTRICT");
  });

  it("authorizes a firm member for a scoped district (404 file missing, not 403)", async () => {
    // userA's firm tracks clientD, so authorization passes; the bytes don't
    // exist in object storage in the test env, so the route reports the file is
    // missing (404) — proving we got PAST the firm-scope gate.
    const token = signDocumentAccessToken(userA);
    const res = await request(appAnon)
      .get("/firm/document")
      .query({ src: cited_src, token });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Document file missing");
  });

  it("400s a non-upload source scheme", async () => {
    const token = signDocumentAccessToken(userA);
    const res = await request(appAnon)
      .get("/firm/document")
      .query({ src: "https://example.com/x.pdf", token });
    expect(res.status).toBe(400);
  });

  it("authorizes a firm member for an in-state district OUTSIDE their workspace (Entire database)", async () => {
    // ilNonRosterD is in no firm's roster/matter, but it's in CUSTOMER_STATE, so
    // a firm member can open its doc. Passing the firm-scope gate is proven by a
    // 404 (bytes absent in the test env), not a 403.
    const token = signDocumentAccessToken(userA);
    const res = await request(appAnon)
      .get("/firm/document")
      .query({ src: ilNonRosterSrc, token });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Document file missing");
  });

  it("403s an out-of-state (OH) district even for a firm member", async () => {
    const token = signDocumentAccessToken(userA);
    const res = await request(appAnon)
      .get("/firm/document")
      .query({ src: ohSrc, token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN_DISTRICT");
  });
});
