import app from "./app";
import { logger } from "./lib/logger";

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
});

// Data refresh is fully manual / on-demand (no scheduled automation).
// The four pipeline jobs — ISBE directory refresh, extraction, IL CBA crawl,
// and the annual minimum-teacher-salary sync — are triggered from the admin
// panel's "Data Refresh" controls (their spawn* helpers + POST endpoints live
// in routes/admin.ts). Keeping the server free of long-lived cron schedulers
// lets it run as a stateless HTTP reader on Autoscale (scales to zero when idle)
// instead of requiring an always-on Reserved VM.
