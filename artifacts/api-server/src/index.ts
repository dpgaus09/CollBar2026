import app from "./app";
import { logger } from "./lib/logger";
import { schedule } from "node-cron";
import { spawnDirectoryRefresh, spawnExtractionCron, spawnIlCrawl } from "./routes/admin";

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

// Daily ISBE directory refresh — 7:00 AM America/Chicago
schedule(
  "0 7 * * *",
  () => {
    logger.info("Cron: starting daily ISBE directory refresh");
    spawnDirectoryRefresh();
  },
  { timezone: "America/Chicago" },
);
logger.info("Cron registered: ISBE directory refresh at 07:00 America/Chicago daily");

// Nightly IL extraction cron — 3:00 AM America/Chicago
schedule(
  "0 3 * * *",
  () => {
    logger.info("Cron: starting nightly extraction cron");
    spawnExtractionCron();
  },
  { timezone: "America/Chicago" },
);
logger.info("Cron registered: extraction cron at 03:00 America/Chicago daily");

// Bi-monthly IL CBA crawl — 2:00 AM on the 1st and 15th of each month, America/Chicago
// (Districts settle on a fiscal-year calendar; weekly is unnecessary churn)
schedule(
  "0 2 1,15 * *",
  () => {
    logger.info("Cron: starting bi-monthly IL CBA crawl");
    spawnIlCrawl();
  },
  { timezone: "America/Chicago" },
);
logger.info("Cron registered: IL CBA crawl at 02:00 America/Chicago on 1st and 15th of each month");
