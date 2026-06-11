import { Router, type IRouter } from "express";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { neon } from "@neondatabase/serverless";

const router: IRouter = Router();

const CRAWL_STATE_PATH = join(
  process.cwd(),
  "..",
  "..",
  "pipeline",
  "state",
  "crawl_state.json",
);

const TABLES = [
  "districts",
  "source_documents",
  "factfinding_proposals",
  "benchmarks",
  "contracts",
  "contract_provisions",
  "settlements",
];

async function getTableCounts(): Promise<Record<string, number>> {
  const dbUrl = process.env["DATABASE_URL"];
  if (!dbUrl) return {};
  try {
    const sql = neon(dbUrl);
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      try {
        const rows = await sql(`SELECT COUNT(*)::int AS n FROM ${table}`);
        counts[table] = rows[0]?.n ?? 0;
      } catch {
        counts[table] = -1;
      }
    }
    return counts;
  } catch {
    return {};
  }
}

router.get("/admin/crawl-report", async (_req, res) => {
  let crawlState: Record<string, unknown> = {};
  if (existsSync(CRAWL_STATE_PATH)) {
    try {
      crawlState = JSON.parse(readFileSync(CRAWL_STATE_PATH, "utf-8"));
    } catch {
      crawlState = { error: "Could not parse crawl state" };
    }
  }

  const tableCounts = await getTableCounts();

  const matched = (crawlState["cba_district_matched"] as number) ?? 0;
  const unmatched = (crawlState["cba_district_unmatched"] as number) ?? 0;
  const total = matched + unmatched;
  const matchRate = total > 0 ? Math.round((matched / total) * 1000) / 10 : null;

  res.json({
    crawlState: {
      districtsLoaded: crawlState["districts_loaded"] ?? 0,
      cbaDocsFound: crawlState["cba_docs_found"] ?? 0,
      cbaDocsDownloaded: crawlState["cba_docs_downloaded"] ?? 0,
      cbaDocsSkipped: crawlState["cba_docs_skipped"] ?? 0,
      cbaDocsFailed: crawlState["cba_docs_failed"] ?? 0,
      districtMatched: matched,
      districtUnmatched: unmatched,
      matchRatePct: matchRate,
      ffProposalsLoaded: crawlState["ff_proposals_loaded"] ?? 0,
      ffPageAccessible: crawlState["ff_page_accessible"] ?? false,
      wageSettlementDownloaded: crawlState["wage_settlement_downloaded"] ?? 0,
      wageSettlementFailedYears: crawlState["wage_settlement_failed_urls"] ?? [],
      manualReviewCount: Array.isArray(crawlState["manual_review"])
        ? (crawlState["manual_review"] as unknown[]).length
        : 0,
      unmatchedEmployerCount: Array.isArray(crawlState["unmatched_employers"])
        ? (crawlState["unmatched_employers"] as unknown[]).length
        : 0,
      unmatchedEmployers: Array.isArray(crawlState["unmatched_employers"])
        ? (crawlState["unmatched_employers"] as string[]).slice(0, 50)
        : [],
      lastUpdated: crawlState["last_updated"] ?? null,
    },
    tableCounts,
  });
});

export default router;
