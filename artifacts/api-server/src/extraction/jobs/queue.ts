// Durable extraction job queue (Task #175). One row per requested extraction in
// the extraction_jobs table; an in-process worker (worker.ts) claims and runs
// jobs ONE AT A TIME. The queue is the only coupling between the admin request
// path (upload / re-run) and the worker, so an upload returns immediately and
// the (slow, paid) Claude Vision work happens in the background.
//
// Concurrency model:
//   - A PARTIAL UNIQUE INDEX (extraction_jobs_active_doc_uniq) guarantees at most
//     one ACTIVE (queued|running) job per source document, so enqueue is an
//     idempotent dedupe.
//   - claimNextJob() flips exactly one queued row to 'running' under
//     FOR UPDATE SKIP LOCKED, so even if two workers ever ran they'd never grab
//     the same job.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";

export type JobDomain =
  | "salary"
  | "provisions"
  | "cba"
  | "settlement"
  | "final_offer";
export type JobStatus = "queued" | "running" | "done" | "failed" | "canceled";

export interface ExtractionJob {
  id: string;
  sourceDocId: string;
  domain: JobDomain;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  model: string | null;
  requestedBy: string | null;
  requestReason: string | null;
  error: string | null;
  result: unknown;
  leasedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Shared SELECT list mapping snake_case columns to the camelCase ExtractionJob.
const JOB_COLUMNS = sql`
  id::text             AS "id",
  source_doc_id::text  AS "sourceDocId",
  domain               AS "domain",
  status               AS "status",
  priority             AS "priority",
  attempts             AS "attempts",
  max_attempts         AS "maxAttempts",
  model                AS "model",
  requested_by         AS "requestedBy",
  request_reason       AS "requestReason",
  error                AS "error",
  result               AS "result",
  leased_at            AS "leasedAt",
  started_at           AS "startedAt",
  finished_at          AS "finishedAt",
  created_at           AS "createdAt",
  updated_at           AS "updatedAt"
`;

export interface EnqueueParams {
  sourceDocId: number | string;
  domain: JobDomain;
  priority?: number;
  model?: string | null;
  requestedBy?: string | null;
  requestReason?: string | null;
  maxAttempts?: number;
}

export interface EnqueueResult {
  job: ExtractionJob;
  // true when an active job already existed for this doc and was returned as-is
  // (no new job created).
  deduped: boolean;
}

// Enqueue a job, or return the existing active job for this document. Race-safe:
// the ON CONFLICT targets the partial unique index, so a concurrent enqueue for
// the same doc collapses to one active job.
export async function enqueueJob(p: EnqueueParams): Promise<EnqueueResult> {
  const priority = p.priority ?? 100;
  const maxAttempts = p.maxAttempts ?? 1;
  const inserted = await db.execute(sql`
    INSERT INTO extraction_jobs
      (source_doc_id, domain, priority, max_attempts, model, requested_by, request_reason)
    VALUES (${p.sourceDocId}, ${p.domain}, ${priority}, ${maxAttempts},
            ${p.model ?? null}, ${p.requestedBy ?? null}, ${p.requestReason ?? null})
    ON CONFLICT (source_doc_id) WHERE status IN ('queued','running') DO NOTHING
    RETURNING ${JOB_COLUMNS}
  `);
  if (inserted.rows.length) {
    return { job: inserted.rows[0] as unknown as ExtractionJob, deduped: false };
  }
  const existing = await db.execute(sql`
    SELECT ${JOB_COLUMNS} FROM extraction_jobs
    WHERE source_doc_id = ${p.sourceDocId} AND status IN ('queued','running')
    ORDER BY id LIMIT 1
  `);
  return { job: existing.rows[0] as unknown as ExtractionJob, deduped: true };
}

// Atomically claim the next queued job (lowest priority value, then oldest) and
// flip it to 'running'. Returns null when the queue is empty.
export async function claimNextJob(): Promise<ExtractionJob | null> {
  const res = await db.execute(sql`
    UPDATE extraction_jobs
    SET status = 'running',
        attempts = attempts + 1,
        leased_at = NOW(),
        started_at = COALESCE(started_at, NOW()),
        updated_at = NOW()
    WHERE id = (
      SELECT id FROM extraction_jobs
      WHERE status = 'queued'
      ORDER BY priority, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING ${JOB_COLUMNS}
  `);
  return res.rows.length ? (res.rows[0] as unknown as ExtractionJob) : null;
}

export async function markJobDone(
  id: number | string,
  result: unknown,
): Promise<void> {
  await db.execute(sql`
    UPDATE extraction_jobs
    SET status = 'done',
        result = ${JSON.stringify(result)}::jsonb,
        error = NULL,
        finished_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id}
  `);
}

// Fail a job. Requeues automatically when attempts remain (attempts < max), else
// marks it 'failed'. attempts was already incremented at claim time.
export async function markJobFailed(
  id: number | string,
  error: string,
  result?: unknown,
): Promise<void> {
  const resultJson = result === undefined ? null : JSON.stringify(result);
  await db.execute(sql`
    UPDATE extraction_jobs
    SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
        error = ${error},
        result = ${resultJson}::jsonb,
        leased_at = NULL,
        finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE NOW() END,
        updated_at = NOW()
    WHERE id = ${id}
  `);
}

// Boot recovery: any job still 'running' was orphaned by a crash/restart mid-run.
// Requeue it if attempts remain, otherwise fail it (fail-closed — never silently
// drop). Returns how many rows were recovered.
export async function recoverStaleJobs(): Promise<number> {
  const res = await db.execute(sql`
    UPDATE extraction_jobs
    SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
        error = COALESCE(error, 'recovered from interrupted run'),
        leased_at = NULL,
        finished_at = CASE WHEN attempts < max_attempts THEN finished_at ELSE NOW() END,
        updated_at = NOW()
    WHERE status = 'running'
    RETURNING id
  `);
  return res.rows.length;
}

export interface QueueStats {
  queued: number;
  running: number;
  done: number;
  failed: number;
  canceled: number;
  avgDurationSec: number | null;
  estRemainingSec: number | null;
}

// Queue counts plus a rolling average job duration (last 20 done jobs) used to
// surface an estimated time-to-drain for the admin UI.
export async function getQueueStats(): Promise<QueueStats> {
  const counts = await db.execute(sql`
    SELECT status, COUNT(*)::int AS n FROM extraction_jobs GROUP BY status
  `);
  const map: Record<string, number> = {};
  for (const r of counts.rows as Array<{ status: string; n: number }>) {
    map[r.status] = r.n;
  }
  const avgRes = await db.execute(sql`
    SELECT AVG(EXTRACT(EPOCH FROM (finished_at - started_at)))::float AS avg
    FROM (
      SELECT started_at, finished_at FROM extraction_jobs
      WHERE status = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 20
    ) t
  `);
  const avgRaw = (avgRes.rows[0] as { avg: number | null } | undefined)?.avg ?? null;
  const queued = map["queued"] ?? 0;
  const running = map["running"] ?? 0;
  const estRemainingSec =
    avgRaw != null ? Math.round(avgRaw * (queued + running)) : null;
  return {
    queued,
    running,
    done: map["done"] ?? 0,
    failed: map["failed"] ?? 0,
    canceled: map["canceled"] ?? 0,
    avgDurationSec: avgRaw != null ? Math.round(avgRaw) : null,
    estRemainingSec,
  };
}

export async function listJobs(opts?: {
  status?: JobStatus;
  limit?: number;
}): Promise<ExtractionJob[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const res = opts?.status
    ? await db.execute(sql`
        SELECT ${JOB_COLUMNS} FROM extraction_jobs
        WHERE status = ${opts.status}
        ORDER BY id DESC LIMIT ${limit}
      `)
    : await db.execute(sql`
        SELECT ${JOB_COLUMNS} FROM extraction_jobs
        ORDER BY id DESC LIMIT ${limit}
      `);
  return res.rows as unknown as ExtractionJob[];
}

export async function getJob(id: number | string): Promise<ExtractionJob | null> {
  const res = await db.execute(sql`
    SELECT ${JOB_COLUMNS} FROM extraction_jobs WHERE id = ${id}
  `);
  return res.rows.length ? (res.rows[0] as unknown as ExtractionJob) : null;
}
