import app from "./app";
import { logger } from "./lib/logger";
import { startWorker, stopWorker } from "./extraction/jobs/worker";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start the in-process extraction worker AFTER the HTTP server is serving, so
  // uploads/re-runs are accepted immediately while extraction proceeds in the
  // background. No-op under test or when EXTRACTION_WORKER_DISABLED=1. Requires
  // an always-on deployment (Reserved VM) — on Autoscale the instance scales to
  // zero when idle and the worker would not run between requests.
  void startWorker().catch((workerErr) => {
    logger.error({ err: workerErr }, "Failed to start extraction worker");
  });
});

// Graceful shutdown: let the in-flight extraction job finish before exit so a
// deploy/restart never leaves a job orphaned mid-run (boot recovery also covers
// hard kills).
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down: stopping extraction worker");
  try {
    await stopWorker();
  } catch (err) {
    logger.error({ err }, "Error stopping extraction worker during shutdown");
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Data refresh is fully manual / on-demand (no scheduled automation).
// The four pipeline jobs — ISBE directory refresh, extraction, IL CBA crawl,
// and the annual minimum-teacher-salary sync — are triggered from the admin
// panel's "Data Refresh" controls (their spawn* helpers + POST endpoints live
// in routes/admin.ts). Keeping the server free of long-lived cron schedulers
// lets it run as a stateless HTTP reader on Autoscale (scales to zero when idle)
// instead of requiring an always-on Reserved VM.
