// In-process extraction worker (Task #175). A single async loop that claims one
// job at a time from extraction_jobs and runs Claude Vision extraction IN PROCESS
// — no Python shell-out, no detached child process. Started from index.ts AFTER
// app.listen so the HTTP server is serving first; disabled under test or when
// EXTRACTION_WORKER_DISABLED=1.
//
// For each job the worker runs EXTRACT-ONLY (it never touches the live tables
// directly): it persists the result as an immutable version (versions.ts) and,
// only when the (doc, domain) has no promotion pointer yet, auto-promotes it so a
// first upload appears for customers automatically. Re-runs require a manual
// promote in the admin UI. Fail-closed: an unparseable/truncated extraction
// records NO version and does not promote, leaving existing live rows intact.

import crypto from "node:crypto";
import { logger } from "../../lib/logger";
import { loadSourceDoc, resolvePdfBuffer } from "../source-docs";
import { extractSalarySchedules, SALARY_PROMPT_VERSION } from "../domains/salary";
import {
  extractProvisions,
  PROVISIONS_PROMPT_VERSION,
} from "../domains/provisions";
import { verifyProvisionsAgainstText } from "../domains/provisions-verify";
import {
  deriveStatedSettlements,
  SETTLEMENT_DERIVE_VERSION,
} from "../domains/settlements";
import {
  extractFinalOffer,
  FINAL_OFFER_PROMPT_VERSION,
} from "../domains/final-offers";
import { findPostingSide } from "../domains/final-offers-store";
import { openPdf, RENDER_VERSION } from "../pdf/renderer";
import {
  claimNextJob,
  markJobDone,
  markJobFailed,
  recoverStaleJobs,
  type ExtractionJob,
} from "./queue";
import {
  createVersion,
  promoteVersion,
  getPromotedVersionId,
  type VersionDomain,
} from "./versions";

const POLL_INTERVAL_MS = Number(process.env.EXTRACTION_WORKER_POLL_MS ?? 3000);

let started = false;
let stopRequested = false;
let loopPromise: Promise<void> | null = null;

export function isWorkerEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.EXTRACTION_WORKER_DISABLED === "1") return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function avg(xs: number[]): number | null {
  if (!xs.length) return null;
  return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4));
}

type DomainExtract =
  | {
      ok: true;
      domain: VersionDomain;
      fileHash: string;
      normalized: unknown;
      summary: Record<string, unknown>;
      model: string | null;
      modelVersion: string;
      promptVersion: string;
      renderVersion: string;
    }
  | {
      ok: false;
      domain: VersionDomain;
      status: "no_doc" | "no_pdf" | "extract_failed";
      fileHash?: string;
    };

// Extract one domain for one document WITHOUT storing — mirrors the extract half
// of runSalaryForDoc / runProvisionsForDoc (including provisions text verify),
// stopping before the store. The worker turns the result into an immutable
// version; promotion is what writes the live tables.
async function extractDomain(
  sourceDocId: string,
  domain: VersionDomain,
  opts: { model?: string },
): Promise<DomainExtract> {
  const doc = await loadSourceDoc(sourceDocId);
  if (!doc) return { ok: false, domain, status: "no_doc" };

  // Settlements are DERIVED from the doc's already-extracted contract provisions
  // (no PDF / vision call) — handle before resolving PDF bytes.
  if (domain === "settlement") {
    const derived = await deriveStatedSettlements(sourceDocId);
    const summary: Record<string, unknown> = {
      domain,
      settlementCount: derived.settlements.length,
      units: [...new Set(derived.settlements.map((s) => s.bargainingUnit))],
      skipped: derived.skipped,
      flaggedOutOfRange: derived.flaggedOutOfRange.length,
    };
    return {
      ok: true,
      domain,
      fileHash: doc.fileHash ?? "",
      normalized: { settlements: derived.settlements },
      summary,
      model: null,
      modelVersion: "derive",
      promptVersion: SETTLEMENT_DERIVE_VERSION,
      renderVersion: "n/a",
    };
  }

  const buf = await resolvePdfBuffer(doc);
  if (!buf) {
    return { ok: false, domain, status: "no_pdf", fileHash: doc.fileHash ?? undefined };
  }

  const fileHash =
    doc.fileHash && /^[0-9a-f]{64}$/i.test(doc.fileHash)
      ? doc.fileHash.toLowerCase()
      : crypto.createHash("sha256").update(buf).digest("hex");

  if (domain === "final_offer") {
    // A final-offer doc is one party's filing on a posting. Resolve the posting +
    // side first; a doc not wired to any posting fails the job (fail-closed).
    const ps = await findPostingSide(sourceDocId);
    if (!ps) return { ok: false, domain, status: "extract_failed", fileHash };
    const extraction = await extractFinalOffer(buf, fileHash, { model: opts.model });
    if (!extraction.ok) return { ok: false, domain, status: "extract_failed", fileHash };
    const items = extraction.items;
    const summary: Record<string, unknown> = {
      domain,
      postingId: ps.postingId,
      caseNumber: ps.caseNumber,
      side: ps.side,
      itemCount: items.length,
      topics: items.map((i) => i.topic),
      costUsd: extraction.costUsd,
      inputTokens: extraction.inputTokens,
      outputTokens: extraction.outputTokens,
      modelVersion: extraction.modelVersion,
      pageCount: extraction.pageCount,
      pagesExtracted: extraction.pagesExtracted,
      fromCache: extraction.fromCache,
    };
    return {
      ok: true,
      domain,
      fileHash,
      normalized: { postingId: ps.postingId, side: ps.side, items },
      summary,
      model: opts.model ?? null,
      modelVersion: extraction.modelVersion,
      promptVersion: FINAL_OFFER_PROMPT_VERSION,
      renderVersion: RENDER_VERSION,
    };
  }

  if (domain === "salary") {
    const extraction = await extractSalarySchedules(buf, fileHash, { model: opts.model });
    if (!extraction.ok) return { ok: false, domain, status: "extract_failed", fileHash };
    const schedules = extraction.schedules;
    const summary: Record<string, unknown> = {
      domain,
      scheduleCount: schedules.length,
      cellCount: schedules.reduce((a, s) => a + s.cells.length, 0),
      flagged: schedules.filter((s) => s.needsReview).length,
      avgConfidence: avg(schedules.map((s) => s.confidence)),
      costUsd: extraction.costUsd,
      inputTokens: extraction.inputTokens,
      outputTokens: extraction.outputTokens,
      modelVersion: extraction.modelVersion,
      pageCount: extraction.pageCount,
      pagesExtracted: extraction.pagesExtracted,
      fromCache: extraction.fromCache,
    };
    return {
      ok: true,
      domain,
      fileHash,
      normalized: { schedules },
      summary,
      model: opts.model ?? null,
      modelVersion: extraction.modelVersion,
      promptVersion: SALARY_PROMPT_VERSION,
      renderVersion: RENDER_VERSION,
    };
  }

  // provisions
  const extraction = await extractProvisions(buf, fileHash, { model: opts.model });
  if (!extraction.ok) return { ok: false, domain, status: "extract_failed", fileHash };
  const contracts = extraction.contracts;

  // Option B: corroborate $/% values against the digital text layer (mutates the
  // contracts' confidences) before the version is frozen.
  let verify: { checked: number; mismatched: number; capped: number } | undefined;
  if (contracts.some((c) => c.provisions.length)) {
    const vdoc = await openPdf(buf);
    try {
      verify = verifyProvisionsAgainstText(contracts, vdoc);
    } finally {
      vdoc.destroy();
    }
  }

  const allProvs = contracts.flatMap((c) => c.provisions);
  const summary: Record<string, unknown> = {
    domain,
    contractCount: contracts.length,
    provisionCount: allProvs.length,
    units: contracts.map((c) => c.bargainingUnit),
    flagged: allProvs.filter((p) => p.confidence < 0.8).length,
    avgConfidence: avg(allProvs.map((p) => p.confidence)),
    verify: verify ?? null,
    costUsd: extraction.costUsd,
    inputTokens: extraction.inputTokens,
    outputTokens: extraction.outputTokens,
    modelVersion: extraction.modelVersion,
    pageCount: extraction.pageCount,
    pagesExtracted: extraction.pagesExtracted,
    fromCache: extraction.fromCache,
  };
  return {
    ok: true,
    domain,
    fileHash,
    normalized: { contracts },
    summary,
    model: opts.model ?? null,
    modelVersion: extraction.modelVersion,
    promptVersion: PROVISIONS_PROMPT_VERSION,
    renderVersion: RENDER_VERSION,
  };
}

// Exported for unit tests; not part of the module's runtime public surface.
export async function processJob(job: ExtractionJob): Promise<void> {
  const domains: VersionDomain[] =
    job.domain === "cba" ? ["salary", "provisions"] : [job.domain as VersionDomain];

  const perDomain: Array<Record<string, unknown>> = [];
  let anySuccess = false;

  for (const domain of domains) {
    const ex = await extractDomain(job.sourceDocId, domain, {
      model: job.model ?? undefined,
    });
    if (!ex.ok) {
      perDomain.push({ domain, status: ex.status });
      logger.warn(
        { jobId: job.id, sourceDocId: job.sourceDocId, domain, status: ex.status },
        "extraction worker: domain did not produce a result",
      );
      continue;
    }

    const { version, duplicate } = await createVersion({
      sourceDocId: job.sourceDocId,
      domain,
      jobId: job.id,
      fileHash: ex.fileHash,
      model: ex.model,
      modelVersion: ex.modelVersion,
      promptVersion: ex.promptVersion,
      renderVersion: ex.renderVersion,
      normalized: ex.normalized,
      summary: ex.summary,
      createdBy: job.requestedBy ?? "worker",
    });
    anySuccess = true;

    // Auto-promote ONLY when nothing has been promoted for this (doc, domain)
    // yet — first upload appears for customers automatically; re-runs need a
    // manual promote so a human reviews the diff.
    let autoPromoted = false;
    let targets: number | undefined;
    let promoteReason: string | undefined;
    const existingPointer = await getPromotedVersionId(job.sourceDocId, domain);
    if (existingPointer === null) {
      const pr = await promoteVersion(version.id, { promotedBy: "auto" });
      autoPromoted = pr.ok;
      targets = pr.targets;
      if (pr.ok && pr.targets === 0) promoteReason = "no_contract_targets";
    }

    perDomain.push({
      domain,
      status: "version_created",
      versionId: version.id,
      duplicate,
      autoPromoted,
      targets,
      promoteReason,
      summary: ex.summary,
    });
  }

  const result = { sourceDocId: job.sourceDocId, domains: perDomain };
  if (anySuccess) {
    await markJobDone(job.id, result);
    logger.info({ jobId: job.id, sourceDocId: job.sourceDocId }, "extraction worker: job done");
  } else {
    await markJobFailed(job.id, "all domains failed extraction", result);
    logger.warn({ jobId: job.id, sourceDocId: job.sourceDocId }, "extraction worker: job failed");
  }
}

async function runLoop(): Promise<void> {
  while (!stopRequested) {
    let job: ExtractionJob | null = null;
    try {
      job = await claimNextJob();
    } catch (err) {
      logger.error({ err }, "extraction worker: claim failed");
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    try {
      await processJob(job);
    } catch (err) {
      logger.error({ err, jobId: job.id }, "extraction worker: job crashed");
      try {
        await markJobFailed(job.id, String((err as Error)?.message ?? err));
      } catch (markErr) {
        logger.error({ err: markErr, jobId: job.id }, "extraction worker: failed to mark crashed job");
      }
    }
  }
}

// Start the worker loop. Idempotent and a no-op when disabled. Recovers any jobs
// orphaned 'running' by a previous crash before entering the loop.
export async function startWorker(): Promise<void> {
  if (started) return;
  if (!isWorkerEnabled()) {
    logger.info(
      "extraction worker disabled (NODE_ENV=test or EXTRACTION_WORKER_DISABLED=1)",
    );
    return;
  }
  started = true;
  stopRequested = false;
  try {
    const recovered = await recoverStaleJobs();
    if (recovered) {
      logger.warn({ recovered }, "extraction worker: recovered interrupted jobs at boot");
    }
  } catch (err) {
    logger.error({ err }, "extraction worker: stale-job recovery failed");
  }
  loopPromise = runLoop();
  logger.info({ pollMs: POLL_INTERVAL_MS }, "extraction worker started (single concurrency)");
}

// Graceful stop: signal the loop to exit after the in-flight job (if any)
// finishes, then await it. Safe to call when the worker never started.
export async function stopWorker(): Promise<void> {
  stopRequested = true;
  if (loopPromise) {
    try {
      await loopPromise;
    } catch {
      /* loop already logged */
    }
    loopPromise = null;
  }
  started = false;
}
