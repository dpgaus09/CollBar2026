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
// Integration tests for the admin review-queue OCR filter and bulk-dismiss
// safety. Unlike ask.test.ts (which mocks the db), these run against the REAL
// database because the behaviors under test live entirely in SQL:
//   * the `unreadable` filter collapses extraction_runs to the latest run per
//     source document, so a doc with an older low-quality run but a newer good
//     run must NOT be flagged — that only happens if the DISTINCT ON / ORDER BY
//     actually executes;
//   * bulk-dismiss must DELETE ordinary low-confidence rows, PRESERVE audit
//     samples, and never touch verified or high-confidence rows even when their
//     ids are passed explicitly — all enforced by the WHERE predicate.
//
// Every row we create is tagged with a unique run marker so the tests are
// robust against the ~1k unrelated rows already in the queue, and everything is
// torn down in afterAll.
// ---------------------------------------------------------------------------

const adminRouter = (await import("./admin.js")).default;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // The admin routes are guarded by requireAdminToken, which only checks
  // req.session.adminAuthenticated. Stub an authenticated admin session.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: { adminAuthenticated: boolean } }).session = {
      adminAuthenticated: true,
    };
    next();
  });
  app.use("/", adminRouter);
  return app;
}

const app = buildApp();

// Unique marker so seeded rows never collide with real data or a prior run.
const MARK = `tstrq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Captured ids for assertions + teardown.
let districtId: number;
const docIds: number[] = [];
const contractIds: number[] = [];

async function insertDistrict(): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO districts (state, state_district_id, name, slug)
    VALUES ('IL', ${`${MARK}-d`}, ${`Test District ${MARK}`}, ${MARK})
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

async function insertDoc(label: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO source_documents (district_id, doc_type, source_url)
    VALUES (${districtId}, 'cba_pdf', ${`https://example.test/${MARK}/${label}.pdf`})
    RETURNING id
  `);
  const id = Number((r.rows[0] as { id: string | number }).id);
  docIds.push(id);
  return id;
}

async function insertContract(docId: number, unitScope: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO contracts (district_id, source_doc_id, unit_scope, bargaining_unit)
    VALUES (${districtId}, ${docId}, ${`${MARK}-${unitScope}`}, 'teachers')
    RETURNING id
  `);
  const id = Number((r.rows[0] as { id: string | number }).id);
  contractIds.push(id);
  return id;
}

// ageDays: how long ago the run happened (larger = older). Used to control
// which run is "latest" per document.
async function insertRun(
  docId: number,
  ocrLowQuality: boolean,
  ageDays: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO extraction_runs (source_doc_id, status, used_ocr, ocr_low_quality, run_at)
    VALUES (${docId}, 'success', true, ${ocrLowQuality}, NOW() - (${ageDays} * INTERVAL '1 day'))
  `);
}

async function insertProvision(opts: {
  contractId: number;
  confidence: number;
  humanVerified: boolean;
  isAuditSample: boolean;
}): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO contract_provisions
      (contract_id, category, provision_key, confidence, human_verified, is_audit_sample)
    VALUES (
      ${opts.contractId}, 'compensation', ${`${MARK}-key`},
      ${opts.confidence}, ${opts.humanVerified}, ${opts.isAuditSample}
    )
    RETURNING id
  `);
  return Number((r.rows[0] as { id: string | number }).id);
}

// Page through the entire review queue (which holds ~1k unrelated rows) and
// return only the items we seeded, keyed by provision id.
async function fetchSeededQueueItems(
  query: Record<string, string>,
  seededIds: Set<string>,
): Promise<Map<string, { id: string; unreadable: boolean }>> {
  const found = new Map<string, { id: string; unreadable: boolean }>();
  let page = 1;
  let pages = 1;
  do {
    const res = await request(app)
      .get("/admin/review-queue")
      .query({ ...query, page: String(page), limit: "100" });
    expect(res.status).toBe(200);
    for (const item of res.body.items as Array<{
      id: string | number;
      unreadable: boolean;
    }>) {
      const idStr = String(item.id);
      if (seededIds.has(idStr)) {
        found.set(idStr, { id: idStr, unreadable: item.unreadable });
      }
    }
    pages = res.body.pages;
    page++;
  } while (page <= pages);
  return found;
}

// --- Seeded fixtures, populated in beforeAll ---

// Unreadable-filter docs: each gets one low-confidence provision so it shows up
// in the queue, but differs in its extraction_runs history.
let provGoodLatest: number; // older low-quality run, NEWER good run -> NOT flagged
let provBad: number; //        single low-quality run                -> flagged
let provNoRun: number; //      no extraction_runs at all             -> NOT flagged

// Bulk-dismiss-by-ids fixtures (all under one contract).
let bdOrdinary: number; //   low-conf, not verified, not audit -> DELETED
let bdAudit: number; //      low-conf audit sample             -> PRESERVED (disagree)
let bdHighConf: number; //   confidence >= 0.8                 -> UNTOUCHED
let bdVerified: number; //   already human_verified            -> UNTOUCHED

// Bulk-dismiss-by-sourceDocId fixtures.
let bdDocId: number;
let bdDocOrdinary: number; // low-conf -> DELETED via whole-doc dismiss
let bdDocHighConf: number; // high-conf -> UNTOUCHED

beforeAll(async () => {
  districtId = await insertDistrict();

  // doc with an older low-quality run + newer good run -> latest is good
  const goodDoc = await insertDoc("good-latest");
  await insertRun(goodDoc, true, 5); // older, low quality
  await insertRun(goodDoc, false, 1); // newer, good quality
  const goodContract = await insertContract(goodDoc, "good");
  provGoodLatest = await insertProvision({
    contractId: goodContract,
    confidence: 0.5,
    humanVerified: false,
    isAuditSample: false,
  });

  // doc whose latest (only) run is low quality -> flagged
  const badDoc = await insertDoc("bad");
  await insertRun(badDoc, true, 1);
  const badContract = await insertContract(badDoc, "bad");
  provBad = await insertProvision({
    contractId: badContract,
    confidence: 0.5,
    humanVerified: false,
    isAuditSample: false,
  });

  // doc with no runs -> COALESCE(..., false) -> not flagged
  const noRunDoc = await insertDoc("norun");
  const noRunContract = await insertContract(noRunDoc, "norun");
  provNoRun = await insertProvision({
    contractId: noRunContract,
    confidence: 0.5,
    humanVerified: false,
    isAuditSample: false,
  });

  // bulk-dismiss-by-ids: one contract, four provisions covering each branch
  const bdDoc = await insertDoc("bulk-ids");
  const bdContract = await insertContract(bdDoc, "bulk-ids");
  bdOrdinary = await insertProvision({
    contractId: bdContract,
    confidence: 0.5,
    humanVerified: false,
    isAuditSample: false,
  });
  bdAudit = await insertProvision({
    contractId: bdContract,
    confidence: 0.5,
    humanVerified: false,
    isAuditSample: true,
  });
  bdHighConf = await insertProvision({
    contractId: bdContract,
    confidence: 0.95,
    humanVerified: false,
    isAuditSample: false,
  });
  bdVerified = await insertProvision({
    contractId: bdContract,
    confidence: 0.5,
    humanVerified: true,
    isAuditSample: false,
  });

  // bulk-dismiss-by-sourceDocId
  bdDocId = await insertDoc("bulk-doc");
  const bdDocContract = await insertContract(bdDocId, "bulk-doc");
  bdDocOrdinary = await insertProvision({
    contractId: bdDocContract,
    confidence: 0.4,
    humanVerified: false,
    isAuditSample: false,
  });
  bdDocHighConf = await insertProvision({
    contractId: bdDocContract,
    confidence: 0.9,
    humanVerified: false,
    isAuditSample: false,
  });
});

afterAll(async () => {
  // Tear down in FK-safe order. All keyed off the seeded contracts/docs.
  if (contractIds.length) {
    await db.execute(
      sql`DELETE FROM contract_provisions WHERE contract_id IN (${sql.join(
        contractIds.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    );
    await db.execute(
      sql`DELETE FROM contracts WHERE id IN (${sql.join(
        contractIds.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    );
  }
  if (docIds.length) {
    await db.execute(
      sql`DELETE FROM extraction_runs WHERE source_doc_id IN (${sql.join(
        docIds.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    );
    await db.execute(
      sql`DELETE FROM source_documents WHERE id IN (${sql.join(
        docIds.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    );
  }
  if (districtId) {
    await db.execute(sql`DELETE FROM districts WHERE id = ${districtId}`);
  }
  await pool.end();
});

describe("GET /admin/review-queue — unreadable filter validation", () => {
  it("rejects an invalid unreadable value with 400", async () => {
    const res = await request(app)
      .get("/admin/review-queue")
      .query({ unreadable: "banana" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unreadable/i);
  });

  it("accepts 'only' and 'hide' (200)", async () => {
    const only = await request(app)
      .get("/admin/review-queue")
      .query({ unreadable: "only", limit: "1" });
    expect(only.status).toBe(200);
    const hide = await request(app)
      .get("/admin/review-queue")
      .query({ unreadable: "hide", limit: "1" });
    expect(hide.status).toBe(200);
  });
});

describe("GET /admin/review-queue — latest-per-doc OCR status", () => {
  const seeded = (): Set<string> =>
    new Set([provGoodLatest, provBad, provNoRun].map(String));

  it("unreadable=only returns only the doc whose LATEST run is low-quality", async () => {
    const items = await fetchSeededQueueItems({ unreadable: "only" }, seeded());
    // Only the bad doc is flagged.
    expect(items.has(String(provBad))).toBe(true);
    expect(items.get(String(provBad))?.unreadable).toBe(true);
    // The good-latest doc has an OLDER low-quality run but a NEWER good run,
    // so it must NOT be flagged.
    expect(items.has(String(provGoodLatest))).toBe(false);
    // A doc with no runs is never flagged.
    expect(items.has(String(provNoRun))).toBe(false);
  });

  it("unreadable=hide excludes the flagged doc and keeps the rest", async () => {
    const items = await fetchSeededQueueItems({ unreadable: "hide" }, seeded());
    expect(items.has(String(provBad))).toBe(false);
    expect(items.has(String(provGoodLatest))).toBe(true);
    expect(items.get(String(provGoodLatest))?.unreadable).toBe(false);
    expect(items.has(String(provNoRun))).toBe(true);
    expect(items.get(String(provNoRun))?.unreadable).toBe(false);
  });

  it("no filter returns all seeded items with correct unreadable flags", async () => {
    const items = await fetchSeededQueueItems({}, seeded());
    expect(items.has(String(provGoodLatest))).toBe(true);
    expect(items.has(String(provBad))).toBe(true);
    expect(items.has(String(provNoRun))).toBe(true);
    expect(items.get(String(provBad))?.unreadable).toBe(true);
    expect(items.get(String(provGoodLatest))?.unreadable).toBe(false);
    expect(items.get(String(provNoRun))?.unreadable).toBe(false);
  });
});

// Read back the live state of a provision (or null if it was deleted).
async function readProvision(id: number): Promise<{
  human_verified: boolean;
  audit_verdict: string | null;
  confidence: string;
} | null> {
  const r = await db.execute(sql`
    SELECT human_verified, audit_verdict, confidence
    FROM contract_provisions WHERE id = ${id}
  `);
  return (r.rows[0] as {
    human_verified: boolean;
    audit_verdict: string | null;
    confidence: string;
  }) ?? null;
}

describe("POST /admin/review-queue/bulk-dismiss — input validation", () => {
  it("rejects a non-array ids with 400", async () => {
    const res = await request(app)
      .post("/admin/review-queue/bulk-dismiss")
      .send({ ids: "1,2,3" });
    expect(res.status).toBe(400);
  });

  it("rejects when neither ids nor sourceDocId is provided", async () => {
    const res = await request(app)
      .post("/admin/review-queue/bulk-dismiss")
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects non-positive-integer ids with 400", async () => {
    const res = await request(app)
      .post("/admin/review-queue/bulk-dismiss")
      .send({ ids: [1, -2, 3] });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/review-queue/bulk-dismiss — safety by explicit ids", () => {
  it("deletes ordinary rows, preserves audit samples, never touches verified/high-confidence", async () => {
    const res = await request(app)
      .post("/admin/review-queue/bulk-dismiss")
      .send({ ids: [bdOrdinary, bdAudit, bdHighConf, bdVerified] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Only the single ordinary low-confidence row is deleted; only the single
    // audit sample is preserved. The high-conf and already-verified rows are
    // outside the queue scope and counted in neither bucket.
    expect(res.body.deleted).toBe(1);
    expect(res.body.preserved).toBe(1);

    // Ordinary low-confidence row: gone.
    expect(await readProvision(bdOrdinary)).toBeNull();

    // Audit sample: preserved, not deleted, marked verified + disagree.
    const audit = await readProvision(bdAudit);
    expect(audit).not.toBeNull();
    expect(audit?.human_verified).toBe(true);
    expect(audit?.audit_verdict).toBe("disagree");

    // High-confidence row: untouched even though its id was passed explicitly.
    const high = await readProvision(bdHighConf);
    expect(high).not.toBeNull();
    expect(high?.human_verified).toBe(false);
    expect(high?.audit_verdict).toBeNull();
    expect(Number(high?.confidence)).toBeCloseTo(0.95);

    // Already-verified row: untouched (no audit_verdict written).
    const verified = await readProvision(bdVerified);
    expect(verified).not.toBeNull();
    expect(verified?.human_verified).toBe(true);
    expect(verified?.audit_verdict).toBeNull();
  });
});

describe("POST /admin/review-queue/bulk-dismiss — by sourceDocId", () => {
  it("dismisses only in-scope rows of the document, leaving high-confidence rows", async () => {
    const res = await request(app)
      .post("/admin/review-queue/bulk-dismiss")
      .send({ sourceDocId: bdDocId });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.preserved).toBe(0);

    // Low-confidence row in the doc: deleted.
    expect(await readProvision(bdDocOrdinary)).toBeNull();
    // High-confidence row in the same doc: untouched.
    const high = await readProvision(bdDocHighConf);
    expect(high).not.toBeNull();
    expect(high?.human_verified).toBe(false);
  });
});
