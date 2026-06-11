import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

declare module "express-session" {
  interface SessionData {
    adminAuthenticated?: boolean;
    userId?: number;
  }
}

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
  "alerts",
  "cdss_staging",
];

/** Valid provision categories as defined by the DB check constraint. */
const VALID_CATEGORIES = new Set([
  "compensation", "insurance", "retirement", "leave",
  "workday", "evaluation", "rif", "grievance", "other",
]);

async function getTableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    try {
      const rows = await db.execute(
        sql.raw(`SELECT COUNT(*)::int AS n FROM ${table}`),
      );
      counts[table] = (rows.rows[0] as { n: number })?.n ?? 0;
    } catch {
      counts[table] = -1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Admin session middleware
// Checks that the request carries a valid admin session cookie (set via
// POST /admin/login). No secrets are exposed to the client bundle.
// ---------------------------------------------------------------------------
function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  if (req.session.adminAuthenticated) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized: admin login required" });
}

// ---------------------------------------------------------------------------
// POST /admin/login — exchange ADMIN_TOKEN for a session cookie
// ---------------------------------------------------------------------------
router.post("/admin/login", (req, res) => {
  const { token } = req.body as { token?: string };
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    res
      .status(503)
      .json({ error: "Admin auth not configured on server. Set the ADMIN_TOKEN environment variable." });
    return;
  }

  if (!token || token !== adminToken) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  req.session.adminAuthenticated = true;
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /admin/session — check if the current session is authenticated
// ---------------------------------------------------------------------------
router.get("/admin/session", (req, res) => {
  res.json({ authenticated: !!req.session.adminAuthenticated });
});

// ---------------------------------------------------------------------------
// POST /admin/logout
// ---------------------------------------------------------------------------
router.post("/admin/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /admin/crawl-report
// ---------------------------------------------------------------------------
router.get("/admin/crawl-report", requireAdminToken, async (_req, res) => {
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

// ---------------------------------------------------------------------------
// GET /admin/extraction-report
// ---------------------------------------------------------------------------
router.get("/admin/extraction-report", requireAdminToken, async (_req, res) => {
  try {
    const runRows = await db.execute(
      sql.raw(`SELECT status, COUNT(*)::int AS n FROM extraction_runs GROUP BY status`),
    );
    const runCounts: Record<string, number> = {};
    for (const row of runRows.rows as { status: string; n: number }[]) {
      runCounts[row.status] = row.n;
    }

    const cRows = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM contracts`));
    const totalContracts = (cRows.rows[0] as { n: number })?.n ?? 0;

    const cpRows = await db.execute(
      sql.raw(
        `SELECT category, COUNT(*)::int AS n FROM contract_provisions GROUP BY category ORDER BY n DESC`,
      ),
    );
    const provisionsByCategory = (cpRows.rows as { category: string; n: number }[]).map(
      (r) => ({ category: r.category, count: r.n }),
    );

    const rqRows = await db.execute(
      sql.raw(
        `SELECT COUNT(*)::int AS n FROM contract_provisions WHERE confidence < 0.8 AND NOT human_verified`,
      ),
    );
    const reviewQueueCount = (rqRows.rows[0] as { n: number })?.n ?? 0;

    const hvRows = await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS n FROM contract_provisions WHERE human_verified = true`),
    );
    const humanVerifiedCount = (hvRows.rows[0] as { n: number })?.n ?? 0;

    const sRows = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM settlements`));
    const totalSettlements = (sRows.rows[0] as { n: number })?.n ?? 0;

    const smRows = await db.execute(
      sql.raw(`SELECT method, COUNT(*)::int AS n FROM settlements GROUP BY method`),
    );
    const settlementsByMethod = (smRows.rows as { method: string; n: number }[]).map(
      (r) => ({ method: r.method, count: r.n }),
    );

    const sdRows = await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS n FROM source_documents WHERE doc_type = 'cba_pdf'`),
    );
    const totalCbaDocs = (sdRows.rows[0] as { n: number })?.n ?? 0;

    const procRows = await db.execute(
      sql.raw(
        `SELECT COUNT(DISTINCT source_doc_id)::int AS n FROM extraction_runs WHERE status = 'success'`,
      ),
    );
    const processedDocs = (procRows.rows[0] as { n: number })?.n ?? 0;

    res.json({
      runCounts,
      totalContracts,
      provisionsByCategory,
      reviewQueueCount,
      humanVerifiedCount,
      totalSettlements,
      settlementsByMethod,
      totalCbaDocs,
      processedDocs,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/review-queue
// ---------------------------------------------------------------------------
router.get("/admin/review-queue", requireAdminToken, async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
  const offset = (page - 1) * limit;

  // Validate category against the allowlist — never interpolate raw user input
  const rawCategory = req.query.category ? String(req.query.category) : "";
  if (rawCategory && !VALID_CATEGORIES.has(rawCategory)) {
    res.status(400).json({ error: `Invalid category. Must be one of: ${[...VALID_CATEGORIES].join(", ")}` });
    return;
  }
  const category = rawCategory || null;

  try {
    // Use Drizzle sql template for safe parameterization of user-supplied values
    const rows = await db.execute(
      category
        ? sql`
            SELECT
              cp.id,
              cp.category,
              cp.provision_key,
              cp.value_numeric,
              cp.value_text,
              cp.unit,
              cp.clause_excerpt,
              cp.page_ref,
              cp.confidence,
              c.id              AS contract_id,
              c.union_name,
              c.unit_scope,
              c.effective_start,
              c.effective_end,
              sd.source_url,
              d.name            AS district_name
            FROM contract_provisions cp
            JOIN contracts c ON cp.contract_id = c.id
            LEFT JOIN source_documents sd ON c.source_doc_id = sd.id
            LEFT JOIN districts d ON c.district_id = d.id
            WHERE cp.confidence < 0.8
              AND NOT cp.human_verified
              AND cp.category = ${category}
            ORDER BY cp.confidence ASC, cp.id
            LIMIT ${limit} OFFSET ${offset}
          `
        : sql`
            SELECT
              cp.id,
              cp.category,
              cp.provision_key,
              cp.value_numeric,
              cp.value_text,
              cp.unit,
              cp.clause_excerpt,
              cp.page_ref,
              cp.confidence,
              c.id              AS contract_id,
              c.union_name,
              c.unit_scope,
              c.effective_start,
              c.effective_end,
              sd.source_url,
              d.name            AS district_name
            FROM contract_provisions cp
            JOIN contracts c ON cp.contract_id = c.id
            LEFT JOIN source_documents sd ON c.source_doc_id = sd.id
            LEFT JOIN districts d ON c.district_id = d.id
            WHERE cp.confidence < 0.8
              AND NOT cp.human_verified
            ORDER BY cp.confidence ASC, cp.id
            LIMIT ${limit} OFFSET ${offset}
          `,
    );

    const countRows = await db.execute(
      category
        ? sql`SELECT COUNT(*)::int AS n FROM contract_provisions cp WHERE cp.confidence < 0.8 AND NOT cp.human_verified AND cp.category = ${category}`
        : sql`SELECT COUNT(*)::int AS n FROM contract_provisions cp WHERE cp.confidence < 0.8 AND NOT cp.human_verified`,
    );
    const total = (countRows.rows[0] as { n: number })?.n ?? 0;

    res.json({
      items: rows.rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/alerts — paginated list of alerts by status
// ---------------------------------------------------------------------------
router.get("/admin/alerts", requireAdminToken, async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const rawStatus = String(req.query.status ?? "pending");
  const status = rawStatus === "acknowledged" ? "acknowledged" : "pending";

  try {
    const rows = await db.execute(sql`
      SELECT
        a.id,
        a.alert_type,
        a.doc_name,
        a.source_url,
        a.detected_at,
        a.status,
        a.acknowledged_at,
        a.acknowledged_by,
        a.notes,
        d.name AS district_name
      FROM alerts a
      LEFT JOIN districts d ON a.district_id = d.id
      WHERE a.status = ${status}
      ORDER BY a.detected_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const countRows = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM alerts WHERE status = ${status}`,
    );
    const total = (countRows.rows[0] as { n: number })?.n ?? 0;

    const pendingRows = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM alerts WHERE status = 'pending'`,
    );
    const pendingCount = (pendingRows.rows[0] as { n: number })?.n ?? 0;

    res.json({
      items: rows.rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      pendingCount,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/alerts/:id/acknowledge
// Protected by requireAdminToken — only admin-token holders may acknowledge.
// ---------------------------------------------------------------------------
router.post(
  "/admin/alerts/:id/acknowledge",
  requireAdminToken,
  async (req, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const { notes, acknowledgedBy } = req.body as {
      notes?: string;
      acknowledgedBy?: string;
    };

    try {
      const result = await db.execute(sql`
        UPDATE alerts
        SET status           = 'acknowledged',
            acknowledged_at  = NOW(),
            acknowledged_by  = ${acknowledgedBy ?? null},
            notes            = ${notes ?? null}
        WHERE id = ${id} AND status = 'pending'
      `);
      const affected = (result as unknown as { rowCount?: number }).rowCount ?? 0;
      if (affected === 0) {
        res.status(404).json({ error: "Alert not found or already acknowledged" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /admin/review-queue/:id
// Protected by requireAdminToken middleware (session-based).
// body: { action: 'approve'|'correct'|'reject', correctedValue?: string }
// ---------------------------------------------------------------------------
router.patch("/admin/review-queue/:id", requireAdminToken, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { action, correctedValue } = req.body as {
    action?: string;
    correctedValue?: string;
  };

  if (!["approve", "correct", "reject"].includes(action ?? "")) {
    res.status(400).json({ error: "action must be approve | correct | reject" });
    return;
  }

  try {
    if (action === "reject") {
      await db.execute(sql`DELETE FROM contract_provisions WHERE id = ${id}`);
    } else if (action === "correct") {
      if (correctedValue === undefined) {
        res.status(400).json({ error: "correctedValue is required for action=correct" });
        return;
      }
      const numericVal = parseFloat(correctedValue);
      if (!isNaN(numericVal)) {
        await db.execute(
          sql`UPDATE contract_provisions
              SET human_verified = true,
                  value_text    = ${correctedValue},
                  value_numeric = ${numericVal}
              WHERE id = ${id}`,
        );
      } else {
        await db.execute(
          sql`UPDATE contract_provisions
              SET human_verified = true,
                  value_text    = ${correctedValue}
              WHERE id = ${id}`,
        );
      }
    } else {
      // approve
      await db.execute(
        sql`UPDATE contract_provisions SET human_verified = true WHERE id = ${id}`,
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
