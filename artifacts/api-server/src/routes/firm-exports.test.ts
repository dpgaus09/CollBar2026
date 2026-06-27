import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Integration test for the Phase 5 work-product export routes.
//
// Runs against the REAL database (like firm-compare/firm-clauses) because the
// behavior under test — matter resolution, firm-scope authorization, and the
// citation provenance copied into the document — lives in SQL via buildMatrix /
// buildClauseCompare. ONLY object storage is mocked, with an in-memory store, so
// we can assert the durability invariant (upload before row) AND a full
// generate→persist→download round-trip without touching a real bucket.
// ---------------------------------------------------------------------------

const objectStore = new Map<string, { buf: Buffer; contentType: string }>();
const uploadBuffer = vi.fn(
  async (key: string, buf: Buffer, contentType: string) => {
    objectStore.set(key, { buf, contentType });
  },
);

vi.mock("../lib/objectStorage.js", () => ({
  uploadBuffer: (key: string, buf: Buffer, contentType: string) =>
    uploadBuffer(key, buf, contentType),
  streamObjectTo: async (
    key: string,
    res: Response,
    contentType = "application/pdf",
    disposition = "inline",
  ): Promise<boolean> => {
    const entry = objectStore.get(key);
    if (!entry) return false;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", disposition);
    res.setHeader("Content-Length", String(entry.buf.length));
    res.end(entry.buf);
    return true;
  },
  attachmentDisposition: (filename: string): string => {
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  },
}));

const { db, pool } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const exportsRouter = (await import("./exports.js")).default;
const { buildMatrix, DEFAULT_COLUMN_IDS } = await import(
  "../lib/firm-compare-model.js"
);
const { buildComparisonMemoModel } = await import("./exports/model.js");

const PDF_CT = "application/pdf";
const DOCX_CT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Session = { userId?: number; activeFirmId?: number };

function buildApp(session: Session): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Session }).session = session;
    next();
  });
  app.use("/", exportsRouter);
  return app;
}

const MARK = `tstexp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let firmA: number;
let firmB: number;
let userA: number;
let userB: number;
let clientD: number;
let peerD: number;
let matterId: number;
let citedSrc = "";

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
  clause: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO contract_provisions
      (contract_id, category, provision_key, value_numeric, unit, clause_excerpt,
       page_ref, confidence, human_verified)
    VALUES (${contractId}, 'compensation', ${key}, ${valueNumeric}, 'USD',
            ${clause}, 12, 0.95, true)
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

beforeAll(async () => {
  userA = await createUser("a");
  userB = await createUser("b");
  firmA = await createFirm("Firm A");
  firmB = await createFirm("Firm B");
  await addMember(firmA, userA);
  await addMember(firmB, userB);

  clientD = await createDistrict("Client District");
  peerD = await createDistrict("Peer District");

  await db.execute(sql`
    INSERT INTO tracked_districts (firm_id, district_id, created_by)
    VALUES (${firmA}, ${clientD}, ${userA}), (${firmA}, ${peerD}, ${userA})
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

  // Client district: fully cited contract (provisions w/ clause) + settlement.
  citedSrc = `https://example.com/${MARK}-client.pdf`;
  const clientDoc = await createSourceDoc(clientD, citedSrc);
  const clientContract = await createContract(clientD, clientDoc);
  await addProvision(
    clientContract,
    "ba_min_salary",
    42000,
    "BA Step 1 shall be $42,000.",
  );
  await addProvision(
    clientContract,
    "ma_min_salary",
    47000,
    "MA Step 1 shall be $47,000.",
  );
  await addSettlement(clientD, clientDoc);

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
    sql`DELETE FROM settlements WHERE district_id IN ${markedDistricts}`,
  );
  await db.execute(
    sql`DELETE FROM contracts WHERE district_id IN ${markedDistricts}`,
  );
  // firms cascade to tracked_districts / matters / matter_districts /
  // firm_members / firm_exports.
  await db.execute(sql`DELETE FROM firms WHERE name LIKE ${`%${MARK}%`}`);
  await db.execute(
    sql`DELETE FROM source_documents WHERE district_id IN ${markedDistricts}`,
  );
  await db.execute(sql`DELETE FROM districts WHERE name LIKE ${`%${MARK}%`}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%${MARK}%`}`);
  await pool.end();
});

async function rowFor(id: number) {
  const r = await db.execute(
    sql`SELECT * FROM firm_exports WHERE id = ${id} LIMIT 1`,
  );
  return r.rows[0] as Record<string, unknown> | undefined;
}

describe("POST /firm/exports — auth + validation", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(appAnon)
      .post("/firm/exports")
      .send({ matterId, type: "comparison_memo", format: "pdf" });
    expect(res.status).toBe(401);
  });

  it("requires a matterId", async () => {
    const res = await request(appA)
      .post("/firm/exports")
      .send({ type: "comparison_memo", format: "pdf" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid type", async () => {
    const res = await request(appA)
      .post("/firm/exports")
      .send({ matterId, type: "bogus", format: "pdf" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid format", async () => {
    const res = await request(appA)
      .post("/firm/exports")
      .send({ matterId, type: "comparison_memo", format: "rtf" });
    expect(res.status).toBe(400);
  });
});

describe("POST /firm/exports — generate each type x format", () => {
  const cases: Array<{ type: string; format: string; ct: string }> = [
    { type: "comparison_memo", format: "pdf", ct: PDF_CT },
    { type: "comparison_memo", format: "docx", ct: DOCX_CT },
    { type: "benchmark_exhibit", format: "pdf", ct: PDF_CT },
    { type: "benchmark_exhibit", format: "docx", ct: DOCX_CT },
  ];

  for (const c of cases) {
    it(`persists a row + uploads bytes for ${c.type} ${c.format}`, async () => {
      uploadBuffer.mockClear();
      const res = await request(appA)
        .post("/firm/exports")
        .send({ matterId, type: c.type, format: c.format });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe(c.type);
      expect(res.body.format).toBe(c.format);
      expect(res.body.matterId).toBe(matterId);
      expect(res.body.fileSize).toBeGreaterThan(0);

      // Upload happened with a firm-scoped key + the right content type.
      expect(uploadBuffer).toHaveBeenCalledTimes(1);
      const [key, buf, ct] = uploadBuffer.mock.calls[0];
      expect(key).toMatch(new RegExp(`^firm_exports/${firmA}/`));
      expect(key.endsWith(`.${c.format}`)).toBe(true);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(ct).toBe(c.ct);

      // The row exists, is firm-scoped, snapshots the matter + author, and points
      // at the uploaded object.
      const row = await rowFor(res.body.id);
      expect(row).toBeTruthy();
      expect(Number(row!.firm_id)).toBe(firmA);
      expect(String(row!.matter_name)).toBe(`Matter-${MARK}`);
      expect(String(row!.object_key)).toBe(key);
      expect(Number(row!.file_size)).toBe(buf.length);
      expect(String(row!.generated_by_name)).toBe("User a");
      expect(String(row!.bargaining_unit)).toBe("teachers");
    });
  }
});

describe("POST /firm/exports — clause appendix", () => {
  it("requires at least one provision key", async () => {
    const res = await request(appA)
      .post("/firm/exports")
      .send({ matterId, type: "clause_appendix", format: "pdf" });
    expect(res.status).toBe(400);
  });

  it("rejects a provision key not available in the matter scope", async () => {
    const res = await request(appA).post("/firm/exports").send({
      matterId,
      type: "clause_appendix",
      format: "pdf",
      provisionKeys: ["__not_real__"],
    });
    expect(res.status).toBe(400);
  });

  it("generates a clause appendix for available provisions", async () => {
    uploadBuffer.mockClear();
    const res = await request(appA).post("/firm/exports").send({
      matterId,
      type: "clause_appendix",
      format: "docx",
      provisionKeys: ["ba_min_salary"],
    });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe("clause_appendix");
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    const row = await rowFor(res.body.id);
    expect(row).toBeTruthy();
    expect(String(row!.type)).toBe("clause_appendix");
  });
});

describe("POST /firm/exports — durability invariant", () => {
  it("returns 502 and records NO row when the object upload fails", async () => {
    uploadBuffer.mockImplementationOnce(async () => {
      throw new Error("simulated object storage outage");
    });
    const before = await db.execute(
      sql`SELECT count(*)::int AS n FROM firm_exports WHERE firm_id = ${firmA}`,
    );
    const beforeN = Number((before.rows[0] as { n: number }).n);

    const res = await request(appA)
      .post("/firm/exports")
      .send({ matterId, type: "comparison_memo", format: "pdf" });
    expect(res.status).toBe(502);

    const after = await db.execute(
      sql`SELECT count(*)::int AS n FROM firm_exports WHERE firm_id = ${firmA}`,
    );
    expect(Number((after.rows[0] as { n: number }).n)).toBe(beforeN);
  });
});

describe("POST /firm/exports — cross-firm isolation", () => {
  it("404s another firm's matter id (no existence leak)", async () => {
    const res = await request(appB)
      .post("/firm/exports")
      .send({ matterId, type: "comparison_memo", format: "pdf" });
    expect(res.status).toBe(404);
  });
});

describe("GET /firm/exports — list", () => {
  it("returns only the caller firm's exports, newest first", async () => {
    const resA = await request(appA).get("/firm/exports");
    expect(resA.status).toBe(200);
    const list = resA.body.exports as Array<{ id: number; matterName: string }>;
    expect(list.length).toBeGreaterThan(0);
    // Every listed export belongs to firmA's matter snapshot.
    expect(list.every((e) => e.matterName === `Matter-${MARK}`)).toBe(true);

    // Firm B sees none of firm A's exports.
    const resB = await request(appB).get("/firm/exports");
    expect(resB.status).toBe(200);
    const idsB = new Set(
      (resB.body.exports as Array<{ id: number }>).map((e) => e.id),
    );
    expect(list.some((e) => idsB.has(e.id))).toBe(false);
  });
});

describe("GET /firm/exports/:id/download", () => {
  let exportId: number;
  let expectedLen: number;

  beforeAll(async () => {
    uploadBuffer.mockClear();
    const res = await request(appA)
      .post("/firm/exports")
      .send({ matterId, type: "comparison_memo", format: "pdf" });
    exportId = res.body.id;
    expectedLen = res.body.fileSize;
  });

  it("404s another firm's export id (no existence leak)", async () => {
    const res = await request(appB).get(`/firm/exports/${exportId}/download`);
    expect(res.status).toBe(404);
  });

  it("streams the stored bytes as an attachment to the owning firm", async () => {
    const res = await request(appA).get(`/firm/exports/${exportId}/download`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-disposition"]).toContain(".pdf");
    expect(Number(res.headers["content-length"])).toBe(expectedLen);
  });
});

describe("citation parity — export model matches buildMatrix provenance", () => {
  it("the memo's citations equal the matrix cells' provenance exactly", async () => {
    const result = await buildComparisonMemoModel(firmA, {
      matterId,
      unit: "teachers",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const matrix = await buildMatrix(firmA, {
      matterId,
      districtIds: null,
      unit: "teachers",
      columnIds: DEFAULT_COLUMN_IDS,
    });
    expect(matrix.ok).toBe(true);
    if (!matrix.ok) return;

    // Collect the distinct provenance tuples the matrix would show on screen.
    const expected = new Set<string>();
    for (const d of matrix.data.districts) {
      const cells = matrix.data.cells[d.districtId] ?? {};
      for (const col of matrix.data.columns) {
        const cell = cells[col.id];
        if (!cell) continue;
        expected.add(
          [d.name, cell.sourceUrl ?? "", cell.pageRef ?? "", cell.retrievedAt ?? ""].join(
            "|",
          ),
        );
      }
    }

    const got = new Set(
      result.model.citations.map((c) =>
        [c.district, c.sourceUrl ?? "", c.pageRef ?? "", c.retrievedAt ?? ""].join("|"),
      ),
    );
    expect(got).toEqual(expected);
    // And the document actually carries at least one citation.
    expect(result.model.citations.length).toBeGreaterThan(0);
  });
});
