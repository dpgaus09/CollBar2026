import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";

// END-TO-END promotion test against the REAL test database (Task #178).
//
// The other extraction-engine tests mock the store/version functions, so they
// verify queue/version/promote BOOKKEEPING but never confirm that a promote
// actually writes the live customer tables (the projection step). This test
// keeps versions.ts, queue.ts and the store functions REAL and runs them against
// the database — only the leaf extractors and PDF/source-doc IO are stubbed, so
// no Claude Vision call or PDF bytes are needed. It enqueues a job with a stubbed
// extraction payload, runs the worker (which auto-promotes the first version),
// then asserts the live salary/provisions rows match the promoted version. It
// also re-runs + manually promotes a changed version to prove a promote UPDATES
// customer data, and asserts the zero-target "needs_review" promote path.
//
// Fixtures live under a synthetic district and are removed in afterAll.

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { SalarySchedule, ExtractedContract } from "../types";

// --- Stub ONLY the leaf IO/extractors; everything else runs for real. ---------
const h = vi.hoisted(() => ({
  loadSourceDoc: vi.fn(),
  resolvePdfBuffer: vi.fn(),
  extractSalarySchedules: vi.fn(),
  extractProvisions: vi.fn(),
  verifyProvisionsAgainstText: vi.fn(() => ({ checked: 0, mismatched: 0, capped: 0 })),
  openPdf: vi.fn(async () => ({ destroy: vi.fn() })),
  deriveStatedSettlements: vi.fn(),
  extractFinalOffer: vi.fn(),
}));

vi.mock("../source-docs", () => ({
  loadSourceDoc: h.loadSourceDoc,
  resolvePdfBuffer: h.resolvePdfBuffer,
}));
vi.mock("../domains/salary", () => ({
  extractSalarySchedules: h.extractSalarySchedules,
  SALARY_PROMPT_VERSION: "salary-e2e",
}));
vi.mock("../domains/provisions", () => ({
  extractProvisions: h.extractProvisions,
  PROVISIONS_PROMPT_VERSION: "provisions-e2e",
  // provisions-store imports dedupeProvisions from this same module.
  dedupeProvisions: (x: unknown[]) => x,
}));
vi.mock("../domains/provisions-verify", () => ({
  verifyProvisionsAgainstText: h.verifyProvisionsAgainstText,
}));
vi.mock("../pdf/renderer", () => ({
  openPdf: h.openPdf,
  RENDER_VERSION: "render-e2e",
}));
vi.mock("../domains/settlements", () => ({
  deriveStatedSettlements: h.deriveStatedSettlements,
  SETTLEMENT_DERIVE_VERSION: "settlement-e2e",
}));
vi.mock("../domains/final-offers", () => ({
  extractFinalOffer: h.extractFinalOffer,
  FINAL_OFFER_PROMPT_VERSION: "final-offer-e2e",
}));

import { processJob } from "./worker";
import { enqueueJob, getJob, type ExtractionJob } from "./queue";
import {
  createVersion,
  promoteVersion,
  getPromotedVersionId,
  getVersion,
} from "./versions";

const FILE_HASH = "e".repeat(64);

// A teacher (education) salary schedule — laneLabels BA/MA make it classify as
// "teachers" so the router attaches it to the teachers contract on the doc.
function teacherSchedule(
  schoolYear: string,
  cells: Array<[string, number, string, number, number]>,
): SalarySchedule {
  return {
    scheduleName: "Teachers",
    schoolYear,
    startYear: Number(schoolYear.slice(0, 4)),
    scheduleType: "lane_grid",
    laneLabels: ["BA", "MA"],
    stepCount: 2,
    laneCount: 2,
    pageStart: 1,
    pageEnd: 1,
    minSalary: 40000,
    maxSalary: 55000,
    confidence: 0.95,
    needsReview: false,
    reviewReason: null,
    extractionMethod: "vision",
    cells: cells.map(([stepLabel, stepOrder, laneLabel, laneOrder, salaryAmount]) => ({
      stepLabel,
      stepOrder,
      laneLabel,
      laneOrder,
      salaryAmount,
      pageRef: 1,
    })),
  };
}

const V1_SCHEDULE = teacherSchedule("2025-2026", [
  ["1", 1, "BA", 1, 40000],
  ["1", 1, "MA", 2, 45000],
  ["2", 2, "BA", 1, 42000],
  ["2", 2, "MA", 2, 47000],
]);

// A DIFFERENT extraction for the same doc — a manual promote of this must
// REPLACE the live rows (delete-then-insert), proving promote updates customer
// data.
const V2_SCHEDULE = teacherSchedule("2026-2027", [
  ["1", 1, "BA", 1, 50000],
  ["1", 1, "MA", 2, 56000],
]);

const PROV_CONTRACT: ExtractedContract = {
  bargainingUnit: "teachers",
  unitScope: null,
  provisions: [
    {
      category: "compensation",
      provisionKey: "base_salary_increase",
      valueNumeric: 3.5,
      valueText: "3.5%",
      unit: "percent",
      clauseExcerpt: "Base salaries shall increase 3.5%.",
      pageRef: 2,
      confidence: 0.9,
    },
    {
      category: "leave",
      provisionKey: "sick_days",
      valueNumeric: 12,
      valueText: "12 days",
      unit: "days",
      clauseExcerpt: "Twelve (12) sick days per year.",
      pageRef: 3,
      confidence: 0.85,
    },
  ],
};

function salaryExtractOk(schedules: SalarySchedule[]) {
  return {
    ok: true,
    status: "success",
    schedules,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelVersion: "claude-e2e",
    pageCount: 1,
    pagesExtracted: [1],
    fromCache: false,
  };
}

function provisionsExtractOk(contracts: ExtractedContract[]) {
  return {
    ok: true,
    status: "success",
    contracts,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelVersion: "claude-e2e",
    pageCount: 1,
    pagesExtracted: [1],
    fromCache: false,
  };
}

interface Ids {
  districtId: string;
  docId: string;
  contractId: string;
  emptyDocId: string;
}

const ids: Partial<Ids> = {};

async function insertFixtures(): Promise<Ids> {
  const tag = `__e2e_promote_${Date.now()}`;
  const d = await db.execute(sql`
    INSERT INTO districts (state, state_district_id, name, slug)
    VALUES ('IL', ${tag}, 'E2E Promote Test District', ${tag})
    RETURNING id::text AS id
  `);
  const districtId = (d.rows[0] as { id: string }).id;

  const doc = await db.execute(sql`
    INSERT INTO source_documents
      (district_id, doc_type, bargaining_unit, source_url, file_hash, source_type)
    VALUES (${districtId}, 'cba_pdf', 'teachers',
            ${`https://example.test/${tag}.pdf`}, ${FILE_HASH}, 'pdf')
    RETURNING id::text AS id
  `);
  const docId = (doc.rows[0] as { id: string }).id;

  const c = await db.execute(sql`
    INSERT INTO contracts
      (district_id, bargaining_unit, effective_start, source_doc_id)
    VALUES (${districtId}, 'teachers', '2025-07-01', ${docId})
    RETURNING id::text AS id
  `);
  const contractId = (c.rows[0] as { id: string }).id;

  // A second doc with NO contract attached — promotion will find zero targets.
  const empty = await db.execute(sql`
    INSERT INTO source_documents
      (district_id, doc_type, bargaining_unit, source_url, file_hash, source_type)
    VALUES (${districtId}, 'cba_pdf', 'teachers',
            ${`https://example.test/${tag}-empty.pdf`}, ${"f".repeat(64)}, 'pdf')
    RETURNING id::text AS id
  `);
  const emptyDocId = (empty.rows[0] as { id: string }).id;

  return { districtId, docId, contractId, emptyDocId };
}

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("promote E2E — promoting writes the live customer tables", () => {
  beforeAll(async () => {
    const f = await insertFixtures();
    Object.assign(ids, f);

    h.loadSourceDoc.mockImplementation(async (id: string | number) => ({
      id: String(id),
      fileHash: FILE_HASH,
    }));
    h.resolvePdfBuffer.mockResolvedValue(Buffer.from("%PDF-1.4 e2e"));
  });

  afterAll(async () => {
    if (ids.districtId) {
      const did = ids.districtId;
      // Order matters: salary schedules + provisions reference contracts /
      // source_documents with NO cascade, so clear them before the parents.
      // Deleting source_documents cascades extraction_jobs/versions/promotions.
      await db.execute(sql`DELETE FROM contract_salary_schedules WHERE district_id = ${did}`);
      await db.execute(sql`
        DELETE FROM contract_provisions
        WHERE contract_id IN (SELECT id FROM contracts WHERE district_id = ${did})
      `);
      await db.execute(sql`DELETE FROM contracts WHERE district_id = ${did}`);
      await db.execute(sql`DELETE FROM source_documents WHERE district_id = ${did}`);
      await db.execute(sql`DELETE FROM districts WHERE id = ${did}`);
    }
    await pool.end();
  });

  it("enqueues a job, the worker auto-promotes, and live salary/provisions match the version", async () => {
    h.extractSalarySchedules.mockResolvedValue(salaryExtractOk([V1_SCHEDULE]));
    h.extractProvisions.mockResolvedValue(provisionsExtractOk([PROV_CONTRACT]));

    // 1) Enqueue a real job, then run it through the real worker. (We process the
    //    enqueued row directly rather than claimNextJob() so we never claim some
    //    unrelated job that happens to be queued in the dev DB.)
    const { job } = await enqueueJob({
      sourceDocId: ids.docId!,
      domain: "cba",
      requestedBy: "e2e-test",
      requestReason: "task-178 e2e",
    });
    await processJob(job as ExtractionJob);

    const done = await getJob(job.id);
    expect(done?.status).toBe("done");

    // 2) The worker recorded a version per domain AND auto-promoted both (first
    //    extraction => no prior pointer).
    const salaryVId = await getPromotedVersionId(ids.docId!, "salary");
    const provVId = await getPromotedVersionId(ids.docId!, "provisions");
    expect(salaryVId).not.toBeNull();
    expect(provVId).not.toBeNull();

    const salaryVersion = await getVersion(salaryVId!);
    const versionSchedules =
      (salaryVersion!.normalized as { schedules: SalarySchedule[] }).schedules;
    expect(versionSchedules).toHaveLength(1);
    expect(versionSchedules[0].cells).toHaveLength(4);

    // 3) The LIVE salary tables now mirror the promoted version.
    const schedRows = await db.execute(sql`
      SELECT id::text AS id, schedule_name AS "scheduleName", school_year AS "schoolYear"
      FROM contract_salary_schedules WHERE contract_id = ${ids.contractId}
    `);
    expect(schedRows.rows).toHaveLength(1);
    expect(schedRows.rows[0]).toMatchObject({
      scheduleName: "Teachers",
      schoolYear: "2025-2026",
    });
    const scheduleId = (schedRows.rows[0] as { id: string }).id;
    const cellRows = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM contract_salary_schedule_cells
      WHERE schedule_id = ${scheduleId}
    `);
    expect((cellRows.rows[0] as { n: number }).n).toBe(4);

    // 4) The LIVE provisions tables mirror the promoted provisions version.
    const provRows = await db.execute(sql`
      SELECT category, provision_key AS "provisionKey", value_numeric AS "valueNumeric"
      FROM contract_provisions WHERE contract_id = ${ids.contractId}
      ORDER BY provision_key
    `);
    expect(provRows.rows).toHaveLength(2);
    const provByKey = Object.fromEntries(
      provRows.rows.map((r) => {
        const row = r as { provisionKey: string; category: string; valueNumeric: string };
        return [row.provisionKey, row];
      }),
    );
    expect(provByKey["base_salary_increase"].category).toBe("compensation");
    expect(Number(provByKey["base_salary_increase"].valueNumeric)).toBe(3.5);
    expect(provByKey["sick_days"].category).toBe("leave");
  });

  it("manually promoting a re-run REPLACES the live rows (promote updates customer data)", async () => {
    // A fresh extraction for the same doc, recorded as a new version. Because a
    // promotion pointer already exists, the worker would NOT auto-promote — a
    // human (admin) promotes it. Promoting must re-project the new payload.
    const { version: v2 } = await createVersion({
      sourceDocId: ids.docId!,
      domain: "salary",
      normalized: { schedules: [V2_SCHEDULE] },
      summary: { scheduleCount: 1 },
      createdBy: "e2e-test",
    });

    const result = await promoteVersion(v2.id, { promotedBy: "e2e-admin" });
    expect(result.ok).toBe(true);
    expect(result.targets).toBe(1);

    // The promotion pointer now points at v2 ...
    expect(await getPromotedVersionId(ids.docId!, "salary")).toBe(v2.id);

    // ... and the LIVE salary rows reflect v2 (delete-then-insert replaced v1).
    const schedRows = await db.execute(sql`
      SELECT id::text AS id, school_year AS "schoolYear"
      FROM contract_salary_schedules WHERE contract_id = ${ids.contractId}
    `);
    expect(schedRows.rows).toHaveLength(1);
    expect((schedRows.rows[0] as { schoolYear: string }).schoolYear).toBe("2026-2027");
    const scheduleId = (schedRows.rows[0] as { id: string }).id;
    const cellRows = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM contract_salary_schedule_cells
      WHERE schedule_id = ${scheduleId}
    `);
    expect((cellRows.rows[0] as { n: number }).n).toBe(2);
  });

  it("promoting a version for a doc with NO contract targets reports the zero-target needs_review path", async () => {
    const { version } = await createVersion({
      sourceDocId: ids.emptyDocId!,
      domain: "salary",
      normalized: { schedules: [V1_SCHEDULE] },
      summary: { scheduleCount: 1 },
      createdBy: "e2e-test",
    });

    const result = await promoteVersion(version.id, { promotedBy: "e2e-admin" });
    // The version still stands (audit record) and the pointer is set, but nothing
    // was written — there is no contract to attach to. The caller surfaces this
    // as needs_review.
    expect(result.ok).toBe(true);
    expect(result.targets).toBe(0);
    expect(result.reason).toBe("no_contract_targets");
    expect(await getPromotedVersionId(ids.emptyDocId!, "salary")).toBe(version.id);
  });
});
