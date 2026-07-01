import { describe, it, expect, beforeAll, afterAll } from "vitest";

// DB-backed tests for interrupted-job recovery (the "recovered from interrupted
// run" false-failure fix). These run the REAL queue functions against the test
// database — no worker, no Vision. They assert:
//   1. recoverStaleJobs re-queues an orphaned 'running' job, REFUNDS the
//      claim-time attempt (so a restart never consumes the genuine budget), and
//      bumps recovery_count.
//   2. recoverStaleJobs FAILS a job once recovery_count would exceed
//      MAX_RECOVERIES (a job that repeatedly crashes the process can't loop
//      forever and wedge the single-concurrency queue).
//   3. requeueInterruptedJobs re-queues the interrupted + transient-DB-error
//      backlog, at most ONE failed row per doc, skips docs that already have an
//      active job, and leaves genuine content failures alone.
//
// Fixtures live under a synthetic district and are removed in afterAll.

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  recoverStaleJobs,
  requeueInterruptedJobs,
  ensureQueueRecoverySchema,
  MAX_RECOVERIES,
} from "./queue";

const hasDb = !!process.env.DATABASE_URL;

interface JobState {
  status: string;
  attempts: number;
  recoveryCount: number;
  error: string | null;
}

let districtId: string;

async function insertDoc(tag: string, hashChar: string): Promise<string> {
  const doc = await db.execute(sql`
    INSERT INTO source_documents
      (district_id, doc_type, bargaining_unit, source_url, file_hash, source_type)
    VALUES (${districtId}, 'cba_pdf', 'teachers',
            ${`https://example.test/${tag}.pdf`}, ${hashChar.repeat(64)}, 'pdf')
    RETURNING id::text AS id
  `);
  return (doc.rows[0] as { id: string }).id;
}

async function insertJob(opts: {
  docId: string;
  status: string;
  attempts?: number;
  recoveryCount?: number;
  error?: string | null;
}): Promise<string> {
  const j = await db.execute(sql`
    INSERT INTO extraction_jobs
      (source_doc_id, domain, status, attempts, recovery_count, error)
    VALUES (${opts.docId}, 'cba', ${opts.status},
            ${opts.attempts ?? 0}, ${opts.recoveryCount ?? 0}, ${opts.error ?? null})
    RETURNING id::text AS id
  `);
  return (j.rows[0] as { id: string }).id;
}

async function jobState(id: string): Promise<JobState> {
  const r = await db.execute(sql`
    SELECT status,
           attempts,
           recovery_count AS "recoveryCount",
           error
    FROM extraction_jobs WHERE id = ${id}
  `);
  return r.rows[0] as unknown as JobState;
}

describe.skipIf(!hasDb)("extraction job recovery — restarts don't falsely fail jobs", () => {
  beforeAll(async () => {
    await ensureQueueRecoverySchema();
    const tag = `__recovery_test_${Date.now()}`;
    const d = await db.execute(sql`
      INSERT INTO districts (state, state_district_id, name, slug)
      VALUES ('IL', ${tag}, 'Recovery Test District', ${tag})
      RETURNING id::text AS id
    `);
    districtId = (d.rows[0] as { id: string }).id;
  });

  afterAll(async () => {
    if (districtId) {
      await db.execute(sql`
        DELETE FROM extraction_jobs
        WHERE source_doc_id IN (SELECT id FROM source_documents WHERE district_id = ${districtId})
      `);
      await db.execute(sql`DELETE FROM source_documents WHERE district_id = ${districtId}`);
      await db.execute(sql`DELETE FROM districts WHERE id = ${districtId}`);
    }
    await pool.end();
  });

  it("re-queues an orphaned running job, refunds the attempt, and bumps recovery_count", async () => {
    // Simulates a job that was claimed (attempts 0 -> 1) then SIGKILLed mid-run.
    const doc = await insertDoc("recover-refund", "a");
    const jobId = await insertJob({ docId: doc, status: "running", attempts: 1, recoveryCount: 0 });

    await recoverStaleJobs();

    const s = await jobState(jobId);
    expect(s.status).toBe("queued");
    expect(s.attempts).toBe(0); // claim-time increment refunded
    expect(s.recoveryCount).toBe(1);
    expect(s.error).toBeNull();
  });

  it("fails a job once recovery_count would exceed MAX_RECOVERIES", async () => {
    // A poison job that keeps crashing the process: at the cap it fail-closes
    // instead of looping forever and wedging the single-concurrency queue.
    const doc = await insertDoc("recover-cap", "b");
    const jobId = await insertJob({
      docId: doc,
      status: "running",
      attempts: 1,
      recoveryCount: MAX_RECOVERIES,
    });

    await recoverStaleJobs();

    const s = await jobState(jobId);
    expect(s.status).toBe("failed");
    expect(s.recoveryCount).toBe(MAX_RECOVERIES + 1);
    expect(s.error).toBe("exceeded interrupted-run recovery limit");
  });

  it("requeueInterruptedJobs recovers interrupted + transient failures, dedupes per doc, and guards active/genuine", async () => {
    // Doc with TWO interrupted failures — only the latest row should re-queue.
    const dupDoc = await insertDoc("req-dedupe", "c");
    const olderId = await insertJob({
      docId: dupDoc,
      status: "failed",
      error: "recovered from interrupted run",
    });
    const newerId = await insertJob({
      docId: dupDoc,
      status: "failed",
      error: "recovered from interrupted run",
    });

    // Transient DB read error during processing — safe to retry.
    const transientDoc = await insertDoc("req-transient", "d");
    const transientId = await insertJob({
      docId: transientDoc,
      status: "failed",
      error: "Failed query: \n SELECT ... FROM vision_extraction_cache",
    });

    // Doc that already has an ACTIVE job — its interrupted failure must be skipped.
    const activeDoc = await insertDoc("req-active", "e");
    const activeFailedId = await insertJob({
      docId: activeDoc,
      status: "failed",
      error: "recovered from interrupted run",
    });
    await insertJob({ docId: activeDoc, status: "queued" });

    // Genuine content failure — must NOT be resurrected (wastes paid Vision).
    const genuineDoc = await insertDoc("req-genuine", "f");
    const genuineId = await insertJob({
      docId: genuineDoc,
      status: "failed",
      error: "no salary schedule detected in document",
    });

    const requeued = await requeueInterruptedJobs();
    expect(requeued).toBeGreaterThanOrEqual(2); // at least our dedupe-latest + transient

    expect((await jobState(newerId)).status).toBe("queued");
    expect((await jobState(olderId)).status).toBe("failed"); // deduped: older stays
    expect((await jobState(transientId)).status).toBe("queued");
    expect((await jobState(activeFailedId)).status).toBe("failed"); // active guard
    expect((await jobState(genuineId)).status).toBe("failed"); // genuine preserved

    // A re-queued row is fully reset for a clean fresh attempt.
    const requeuedState = await jobState(newerId);
    expect(requeuedState.attempts).toBe(0);
    expect(requeuedState.recoveryCount).toBe(0);
    expect(requeuedState.error).toBeNull();
  });
});
