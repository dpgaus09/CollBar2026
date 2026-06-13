import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { readFileSync, existsSync, openSync } from "fs";
import { mkdirSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
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

const IL_CBA_CRAWL_STATE_PATH = join(
  process.cwd(),
  "..",
  "..",
  "pipeline",
  "state",
  "il_cba_crawl.json",
);

const IL_UNFOUND_CSV_PATH = join(
  process.cwd(),
  "..",
  "..",
  "pipeline",
  "data",
  "il_cba_unfound.csv",
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
// In-memory rate limiter for /admin/login (max 5 attempts per 60 s per IP)
// ---------------------------------------------------------------------------
const _loginAttempts = new Map<string, { count: number; resetAt: number }>();
const _LOGIN_RATE_MAX = 5;
const _LOGIN_RATE_WINDOW_MS = 60_000;

function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = _loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    _loginAttempts.set(ip, { count: 1, resetAt: now + _LOGIN_RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > _LOGIN_RATE_MAX;
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
  const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  if (loginRateLimited(ip)) {
    res.status(429).json({ error: "Too many login attempts — try again in a minute" });
    return;
  }

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

  // Live counts straight from the DB (more accurate than crawl_state.json)
  const cbaIdxRows = await db.execute(
    sql.raw(`SELECT COUNT(*)::int AS n FROM source_documents WHERE doc_type = 'cba_pdf'`),
  );
  const cbaIndexedCount = (cbaIdxRows.rows[0] as { n: number })?.n ?? 0;

  const cbaMatchRows = await db.execute(
    sql.raw(
      `SELECT COUNT(*)::int AS n FROM source_documents WHERE doc_type = 'cba_pdf' AND district_id IS NOT NULL`,
    ),
  );
  const cbaMatchedCount = (cbaMatchRows.rows[0] as { n: number })?.n ?? 0;

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
      cbaIndexedCount,
      cbaMatchedCount,
    },
    tableCounts,
  });
});

// ---------------------------------------------------------------------------
// GET /admin/il-cba-coverage
// ---------------------------------------------------------------------------
router.get("/admin/il-cba-coverage", requireAdminToken, async (_req, res) => {
  let crawlState: Record<string, unknown> = {};
  if (existsSync(IL_CBA_CRAWL_STATE_PATH)) {
    try {
      crawlState = JSON.parse(readFileSync(IL_CBA_CRAWL_STATE_PATH, "utf-8"));
    } catch {
      crawlState = {};
    }
  }

  // Live count from DB: IL districts with a cba_pdf
  const foundRows = await db.execute(
    sql.raw(`
      SELECT COUNT(DISTINCT sd.district_id)::int AS n
      FROM source_documents sd
      JOIN districts d ON d.id = sd.district_id
      WHERE sd.doc_type = 'cba_pdf' AND d.state = 'IL'
    `),
  );
  const dbFound = (foundRows.rows[0] as { n: number })?.n ?? 0;

  const urlRows = await db.execute(
    sql.raw(`SELECT COUNT(*)::int AS n FROM districts WHERE state = 'IL' AND website_url IS NOT NULL`),
  );
  const districtsWithUrl = (urlRows.rows[0] as { n: number })?.n ?? 0;

  const noUrlRows = await db.execute(
    sql.raw(`SELECT COUNT(*)::int AS n FROM districts WHERE state = 'IL' AND website_url IS NULL`),
  );
  const noUrl = (noUrlRows.rows[0] as { n: number })?.n ?? 0;

  const attempted   = (crawlState["il_attempted"]  as number) ?? 0;
  const found       = dbFound;
  const failed      = (crawlState["il_failed"]     as number) ?? 0;
  const skipped     = (crawlState["il_skipped"]    as number) ?? 0;
  const lastUpdated = (crawlState["last_updated"]   as string)  ?? null;
  const coveragePct = districtsWithUrl > 0
    ? Math.round((found / districtsWithUrl) * 1000) / 10
    : null;

  res.json({
    districtsWithUrl,
    attempted,
    found,
    failed,
    skipped,
    noUrl,
    coveragePct,
    lastUpdated,
  });
});

// ---------------------------------------------------------------------------
// GET /admin/il-cba-unfound.csv
// ---------------------------------------------------------------------------
router.get("/admin/il-cba-unfound.csv", requireAdminToken, async (_req, res) => {
  // If the pre-built file exists, stream it directly
  if (existsSync(IL_UNFOUND_CSV_PATH)) {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="il_cba_unfound.csv"',
    );
    const { createReadStream } = await import("fs");
    createReadStream(IL_UNFOUND_CSV_PATH).pipe(res);
    return;
  }

  // Otherwise generate on the fly from the DB
  const rows = await db.execute(
    sql.raw(`
      SELECT
        d.name               AS district_name,
        d.county             AS county,
        d.enrollment         AS enrollment,
        d.website_url        AS website_url,
        MAX(s.to_year)       AS last_settlement_year
      FROM districts d
      LEFT JOIN settlements s ON s.district_id = d.id
      WHERE d.state = 'IL'
        AND d.website_url IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM source_documents sd
          WHERE sd.district_id = d.id AND sd.doc_type = 'cba_pdf'
        )
      GROUP BY d.id, d.name, d.county, d.enrollment, d.website_url
      ORDER BY d.name
    `),
  );

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="il_cba_unfound.csv"',
  );

  const header = "district_name,county,enrollment,website_url,last_settlement_year\n";
  const body = (rows.rows as {
    district_name: string; county: string | null; enrollment: number | null;
    website_url: string | null; last_settlement_year: string | null;
  }[])
    .map((r) => {
      const esc = (v: string | null | number) =>
        v == null ? "" : `"${String(v).replace(/"/g, '""')}"`;
      return [esc(r.district_name), esc(r.county), esc(r.enrollment),
              esc(r.website_url), esc(r.last_settlement_year)].join(",");
    })
    .join("\n");

  res.send(header + body);
});

// ---------------------------------------------------------------------------
// GET /admin/il-cba-district-log
// Paginated per-district IL CBA crawl status, sourced from il_cba_crawl.json
// merged with a live DB join for district metadata + last settlement year +
// source_documents (so DB-indexed CBAs override stale/missing JSON state).
// Query params: page, limit, status (found|failed|search_failed|no_url|skip|not_crawled),
//               search (district name substring, case-insensitive),
//               sort (district_name|enrollment|crawl_status|last_attempted|last_settlement_year, default: enrollment),
//               dir (asc|desc, default: desc)
// ---------------------------------------------------------------------------
router.get("/admin/il-cba-district-log", requireAdminToken, async (req, res) => {
  const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
  const offset = (page - 1) * limit;

  const VALID_STATUSES = new Set(["found", "failed", "search_failed", "no_url", "skip", "not_crawled"]);
  const rawStatus = req.query.status ? String(req.query.status) : "";
  if (rawStatus && !VALID_STATUSES.has(rawStatus)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}` });
    return;
  }
  const statusFilter = rawStatus || null;
  const searchFilter = req.query.search ? String(req.query.search).toLowerCase().trim() : null;

  const VALID_SORT_COLS = new Set(["district_name", "enrollment", "crawl_status", "last_attempted", "last_settlement_year"]);
  const rawSort = req.query.sort ? String(req.query.sort) : "enrollment";
  const sortCol = VALID_SORT_COLS.has(rawSort) ? rawSort : "enrollment";
  const sortDir = req.query.dir === "asc" ? "asc" : "desc";

  // Load per-district crawl data from JSON (keyed by RCDTS / state_district_id)
  let perDistrict: Record<string, {
    status: string;
    timestamp?: string;
    url?: string;
    found_via?: string;
    storage_key?: string;
  }> = {};

  if (existsSync(IL_CBA_CRAWL_STATE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(IL_CBA_CRAWL_STATE_PATH, "utf-8")) as Record<string, unknown>;
      perDistrict = (raw["per_district"] as typeof perDistrict) ?? {};
    } catch {
      perDistrict = {};
    }
  }

  // Load all IL districts from DB with last settlement year + live source_documents evidence.
  // The LEFT JOIN on source_documents lets DB-indexed CBAs override stale/missing JSON entries.
  const dbRows = await db.execute(sql.raw(`
    SELECT
      d.id,
      d.name,
      d.county,
      d.enrollment,
      d.website_url,
      d.state_district_id,
      MAX(s.to_year)   AS last_settlement_year,
      MAX(sd.id)       AS sd_id,
      MAX(sd.source_url)    AS sd_source_url,
      MAX(sd.storage_key)   AS sd_storage_key,
      MAX(sd.retrieved_at)  AS sd_created_at
    FROM districts d
    LEFT JOIN settlements s   ON s.district_id  = d.id
    LEFT JOIN source_documents sd
           ON sd.district_id = d.id
          AND sd.doc_type    = 'cba_pdf'
    WHERE d.state = 'IL'
    GROUP BY d.id, d.name, d.county, d.enrollment, d.website_url, d.state_district_id
    ORDER BY d.name
  `));

  type DbDistrict = {
    id: number;
    name: string;
    county: string | null;
    enrollment: number | null;
    website_url: string | null;
    state_district_id: string | null;
    last_settlement_year: string | number | null;
    sd_id: number | null;
    sd_source_url: string | null;
    sd_storage_key: string | null;
    sd_created_at: string | null;
  };

  // Merge DB rows with JSON crawl data.
  // DB source_documents evidence is authoritative when present — it overrides
  // stale or missing JSON entries so a district with an indexed CBA is never
  // shown as "not_crawled" or "failed".
  const merged = (dbRows.rows as DbDistrict[]).map((d) => {
    const rcdts  = d.state_district_id ?? "";
    const crawl  = perDistrict[rcdts] ?? null;
    const hasDbCba = d.sd_id != null;

    let crawlStatus: string;
    let pdfUrl: string | null;
    let storageKey: string | null;
    let lastAttempted: string | null;
    let foundVia: string | null;

    if (hasDbCba) {
      // DB evidence is authoritative: district has an indexed CBA PDF
      crawlStatus   = "found";
      pdfUrl        = d.sd_source_url;
      storageKey    = d.sd_storage_key ?? crawl?.storage_key ?? null;
      lastAttempted = d.sd_created_at ?? crawl?.timestamp ?? null;
      foundVia      = crawl?.found_via ?? null;
    } else if (crawl) {
      // No DB CBA but JSON crawl entry exists — trust JSON status
      crawlStatus   = crawl.status;
      pdfUrl        = crawl.url ?? null;
      storageKey    = crawl.storage_key ?? null;
      lastAttempted = crawl.timestamp ?? null;
      foundVia      = crawl.found_via ?? null;
    } else {
      // No JSON entry and no DB record — derive from whether the district has a URL
      crawlStatus   = d.website_url ? "not_crawled" : "no_url";
      pdfUrl        = null;
      storageKey    = null;
      lastAttempted = null;
      foundVia      = null;
    }

    return {
      district_name:        d.name,
      county:               d.county,
      enrollment:           d.enrollment,
      website_url:          d.website_url,
      state_district_id:    rcdts,
      crawl_status:         crawlStatus,
      last_attempted:       lastAttempted,
      storage_key:          storageKey,
      pdf_url:              pdfUrl,
      found_via:            foundVia,
      last_settlement_year: d.last_settlement_year,
    };
  });

  // Apply filters
  const filtered = merged.filter((row) => {
    if (statusFilter && row.crawl_status !== statusFilter) return false;
    if (searchFilter && !row.district_name.toLowerCase().includes(searchFilter)) return false;
    return true;
  });

  // Apply sort
  type MergedRow = typeof filtered[number];
  filtered.sort((a: MergedRow, b: MergedRow) => {
    let aVal: string | number | null;
    let bVal: string | number | null;
    switch (sortCol) {
      case "district_name":
        aVal = a.district_name.toLowerCase();
        bVal = b.district_name.toLowerCase();
        break;
      case "enrollment":
        aVal = a.enrollment ?? -1;
        bVal = b.enrollment ?? -1;
        break;
      case "crawl_status":
        aVal = a.crawl_status;
        bVal = b.crawl_status;
        break;
      case "last_attempted":
        aVal = a.last_attempted ?? "";
        bVal = b.last_attempted ?? "";
        break;
      case "last_settlement_year":
        aVal = a.last_settlement_year != null ? Number(a.last_settlement_year) : -1;
        bVal = b.last_settlement_year != null ? Number(b.last_settlement_year) : -1;
        break;
      default:
        aVal = a.enrollment ?? -1;
        bVal = b.enrollment ?? -1;
    }
    if (aVal === bVal) return 0;
    const cmp = aVal < bVal ? -1 : 1;
    return sortDir === "asc" ? cmp : -cmp;
  });

  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);

  res.json({
    items,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
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

    const auditSampRows = await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS n FROM contract_provisions WHERE is_audit_sample = true`),
    );
    const auditSampleCount = (auditSampRows.rows[0] as { n: number })?.n ?? 0;

    const auditRevRows = await db.execute(
      sql.raw(
        `SELECT COUNT(*)::int AS n FROM contract_provisions WHERE is_audit_sample = true AND human_verified = true`,
      ),
    );
    const auditReviewedCount = (auditRevRows.rows[0] as { n: number })?.n ?? 0;

    const auditAgrRows = await db.execute(
      sql.raw(
        `SELECT COUNT(*)::int AS n FROM contract_provisions WHERE is_audit_sample = true AND audit_verdict = 'agree'`,
      ),
    );
    const auditAgreedCount = (auditAgrRows.rows[0] as { n: number })?.n ?? 0;
    const auditAgreementRate =
      auditReviewedCount > 0
        ? Math.round((auditAgreedCount / auditReviewedCount) * 1000) / 10
        : null;

    // Per-state CBA doc counts and extraction run counts
    const stateDocRows = await db.execute(sql.raw(`
      SELECT COALESCE(d.state, 'OH') AS state, COUNT(*)::int AS total,
             COUNT(er.source_doc_id)::int AS processed
      FROM source_documents sd
      LEFT JOIN districts d ON d.id = sd.district_id
      LEFT JOIN (
        SELECT DISTINCT source_doc_id FROM extraction_runs WHERE status = 'success'
      ) er ON er.source_doc_id = sd.id
      WHERE sd.doc_type = 'cba_pdf'
      GROUP BY COALESCE(d.state, 'OH')
    `));
    const stateDocMap: Record<string, { total: number; processed: number }> = {};
    for (const r of stateDocRows.rows as { state: string; total: number; processed: number }[]) {
      stateDocMap[r.state] = { total: r.total, processed: r.processed };
    }

    const stateRunRows = await db.execute(sql.raw(`
      SELECT COALESCE(d.state, 'OH') AS state, er.status, COUNT(*)::int AS n
      FROM extraction_runs er
      LEFT JOIN source_documents sd ON sd.id = er.source_doc_id
      LEFT JOIN districts d ON d.id = sd.district_id
      GROUP BY COALESCE(d.state, 'OH'), er.status
    `));
    const stateRunMap: Record<string, Record<string, number>> = {};
    for (const r of stateRunRows.rows as { state: string; status: string; n: number }[]) {
      if (!stateRunMap[r.state]) stateRunMap[r.state] = {};
      stateRunMap[r.state][r.status] = r.n;
    }

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
      auditSampleCount,
      auditReviewedCount,
      auditAgreementRate,
      stateDocMap,
      stateRunMap,
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
              cp.is_audit_sample,
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
            WHERE (cp.confidence < 0.8 OR cp.is_audit_sample = true)
              AND NOT cp.human_verified
              AND cp.category = ${category}
            ORDER BY cp.is_audit_sample DESC, cp.confidence ASC, cp.id
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
              cp.is_audit_sample,
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
            WHERE (cp.confidence < 0.8 OR cp.is_audit_sample = true)
              AND NOT cp.human_verified
            ORDER BY cp.is_audit_sample DESC, cp.confidence ASC, cp.id
            LIMIT ${limit} OFFSET ${offset}
          `,
    );

    const countRows = await db.execute(
      category
        ? sql`SELECT COUNT(*)::int AS n FROM contract_provisions cp WHERE (cp.confidence < 0.8 OR cp.is_audit_sample = true) AND NOT cp.human_verified AND cp.category = ${category}`
        : sql`SELECT COUNT(*)::int AS n FROM contract_provisions cp WHERE (cp.confidence < 0.8 OR cp.is_audit_sample = true) AND NOT cp.human_verified`,
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
    // Check whether this provision is flagged as an audit sample (must not be deleted on reject)
    const sampCheck = await db.execute(
      sql`SELECT is_audit_sample FROM contract_provisions WHERE id = ${id}`,
    );
    const isAuditSample =
      ((sampCheck.rows[0] as { is_audit_sample?: boolean } | undefined)?.is_audit_sample) ?? false;

    if (action === "reject") {
      if (isAuditSample) {
        // Preserve audit samples — mark as disagree instead of deleting so the audit trail is intact.
        await db.execute(
          sql`UPDATE contract_provisions
              SET human_verified = true, audit_verdict = 'disagree'
              WHERE id = ${id}`,
        );
      } else {
        await db.execute(sql`DELETE FROM contract_provisions WHERE id = ${id}`);
      }
    } else if (action === "correct") {
      if (correctedValue === undefined) {
        res.status(400).json({ error: "correctedValue is required for action=correct" });
        return;
      }
      const numericVal = parseFloat(correctedValue);
      if (!isNaN(numericVal)) {
        await db.execute(
          sql`UPDATE contract_provisions
              SET human_verified  = true,
                  value_text      = ${correctedValue},
                  value_numeric   = ${numericVal},
                  audit_verdict   = ${isAuditSample ? "disagree" : null}
              WHERE id = ${id}`,
        );
      } else {
        await db.execute(
          sql`UPDATE contract_provisions
              SET human_verified  = true,
                  value_text      = ${correctedValue},
                  audit_verdict   = ${isAuditSample ? "disagree" : null}
              WHERE id = ${id}`,
        );
      }
    } else {
      // approve
      await db.execute(
        sql`UPDATE contract_provisions
            SET human_verified = true,
                audit_verdict  = ${isAuditSample ? "agree" : null}
            WHERE id = ${id}`,
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/il-eis-crosscheck
// IL settlements with EIS cross-check: our base_increase_pct vs EIS-observed
// salary change, flagged when they differ by > 2 pp.
// ---------------------------------------------------------------------------
router.get("/admin/il-eis-crosscheck", requireAdminToken, async (req, res) => {
  const flaggedOnly = req.query.flagged_only !== "false";
  const page  = Math.max(1, parseInt(String(req.query.page  ?? "1"),  10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10)));
  const offset = (page - 1) * limit;

  try {
    const rows = await db.execute(sql`
      SELECT
        d.name                                        AS district_name,
        d.state_district_id,
        d.slug,
        s.id                                          AS settlement_id,
        s.from_year,
        s.to_year,
        s.base_increase_pct,
        eis_curr.avg_teacher_salary                   AS eis_avg_salary,
        eis_prev.avg_teacher_salary                   AS eis_prev_avg_salary,
        CASE WHEN eis_prev.avg_teacher_salary > 0
          THEN ROUND(
            ((eis_curr.avg_teacher_salary - eis_prev.avg_teacher_salary)
             / eis_prev.avg_teacher_salary) * 100, 2)
          ELSE NULL
        END                                           AS eis_observed_change_pct,
        CASE
          WHEN s.base_increase_pct IS NOT NULL
               AND eis_curr.avg_teacher_salary IS NOT NULL
               AND eis_prev.avg_teacher_salary > 0
               AND ABS(
                 s.base_increase_pct -
                 ROUND(((eis_curr.avg_teacher_salary - eis_prev.avg_teacher_salary)
                        / eis_prev.avg_teacher_salary) * 100, 2)
               ) > 2
          THEN true
          ELSE false
        END                                           AS eis_flag
      FROM settlements s
      JOIN districts d ON d.id = s.district_id
      JOIN il_eis_district eis_curr
        ON eis_curr.state_district_id = d.state_district_id
        AND eis_curr.school_year = s.from_year
      JOIN il_eis_district eis_prev
        ON eis_prev.state_district_id = d.state_district_id
        AND eis_prev.school_year =
          (CAST(LEFT(s.from_year, 4) AS INT) - 1)::TEXT
          || '-' ||
          RIGHT(CAST(LEFT(s.from_year, 4) AS INT)::TEXT, 2)
      WHERE d.state = 'IL'
        AND s.base_increase_pct IS NOT NULL
        AND eis_curr.avg_teacher_salary IS NOT NULL
        AND eis_prev.avg_teacher_salary > 0
        ${flaggedOnly ? sql`AND ABS(
            s.base_increase_pct -
            ROUND(((eis_curr.avg_teacher_salary - eis_prev.avg_teacher_salary)
                   / eis_prev.avg_teacher_salary) * 100, 2)
          ) > 2` : sql``}
      ORDER BY ABS(
        COALESCE(s.base_increase_pct, 0) -
        ROUND(((eis_curr.avg_teacher_salary - eis_prev.avg_teacher_salary)
               / eis_prev.avg_teacher_salary) * 100, 2)
      ) DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const countRow = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM settlements s
      JOIN districts d ON d.id = s.district_id
      JOIN il_eis_district eis_curr
        ON eis_curr.state_district_id = d.state_district_id AND eis_curr.school_year = s.from_year
      JOIN il_eis_district eis_prev
        ON eis_prev.state_district_id = d.state_district_id
        AND eis_prev.school_year =
          (CAST(LEFT(s.from_year, 4) AS INT) - 1)::TEXT || '-' ||
          RIGHT(CAST(LEFT(s.from_year, 4) AS INT)::TEXT, 2)
      WHERE d.state = 'IL'
        AND s.base_increase_pct IS NOT NULL
        AND eis_curr.avg_teacher_salary IS NOT NULL
        AND eis_prev.avg_teacher_salary > 0
        ${flaggedOnly ? sql`AND ABS(
            s.base_increase_pct -
            ROUND(((eis_curr.avg_teacher_salary - eis_prev.avg_teacher_salary)
                   / eis_prev.avg_teacher_salary) * 100, 2)
          ) > 2` : sql``}
    `);

    res.json({
      items: rows.rows,
      total: (countRow.rows[0] as { n: number }).n,
      page,
      limit,
      pages: Math.ceil((countRow.rows[0] as { n: number }).n / limit),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/start-il-crawl
// Spawns the IL CBA crawler as a detached child process of the API server
// (which is a persistent Replit workflow) so it survives tool-call boundaries.
// ---------------------------------------------------------------------------

const PIPELINE_DIR = join(process.cwd(), "..", "..", "pipeline");
const IL_CRAWL_LOG = join(PIPELINE_DIR, "logs", "il_cba_crawl.log");

let _crawlPid: number | null = null;

router.post("/admin/start-il-crawl", requireAdminToken, (req, res) => {
  if (_crawlPid !== null) {
    // Check if still alive
    try {
      process.kill(_crawlPid, 0);
      res.json({ status: "already_running", pid: _crawlPid });
      return;
    } catch {
      _crawlPid = null;
    }
  }

  try {
    mkdirSync(join(PIPELINE_DIR, "logs"), { recursive: true });
    // openSync gives a real fd that spawn can accept in the stdio array
    const logFd = openSync(IL_CRAWL_LOG, "a");

    const args = (req.body as Record<string, string | boolean>);
    const extraArgs: string[] = [];
    if (args?.search_fallback) extraArgs.push("--search-fallback");
    if (args?.limit) extraArgs.push("--limit", String(args.limit));

    const child = spawn(
      "python3",
      ["-u", join(PIPELINE_DIR, "11_crawl_il_cbas.py"), ...extraArgs],
      {
        cwd: PIPELINE_DIR,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, PYTHONPATH: PIPELINE_DIR },
      },
    );
    child.unref();
    _crawlPid = child.pid ?? null;

    res.json({ status: "started", pid: _crawlPid, log: IL_CRAWL_LOG });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/admin/il-crawl-status", requireAdminToken, (_req, res) => {
  let running = false;
  if (_crawlPid !== null) {
    try { process.kill(_crawlPid, 0); running = true; } catch { _crawlPid = null; }
  }
  let tailLines: string[] = [];
  try {
    const content = readFileSync(IL_CRAWL_LOG, "utf8");
    tailLines = content.split("\n").filter(Boolean).slice(-30);
  } catch { /* log may not exist yet */ }
  res.json({ running, pid: _crawlPid, tail: tailLines });
});

export default router;
