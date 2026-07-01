import { describe, it, expect, beforeAll, afterAll } from "vitest";

// DB-backed tests for the extraction worker pause switch (Task #247). These run
// the REAL control helpers + claimNextJob against the test database — no worker,
// no Vision. They assert:
//   1. ensureExtractionControlSchema is idempotent and seeds a default (running)
//      state.
//   2. setExtractionPaused(true/false) round-trips through isExtractionPaused so
//      the flag is DB-backed (survives a fresh read, i.e. a process restart).
//   3. While paused, claimNextJob claims NOTHING (the pause guard lives inside
//      the claim statement) and the queued job is left untouched — never failed.
//      This is the core "pause stops claiming new jobs but preserves the queue"
//      constraint. We deliberately do NOT test the resume claim via the global
//      claimNextJob: on the shared dev DB that races the live worker and would
//      mutate real jobs. When not paused the guard's NOT EXISTS is simply true,
//      so claiming reverts to the existing, already-tested behavior.
//
// The control table is a global singleton, so the suite restores the original
// paused value in afterAll to avoid leaking state into other suites / the dev DB.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  ensureExtractionControlSchema,
  isExtractionPaused,
  setExtractionPaused,
  claimNextJob,
} from "./queue";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("extraction worker pause switch", () => {
  let original = false;
  let districtId: string;

  beforeAll(async () => {
    await ensureExtractionControlSchema();
    original = await isExtractionPaused();
    const tag = `__pause_test_${Date.now()}`;
    const d = await db.execute(sql`
      INSERT INTO districts (state, state_district_id, name, slug)
      VALUES ('IL', ${tag}, 'Pause Test District', ${tag})
      RETURNING id::text AS id
    `);
    districtId = (d.rows[0] as { id: string }).id;
  });

  afterAll(async () => {
    await setExtractionPaused(original, "worker-pause.test:restore");
    if (districtId) {
      await db.execute(sql`
        DELETE FROM extraction_jobs
        WHERE source_doc_id IN (SELECT id FROM source_documents WHERE district_id = ${districtId})
      `);
      await db.execute(sql`DELETE FROM source_documents WHERE district_id = ${districtId}`);
      await db.execute(sql`DELETE FROM districts WHERE id = ${districtId}`);
    }
  });

  it("seeds a single-row control table (idempotent ensure)", async () => {
    await ensureExtractionControlSchema();
    await ensureExtractionControlSchema();
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM extraction_worker_control`);
    expect((r.rows[0] as { n: number }).n).toBe(1);
  });

  it("round-trips paused=true through a fresh DB read", async () => {
    const set = await setExtractionPaused(true, "worker-pause.test");
    expect(set).toBe(true);
    expect(await isExtractionPaused()).toBe(true);
    await setExtractionPaused(false, "worker-pause.test");
  });

  it("round-trips paused=false (resume) through a fresh DB read", async () => {
    await setExtractionPaused(true, "worker-pause.test");
    const set = await setExtractionPaused(false, "worker-pause.test");
    expect(set).toBe(false);
    expect(await isExtractionPaused()).toBe(false);
  });

  it("records who last changed the flag", async () => {
    await setExtractionPaused(true, "worker-pause.test:actor");
    const r = await db.execute(
      sql`SELECT updated_by FROM extraction_worker_control WHERE id = true`,
    );
    expect((r.rows[0] as { updated_by: string }).updated_by).toBe("worker-pause.test:actor");
    await setExtractionPaused(false, "worker-pause.test");
  });

  it("claims NOTHING while paused and leaves the queued job untouched", async () => {
    // Pause FIRST so neither this test nor the live worker can claim the job we
    // are about to insert — the pause guard blocks ALL claims globally.
    await setExtractionPaused(true, "worker-pause.test");

    const doc = await db.execute(sql`
      INSERT INTO source_documents
        (district_id, doc_type, bargaining_unit, source_url, file_hash, source_type)
      VALUES (${districtId}, 'cba_pdf', 'teachers',
              ${`https://example.test/pause.pdf`}, ${"a".repeat(64)}, 'pdf')
      RETURNING id::text AS id
    `);
    const docId = (doc.rows[0] as { id: string }).id;
    const j = await db.execute(sql`
      INSERT INTO extraction_jobs (source_doc_id, domain, status)
      VALUES (${docId}, 'cba', 'queued')
      RETURNING id::text AS id
    `);
    const jobId = (j.rows[0] as { id: string }).id;

    const claimed = await claimNextJob();
    expect(claimed).toBeNull();

    const after = await db.execute(sql`SELECT status FROM extraction_jobs WHERE id = ${jobId}`);
    expect((after.rows[0] as { status: string }).status).toBe("queued");

    await setExtractionPaused(false, "worker-pause.test");
  });
});
