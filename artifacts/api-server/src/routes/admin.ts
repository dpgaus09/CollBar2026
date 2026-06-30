import { Router, raw, json, type IRouter, type Request, type Response, type NextFunction } from "express";
import { readFileSync, existsSync, openSync, writeFileSync } from "fs";
import { mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { spawn } from "child_process";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { VALID_BARGAINING_UNITS, BARGAINING_UNIT_LABELS } from "./bargaining-units.js";
import { runPromotion } from "../lib/promote.js";
import { uploadBuffer, uploadedCbaKey } from "../lib/objectStorage.js";
import { recordNewContractAlert } from "../lib/alert-detection.js";
import {
  parseDriveFolderId,
  listFolderTree,
  downloadDriveFile,
  exportGoogleSheetCsv,
  SHEET_MIME,
  DriveNotConnectedError,
  type DriveFile,
  type FolderScanProgress,
} from "../lib/google-drive.js";
import {
  mapManifestColumns,
  matchEntries,
  isPdfFile,
} from "../lib/bulk-cba.js";
import { enqueueJob, listJobs, getQueueStats } from "../extraction/jobs/queue.js";
import { heavyAdminLimiter } from "../lib/rateLimit.js";
import {
  getVersionsForDoc,
  getPromotions,
  diffAgainstPromoted,
  promoteVersion,
} from "../extraction/jobs/versions.js";

declare module "express-session" {
  interface SessionData {
    adminAuthenticated?: boolean;
    userId?: number;
  }
}

const router: IRouter = Router();

/**
 * Resolve the repo-root `pipeline/` directory regardless of the process CWD.
 * In dev, pnpm runs this package from artifacts/api-server, so ../../pipeline
 * works; in a deployment the CWD is the workspace root, where ../../pipeline
 * wrongly resolves to /home/pipeline (the reported "can't open file" error).
 * Walk up from the CWD until we find the dir that actually holds the scripts.
 */
function resolvePipelineDir(): string {
  const override = process.env.COLLBAR_PIPELINE_DIR;
  if (override) {
    // Normalize to absolute so it resolves correctly when used as a spawn cwd
    // or joined for child-script args, regardless of the current CWD.
    const abs = resolve(override);
    if (existsSync(join(abs, "06_extract_contracts.py"))) {
      return abs;
    }
  }
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "pipeline");
    if (existsSync(join(candidate, "06_extract_contracts.py"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: the original dev-relative guess (preserves prior behavior).
  // Warn loudly so a deployment without the pipeline/ dir fails visibly
  // instead of silently re-introducing the /home/pipeline bug.
  const fallback = join(process.cwd(), "..", "..", "pipeline");
  console.warn(
    `[admin] Could not locate pipeline/06_extract_contracts.py by walking up from ${process.cwd()}; ` +
      `falling back to ${fallback}. Set COLLBAR_PIPELINE_DIR to an absolute path if extraction fails.`,
  );
  return fallback;
}

const PIPELINE_DIR = resolvePipelineDir();

const CRAWL_STATE_PATH = join(PIPELINE_DIR, "state", "crawl_state.json");

const IL_CBA_CRAWL_STATE_PATH = join(PIPELINE_DIR, "state", "il_cba_crawl.json");

const IL_UNFOUND_CSV_PATH = join(PIPELINE_DIR, "data", "il_cba_unfound.csv");

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
// Checks that the request carries a valid admin session (set via
// POST /api/auth/login with admin credentials).
// ---------------------------------------------------------------------------
function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  if (req.session.adminAuthenticated) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized: admin login required" });
}

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
  req.session.destroy((err) => {
    if (err) console.error("Session destroy error during admin logout:", err);
    res.json({ ok: true });
  });
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

  // CBA coverage broken down by bargaining unit (distinct districts + contract count)
  const buRows = await db.execute(
    sql.raw(`
      SELECT c.bargaining_unit AS unit,
             COUNT(DISTINCT c.district_id)::int AS districts,
             COUNT(*)::int AS contracts
      FROM contracts c
      JOIN districts d ON d.id = c.district_id
      WHERE d.state = 'IL'
      GROUP BY c.bargaining_unit
      ORDER BY contracts DESC, c.bargaining_unit
    `),
  );
  const byBargainingUnit = (buRows.rows as { unit: string; districts: number; contracts: number }[]).map(
    (r) => ({ unit: r.unit, districts: r.districts, contracts: r.contracts }),
  );

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
    byBargainingUnit,
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

    // Failure reasons — bucketed by the error prefix of each document's *latest*
    // extraction run that ended in 'failed'. Latest-per-doc avoids double-counting
    // earlier failed attempts that later succeeded on retry.
    const failRows = await db.execute(sql.raw(`
      WITH latest AS (
        SELECT DISTINCT ON (source_doc_id) source_doc_id, status, error
        FROM extraction_runs
        ORDER BY source_doc_id, run_at DESC, id DESC
      )
      SELECT
        COALESCE(NULLIF(TRIM(split_part(error, ':', 1)), ''), 'unknown') AS reason,
        COUNT(*)::int AS n
      FROM latest
      WHERE status = 'failed'
      GROUP BY reason
      ORDER BY n DESC, reason
    `));
    const failureReasons = (failRows.rows as { reason: string; n: number }[]).map(
      (r) => ({ reason: r.reason, count: r.n }),
    );
    const failedDocCount = failureReasons.reduce((s, r) => s + r.count, 0);

    // Per-document list of currently-failing docs (latest run failed, no success
    // run exists). Powers the per-document Retry controls in the admin panel.
    const failedDocsRows = await db.execute(sql.raw(`
      WITH latest AS (
        SELECT DISTINCT ON (source_doc_id) source_doc_id, status, error, run_at
        FROM extraction_runs
        ORDER BY source_doc_id, run_at DESC, id DESC
      ),
      attempts AS (
        SELECT source_doc_id, COUNT(*)::int AS n
        FROM extraction_runs
        GROUP BY source_doc_id
      )
      SELECT
        l.source_doc_id                                       AS id,
        COALESCE(NULLIF(TRIM(l.error), ''), 'unknown')        AS error,
        a.n                                                   AS attempts,
        l.run_at                                              AS last_attempt_at,
        sd.school_year                                        AS school_year,
        COALESCE(d.name, '(unmatched)')                       AS district_name,
        COALESCE(d.state, 'OH')                               AS state
      FROM latest l
      JOIN source_documents sd ON sd.id = l.source_doc_id
      LEFT JOIN districts d ON d.id = sd.district_id
      JOIN attempts a ON a.source_doc_id = l.source_doc_id
      WHERE l.status = 'failed'
      ORDER BY a.n DESC, l.source_doc_id
      LIMIT 500
    `));
    const failedDocs = (failedDocsRows.rows as {
      id: number; error: string; attempts: number; last_attempt_at: string | null;
      school_year: string | null; district_name: string; state: string;
    }[]).map((r) => ({
      id: r.id,
      error: r.error,
      attempts: r.attempts,
      lastAttemptAt: r.last_attempt_at,
      schoolYear: r.school_year,
      districtName: r.district_name,
      state: r.state,
    }));

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
      failureReasons,
      failedDocCount,
      failedDocs,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
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

  // Optional filter on the OCR "unreadable/scanned" signal derived from the
  // latest extraction run per source document:
  //   unreadable=only → only items whose source PDF is flagged low-quality OCR
  //   unreadable=hide → only items whose source PDF is NOT flagged
  //   (absent)        → all items
  const rawUnreadable = req.query.unreadable ? String(req.query.unreadable) : "";
  if (rawUnreadable && !["only", "hide"].includes(rawUnreadable)) {
    res.status(400).json({ error: "Invalid unreadable filter. Must be 'only' or 'hide'." });
    return;
  }
  const unreadableFilter = rawUnreadable || null;
  const needsRunFilter = unreadableFilter !== null;

  // extraction_runs is append-per-attempt, so collapse to the newest run per doc
  // before trusting the OCR low-quality flag. A doc with no run (legacy / never
  // OCR'd) is NOT treated as unreadable — COALESCE(..., false).
  const latestRunCte = sql`
    latest_run AS (
      SELECT DISTINCT ON (source_doc_id) source_doc_id, ocr_low_quality
      FROM extraction_runs
      ORDER BY source_doc_id, run_at DESC, id DESC
    )
  `;

  // Shared WHERE predicate built from validated inputs.
  const conds: ReturnType<typeof sql>[] = [
    sql`cp.confidence < 0.8`,
    sql`NOT cp.human_verified`,
  ];
  if (category) conds.push(sql`cp.category = ${category}`);
  if (unreadableFilter === "only") conds.push(sql`COALESCE(lr.ocr_low_quality, false) = true`);
  if (unreadableFilter === "hide") conds.push(sql`COALESCE(lr.ocr_low_quality, false) = false`);
  const whereSql = sql.join(conds, sql` AND `);

  try {
    // Use Drizzle sql template for safe parameterization of user-supplied values.
    // Each item carries source_doc_id (to act on a whole document) and an
    // `unreadable` flag (latest-run OCR low-quality) for the review UI.
    const rows = await db.execute(sql`
      WITH ${latestRunCte}
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
        c.source_doc_id,
        c.union_name,
        c.unit_scope,
        c.effective_start,
        c.effective_end,
        sd.source_url,
        d.name            AS district_name,
        COALESCE(lr.ocr_low_quality, false) AS unreadable
      FROM contract_provisions cp
      JOIN contracts c ON cp.contract_id = c.id
      LEFT JOIN source_documents sd ON c.source_doc_id = sd.id
      LEFT JOIN districts d ON c.district_id = d.id
      LEFT JOIN latest_run lr ON lr.source_doc_id = c.source_doc_id
      WHERE ${whereSql}
      ORDER BY cp.confidence ASC, cp.id
      LIMIT ${limit} OFFSET ${offset}
    `);

    // Count uses the same predicate; only join the run CTE when the filter needs it.
    const countRows = await db.execute(
      needsRunFilter
        ? sql`
            WITH ${latestRunCte}
            SELECT COUNT(*)::int AS n
            FROM contract_provisions cp
            JOIN contracts c ON cp.contract_id = c.id
            LEFT JOIN latest_run lr ON lr.source_doc_id = c.source_doc_id
            WHERE ${whereSql}
          `
        : sql`
            SELECT COUNT(*)::int AS n
            FROM contract_provisions cp
            WHERE ${whereSql}
          `,
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
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
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
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
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
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
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
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/review-queue/bulk-dismiss
// Dismiss (reject) many low-confidence items in one call — by explicit provision
// ids and/or by an entire source document. Mirrors the single-reject semantics:
// audit-sample rows are preserved (human_verified=true, audit_verdict='disagree')
// while ordinary rows are deleted. Only acts on rows still in the review-queue
// scope (confidence < 0.8 AND NOT human_verified) so verified / high-confidence
// provisions are never touched.
// body: { ids?: number[], sourceDocId?: number }
// ---------------------------------------------------------------------------
router.post("/admin/review-queue/bulk-dismiss", requireAdminToken, async (req, res) => {
  const body = (req.body ?? {}) as { ids?: unknown; sourceDocId?: unknown };

  // Validate the explicit provision-id list (if any).
  let ids: number[] = [];
  if (body.ids != null) {
    if (!Array.isArray(body.ids)) {
      res.status(400).json({ error: "ids must be an array of provision ids" });
      return;
    }
    ids = body.ids.map((v) => Number(v));
    if (ids.some((n) => !Number.isSafeInteger(n) || n < 1)) {
      res.status(400).json({ error: "ids must all be positive integers" });
      return;
    }
    if (ids.length > 1000) {
      res.status(400).json({ error: "Too many ids (max 1000 per call)" });
      return;
    }
  }

  // Validate the optional whole-document target.
  let sourceDocId: number | null = null;
  if (body.sourceDocId != null && String(body.sourceDocId) !== "") {
    const n = Number(body.sourceDocId);
    if (!Number.isSafeInteger(n) || n < 1) {
      res.status(400).json({ error: "sourceDocId must be a positive integer" });
      return;
    }
    sourceDocId = n;
  }

  if (ids.length === 0 && sourceDocId === null) {
    res.status(400).json({ error: "Provide ids and/or sourceDocId to dismiss" });
    return;
  }

  // Selector: which provisions to target (union of the two inputs).
  const selectors: ReturnType<typeof sql>[] = [];
  if (sourceDocId !== null) selectors.push(sql`c.source_doc_id = ${sourceDocId}`);
  if (ids.length) selectors.push(sql`cp.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  const selectorSql = sql.join(selectors, sql` OR `);

  // Queue-scope guard — never alter verified or high-confidence provisions.
  const scopeSql = sql`cp.confidence < 0.8 AND NOT cp.human_verified`;

  try {
    const result = await db.transaction(async (tx) => {
      // Preserve audit samples: mark as disagree instead of deleting.
      const updated = await tx.execute(sql`
        UPDATE contract_provisions cp
        SET human_verified = true, audit_verdict = 'disagree'
        FROM contracts c
        WHERE cp.contract_id = c.id
          AND ${scopeSql}
          AND cp.is_audit_sample
          AND (${selectorSql})
      `);
      // Delete the ordinary low-confidence junk rows.
      const deleted = await tx.execute(sql`
        DELETE FROM contract_provisions cp
        USING contracts c
        WHERE cp.contract_id = c.id
          AND ${scopeSql}
          AND NOT cp.is_audit_sample
          AND (${selectorSql})
      `);
      return {
        preserved: (updated as unknown as { rowCount?: number }).rowCount ?? 0,
        deleted: (deleted as unknown as { rowCount?: number }).rowCount ?? 0,
      };
    });

    res.json({
      ok: true,
      deleted: result.deleted,
      preserved: result.preserved,
      total: result.deleted + result.preserved,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
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
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// IL CBA Crawler — exported spawn helper (used by cron in index.ts) + routes
// ---------------------------------------------------------------------------

const IL_CRAWL_LOG = join(PIPELINE_DIR, "logs", "il_cba_crawl.log");
const EXTRACTION_CRON_LOG = join(PIPELINE_DIR, "logs", "extraction_cron.log");

let _crawlPid: number | null = null;
let _crawlLastRunAt: Date | null = null;
let _crawlLastStatus: "running" | "success" | "error" | null = null;

let _extractionCronPid: number | null = null;
let _extractionCronLastRunAt: Date | null = null;
let _extractionCronLastStatus: "running" | "success" | "error" | null = null;

export function spawnIlCrawl(extraArgs: string[] = []): { status: string; pid: number | null } {
  if (_crawlPid !== null) {
    try {
      process.kill(_crawlPid, 0);
      return { status: "already_running", pid: _crawlPid };
    } catch {
      _crawlPid = null;
    }
  }

  mkdirSync(join(PIPELINE_DIR, "logs"), { recursive: true });
  const logFd = openSync(IL_CRAWL_LOG, "a");

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
  _crawlLastRunAt = new Date();
  _crawlLastStatus = "running";
  child.on("exit", (code) => {
    _crawlLastStatus = code === 0 ? "success" : "error";
    _crawlPid = null;
  });
  child.unref();
  _crawlPid = child.pid ?? null;
  return { status: "started", pid: _crawlPid };
}

router.post("/admin/start-il-crawl", requireAdminToken, heavyAdminLimiter, (req, res) => {
  try {
    const args = (req.body as Record<string, string | boolean>);
    const extraArgs: string[] = [];
    if (args?.search_fallback) extraArgs.push("--search-fallback");
    if (args?.limit) extraArgs.push("--limit", String(args.limit));
    const result = spawnIlCrawl(extraArgs);
    res.json({ ...result, log: IL_CRAWL_LOG });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/il-crawl-status", requireAdminToken, (_req, res) => {
  let running = false;
  if (_crawlPid !== null) {
    try { process.kill(_crawlPid, 0); running = true; } catch { _crawlPid = null; }
  }
  if (!running && _crawlLastStatus === "running") _crawlLastStatus = null;
  let tailLines: string[] = [];
  try {
    const content = readFileSync(IL_CRAWL_LOG, "utf8");
    tailLines = content.split("\n").filter(Boolean).slice(-30);
  } catch { /* log may not exist yet */ }
  res.json({
    running,
    pid: _crawlPid,
    tail: tailLines,
    lastRunAt: _crawlLastRunAt?.toISOString() ?? null,
    lastStatus: running ? "running" : (_crawlLastStatus ?? null),
  });
});

// ---------------------------------------------------------------------------
// Extraction Cron — exported spawn helper (used by cron in index.ts) + routes
// ---------------------------------------------------------------------------

export function spawnExtractionCron(): { status: string; pid: number | null } {
  if (_extractionCronPid !== null) {
    try {
      process.kill(_extractionCronPid, 0);
      return { status: "already_running", pid: _extractionCronPid };
    } catch {
      _extractionCronPid = null;
    }
  }

  mkdirSync(join(PIPELINE_DIR, "logs"), { recursive: true });
  const logFd = openSync(EXTRACTION_CRON_LOG, "a");

  const child = spawn(
    "python3",
    ["-u", join(PIPELINE_DIR, "08_cron_incremental.py")],
    {
      cwd: PIPELINE_DIR,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PYTHONPATH: PIPELINE_DIR },
    },
  );
  _extractionCronLastRunAt = new Date();
  _extractionCronLastStatus = "running";
  child.on("exit", (code) => {
    _extractionCronLastStatus = code === 0 ? "success" : "error";
    _extractionCronPid = null;
  });
  child.unref();
  _extractionCronPid = child.pid ?? null;
  return { status: "started", pid: _extractionCronPid };
}

router.post("/admin/run-extraction-cron", requireAdminToken, heavyAdminLimiter, (_req, res) => {
  try {
    const result = spawnExtractionCron();
    res.json({ ...result, log: EXTRACTION_CRON_LOG });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/extraction-cron-status", requireAdminToken, (_req, res) => {
  let running = false;
  if (_extractionCronPid !== null) {
    try { process.kill(_extractionCronPid, 0); running = true; } catch { _extractionCronPid = null; }
  }
  if (!running && _extractionCronLastStatus === "running") _extractionCronLastStatus = null;
  let tailLines: string[] = [];
  try {
    const content = readFileSync(EXTRACTION_CRON_LOG, "utf8");
    tailLines = content.split("\n").filter(Boolean).slice(-30);
  } catch { /* log may not exist yet */ }
  res.json({
    running,
    pid: _extractionCronPid,
    tail: tailLines,
    lastRunAt: _extractionCronLastRunAt?.toISOString() ?? null,
    lastStatus: running ? "running" : (_extractionCronLastStatus ?? null),
  });
});

// ---------------------------------------------------------------------------
// Extraction Retry — re-run extraction for a single failing doc (--doc-id) or
// all currently-failing docs (--retry-failed). Lets admins clear extraction
// failures from the panel without shell access.
// ---------------------------------------------------------------------------

const EXTRACTION_RETRY_LOG = join(PIPELINE_DIR, "logs", "extraction_retry.log");

let _retryPid: number | null = null;
let _retryLastRunAt: Date | null = null;
let _retryLastStatus: "running" | "success" | "error" | null = null;
let _retryLastDocId: number | null = null;

export function spawnExtractionRetry(
  docId?: number,
): { status: string; pid: number | null } {
  if (_retryPid !== null) {
    try {
      process.kill(_retryPid, 0);
      return { status: "already_running", pid: _retryPid };
    } catch {
      _retryPid = null;
    }
  }

  mkdirSync(join(PIPELINE_DIR, "logs"), { recursive: true });
  const logFd = openSync(EXTRACTION_RETRY_LOG, "a");

  const scriptArgs = ["-u", join(PIPELINE_DIR, "06_extract_contracts.py")];
  if (docId != null) {
    scriptArgs.push("--doc-id", String(docId));
  } else {
    scriptArgs.push("--retry-failed");
  }

  const child = spawn("python3", scriptArgs, {
    cwd: PIPELINE_DIR,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PYTHONPATH: PIPELINE_DIR },
  });
  _retryLastRunAt = new Date();
  _retryLastStatus = "running";
  _retryLastDocId = docId ?? null;
  child.on("exit", (code) => {
    _retryLastStatus = code === 0 ? "success" : "error";
    _retryPid = null;
  });
  child.unref();
  _retryPid = child.pid ?? null;
  return { status: "started", pid: _retryPid };
}

router.post("/admin/retry-extraction", requireAdminToken, heavyAdminLimiter, (req, res) => {
  void (async () => {
    try {
      const body = (req.body ?? {}) as { docId?: number | string };
      const requestedBy = requestedByFromReq(req);
      if (body.docId !== undefined && body.docId !== null && body.docId !== "") {
        const parsed = parseInt(String(body.docId), 10);
        if (isNaN(parsed) || parsed < 1) {
          res.status(400).json({ error: "docId must be a positive integer" });
          return;
        }
        const { job, deduped } = await enqueueJob({
          sourceDocId: parsed,
          domain: "cba",
          requestedBy,
          requestReason: "retry-extraction",
        });
        res.json({ status: "queued", jobId: job.id, deduped, docId: parsed });
        return;
      }
      // No docId: re-enqueue every doc that has a currently-failed job.
      const failed = await db.execute(sql`
        SELECT DISTINCT source_doc_id::int AS id FROM extraction_jobs WHERE status = 'failed'
      `);
      let enqueued = 0;
      for (const r of failed.rows as Array<{ id: number }>) {
        const { deduped } = await enqueueJob({
          sourceDocId: r.id,
          domain: "cba",
          requestedBy,
          requestReason: "retry-failed",
        });
        if (!deduped) enqueued++;
      }
      res.json({ status: "queued", enqueued, docId: null });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  })();
});

router.get("/admin/retry-extraction-status", requireAdminToken, (_req, res) => {
  let running = false;
  if (_retryPid !== null) {
    try { process.kill(_retryPid, 0); running = true; } catch { _retryPid = null; }
  }
  if (!running && _retryLastStatus === "running") _retryLastStatus = null;
  let tailLines: string[] = [];
  try {
    const content = readFileSync(EXTRACTION_RETRY_LOG, "utf8");
    tailLines = content.split("\n").filter(Boolean).slice(-30);
  } catch { /* log may not exist yet */ }
  res.json({
    running,
    pid: _retryPid,
    tail: tailLines,
    docId: _retryLastDocId,
    lastRunAt: _retryLastRunAt?.toISOString() ?? null,
    lastStatus: running ? "running" : (_retryLastStatus ?? null),
  });
});

// ---------------------------------------------------------------------------
// Manual CBA upload — an admin attaches a PDF, assigns its district +
// bargaining unit (+ optional school year), we store it locally and kick off
// single-doc LLM extraction (reusing the extraction-retry spawn + status).
// ---------------------------------------------------------------------------

const IL_CBA_PDF_DIR = join(PIPELINE_DIR, "data", "il_cba");
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024; // 64 MB
const uploadPdfBody = raw({ type: () => true, limit: MAX_UPLOAD_BYTES });

/** Normalize a school-year input to the canonical YYYY-YY form (or null). */
function normalizeSchoolYear(
  rawValue: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (rawValue == null) return { ok: true, value: null };
  const s = String(rawValue).trim();
  if (!s) return { ok: true, value: null };
  let v = s;
  const short = /^(\d{2})-(\d{2})$/.exec(s);
  if (short) v = `20${short[1]}-${short[2]}`;
  if (!/^\d{4}-\d{2}$/.test(v) || v.length > 7) return { ok: false };
  return { ok: true, value: v };
}

/** Reduce an uploaded filename to a safe display marker. */
function sanitizeFilename(rawValue: unknown): string {
  const base = String(rawValue ?? "upload.pdf").split(/[\\/]/).pop() || "upload.pdf";
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "upload.pdf";
}

/** Best-effort admin identity for job attribution (session user id or "admin"). */
function requestedByFromReq(req: Request): string {
  const uid = req.session?.userId;
  return uid != null ? `user:${uid}` : "admin";
}

/**
 * Ensure a minimal contracts row exists for an uploaded document so a later
 * promotion can ATTACH extracted salary/provisions to it (the store functions
 * match on contracts.source_doc_id). Python used to create this row; the
 * in-process upload path must do it explicitly. unit_scope is left NULL so the
 * (district, unit, scope, start) unique key never collides with a crawled
 * contract — each distinct upload gets its own attachable row. effective_start
 * is derived from the school year when available (better display/sorting; v1
 * extraction does not parse contract dates).
 */
async function ensureContractForUpload(
  sourceDocId: number,
  districtId: number,
  unit: string,
  schoolYear: string | null,
  unitOverride = false,
): Promise<{ contractId: string | null }> {
  const existing = await db.execute(sql`
    SELECT id::text AS id FROM contracts WHERE source_doc_id = ${sourceDocId} LIMIT 1
  `);
  if (existing.rows.length) {
    return { contractId: (existing.rows[0] as { id: string }).id };
  }
  let effectiveStart: string | null = null;
  if (schoolYear) {
    const m = /^(\d{4})-\d{2}$/.exec(schoolYear);
    if (m) effectiveStart = `${m[1]}-07-01`;
  }
  const inserted = await db.execute(sql`
    INSERT INTO contracts (district_id, bargaining_unit, effective_start, source_doc_id, unit_override)
    VALUES (${districtId}, ${unit}, ${effectiveStart}, ${sourceDocId}, ${unitOverride})
    ON CONFLICT (district_id, bargaining_unit, unit_scope, effective_start) DO NOTHING
    RETURNING id::text AS id
  `);
  if (inserted.rows.length) {
    return { contractId: (inserted.rows[0] as { id: string }).id };
  }
  // Conflict: a contract for the same (district, unit, scope, start) already
  // exists pointing at another doc. The version is still recorded for audit, but
  // promotion will find zero targets and surface needs_review.
  console.warn(
    `[admin] ensureContractForUpload: could not attach a contract for doc ${sourceDocId} ` +
      `(district ${districtId}, unit ${unit}); promotion will report needs_review.`,
  );
  return { contractId: null };
}

async function handleCbaUpload(req: Request, res: Response): Promise<void> {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    res.status(400).json({ error: "No file received" });
    return;
  }

  // Validate it is a real PDF by its magic bytes, not just the extension.
  if (buf.subarray(0, 1024).indexOf(Buffer.from("%PDF")) === -1) {
    res.status(400).json({ error: "File is not a valid PDF (missing %PDF header)" });
    return;
  }

  const districtId = parseInt(String(req.query.district_id ?? ""), 10);
  if (isNaN(districtId) || districtId < 1) {
    res.status(400).json({ error: "district_id is required and must be a positive integer" });
    return;
  }

  const unit = req.query.bargaining_unit ? String(req.query.bargaining_unit) : "teachers";
  if (!VALID_BARGAINING_UNITS.has(unit)) {
    res.status(400).json({ error: `Invalid bargaining_unit: ${unit}` });
    return;
  }

  const sy = normalizeSchoolYear(req.query.school_year);
  if (!sy.ok) {
    res.status(400).json({ error: "school_year must look like 2026-27" });
    return;
  }
  const schoolYear = sy.value;
  const filename = sanitizeFilename(req.query.filename);

  // The district must already exist (no district creation from this screen).
  const distRows = await db.execute(sql`
    SELECT id, name, state FROM districts WHERE id = ${districtId}
  `);
  const district = distRows.rows[0] as
    | { id: number; name: string; state: string }
    | undefined;
  if (!district) {
    res.status(404).json({ error: `District ${districtId} not found` });
    return;
  }

  // Dedup on (district, bargaining unit, file hash) before writing anything.
  const fileHash = createHash("sha256").update(buf).digest("hex");
  const existing = await db.execute(sql`
    SELECT id FROM source_documents
    WHERE district_id = ${districtId}
      AND bargaining_unit = ${unit}
      AND file_hash = ${fileHash}
    LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const existingId = Number((existing.rows[0] as { id: number }).id);
    // Has this existing copy ever been extracted successfully? If a prior
    // attempt failed before recording an extraction_run (e.g. the pipeline
    // path bug), the doc is stranded: dedup blocks re-upload AND nothing shows
    // up in the Extraction tab to retry. In that case, re-trigger extraction on
    // the existing doc rather than dead-ending the admin.
    const succeeded = await db.execute(sql`
      SELECT 1 FROM extraction_runs
      WHERE source_doc_id = ${existingId} AND status = 'success'
      LIMIT 1
    `);
    if (succeeded.rows.length === 0) {
      await ensureContractForUpload(existingId, districtId, unit, schoolYear);
      const { job, deduped } = await enqueueJob({
        sourceDocId: existingId,
        domain: "cba",
        requestedBy: requestedByFromReq(req),
        requestReason: "upload-reextract",
      });
      res.json({
        ok: true,
        alreadyExists: true,
        reextracted: true,
        sourceDocId: existingId,
        districtName: district.name,
        bargainingUnit: unit,
        extraction: { status: "queued", jobId: job.id, deduped },
      });
      return;
    }
    res.status(409).json({
      error: "This exact PDF is already on file and has already been extracted.",
      alreadyExists: true,
      alreadyExtracted: true,
      sourceDocId: existingId,
      districtName: district.name,
    });
    return;
  }

  // Persist the file locally under the pipeline data dir (resolve_pdf_path
  // reads the absolute `local:` storage_key first).
  mkdirSync(IL_CBA_PDF_DIR, { recursive: true });
  const absPath = join(IL_CBA_PDF_DIR, `${fileHash}.pdf`);
  writeFileSync(absPath, buf);
  // Persist to object storage so the PDF is servable in production: the local
  // filesystem is dev-only (excluded from the deployment image) and autoscale
  // instances are stateless. This MUST succeed before we record the document —
  // otherwise its source link would 404 ("Document file missing") in prod, the
  // exact bug this guards against. We do not insert a row we can't serve. The
  // local copy above is retained for the dev extraction pipeline.
  try {
    await uploadBuffer(uploadedCbaKey(fileHash), buf);
  } catch (err) {
    console.error("Object storage upload failed for uploaded CBA", fileHash, err);
    res.status(502).json({
      error:
        "Could not save the PDF to durable storage, so it was not added. Please try again.",
    });
    return;
  }
  const storageKey = `local:${absPath}`;
  const sourceUrl = `upload://district-${districtId}/${unit}/${filename}`;

  let sourceDocId: number;
  try {
    const inserted = await db.execute(sql`
      INSERT INTO source_documents
        (district_id, doc_type, bargaining_unit, source_url, file_hash, storage_key, school_year)
      VALUES
        (${districtId}, 'cba_pdf', ${unit}, ${sourceUrl}, ${fileHash}, ${storageKey}, ${schoolYear})
      RETURNING id
    `);
    sourceDocId = Number((inserted.rows[0] as { id: number }).id);
  } catch (err) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      res.status(409).json({
        error: "This PDF is already on file (matched on content).",
        alreadyExists: true,
        districtName: district.name,
      });
      return;
    }
    throw err;
  }

  // Phase 6 — a genuinely new CBA document (the duplicate path returned a 409
  // above) fires exactly one 'new_doc' (new contract) alert for any firm that
  // subscribes this district. Best-effort + idempotent on source_doc_id.
  await recordNewContractAlert({
    sourceDocId,
    districtId,
    docName: filename,
    sourceUrl,
    fileHash,
  });

  // Ensure a contracts row exists so promotion can attach extracted data, then
  // enqueue a single-doc extraction job for the in-process worker to run.
  await ensureContractForUpload(sourceDocId, districtId, unit, schoolYear);
  const { job, deduped } = await enqueueJob({
    sourceDocId,
    domain: "cba",
    requestedBy: requestedByFromReq(req),
    requestReason: "upload",
  });

  res.json({
    ok: true,
    sourceDocId,
    districtName: district.name,
    bargainingUnit: unit,
    schoolYear,
    fileBytes: buf.length,
    extraction: { status: "queued", jobId: job.id, deduped },
  });
}

router.post("/admin/upload-cba", requireAdminToken, heavyAdminLimiter, (req, res) => {
  uploadPdfBody(req, res, (err?: unknown) => {
    if (err) {
      const status =
        (err as { status?: number }).status ??
        (err as { statusCode?: number }).statusCode;
      if (status === 413) {
        res.status(413).json({ error: "File too large (max 64 MB)" });
      } else {
        res.status(400).json({ error: "Failed to read upload body" });
      }
      return;
    }
    handleCbaUpload(req, res).catch((e) => {
      console.error(e);
      res.status(500).json({ error: "Internal server error" });
    });
  });
});

// ---------------------------------------------------------------------------
// Bulk CBA import from Google Drive (Task #199). An admin points the panel at a
// Drive folder holding ~850 districts' CBA PDFs plus a mapping spreadsheet. The
// preview is a pure dry run (writes nothing); ingest is idempotent + resumable
// via the bulk_cba_imports ledger and re-uses the proven single-upload path
// (object-storage-first, %PDF-gated, (district,unit,hash) dedup). Extraction is
// enqueued only where the worker actually runs (production) so a dev preview/
// ingest can never trigger a paid Claude job.
// ---------------------------------------------------------------------------

// Per-request ingest batch cap. Each entry downloads a PDF and writes to object
// storage + DB; the client batches the (potentially ~850) matched rows under
// the global 100kb JSON body limit and the deployment's ~300s request cap.
const BULK_INGEST_BATCH_CAP = 25;
// Max docs a single retry press may re-enqueue (each is a paid Vision run).
const BULK_RETRY_CAP = 200;
const BULK_RUN_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;

interface BulkIngestEntry {
  driveFileId: string;
  districtId: number;
  unit: string;
  schoolYear: string | null;
  filename: string;
  driveFileName?: string | null;
  driveMd5?: string | null;
  driveSize?: number | null;
  driveModifiedTime?: string | null;
}

interface BulkIngestResult {
  driveFileId: string;
  status: string;
  sourceDocId: number | null;
  error: string | null;
}

// Extraction is enqueued in production (worker runs there). In dev it is skipped
// unless explicitly opted in, so previewing/ingesting a real folder in dev never
// spends money on Claude. Source docs/contracts are still recorded either way.
function bulkShouldEnqueue(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.BULK_IMPORT_ALLOW_DEV_ENQUEUE === "1"
  );
}

// Upsert one ledger row keyed by (run_id, drive_file_id). Preserves an existing
// file_hash/source_doc_id when a later attempt does not carry one.
async function bulkRecordLedger(p: {
  runId: string;
  driveFileId: string;
  driveFileName: string | null;
  driveMd5: string | null;
  driveSize: number | null;
  driveModified: string | null;
  districtId: number | null;
  unit: string | null;
  schoolYear: string | null;
  filename: string | null;
  fileHash: string | null;
  sourceDocId: number | null;
  status: string;
  error: string | null;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO bulk_cba_imports
      (run_id, drive_file_id, drive_file_name, drive_md5, drive_size, drive_modified,
       district_id, bargaining_unit, school_year, filename, file_hash, source_doc_id,
       status, error)
    VALUES (${p.runId}, ${p.driveFileId}, ${p.driveFileName}, ${p.driveMd5}, ${p.driveSize},
            ${p.driveModified}, ${p.districtId}, ${p.unit}, ${p.schoolYear}, ${p.filename},
            ${p.fileHash}, ${p.sourceDocId}, ${p.status}, ${p.error})
    ON CONFLICT (run_id, drive_file_id) DO UPDATE SET
      drive_file_name = EXCLUDED.drive_file_name,
      drive_md5       = EXCLUDED.drive_md5,
      drive_size      = EXCLUDED.drive_size,
      drive_modified  = EXCLUDED.drive_modified,
      district_id     = EXCLUDED.district_id,
      bargaining_unit = EXCLUDED.bargaining_unit,
      school_year     = EXCLUDED.school_year,
      filename        = EXCLUDED.filename,
      file_hash       = COALESCE(EXCLUDED.file_hash, bulk_cba_imports.file_hash),
      source_doc_id   = COALESCE(EXCLUDED.source_doc_id, bulk_cba_imports.source_doc_id),
      status          = EXCLUDED.status,
      error           = EXCLUDED.error,
      updated_at      = NOW()
  `);
}

// Ingest one Drive-hosted CBA PDF. Idempotent + resumable: an unchanged file
// already ingested in this run is skipped without re-downloading; content is
// deduped by (district, unit, hash). Every failure path records a 'failed'
// ledger row (with the reason) and returns — it never throws.
async function bulkIngestOneFile(
  runId: string,
  e: BulkIngestEntry,
  requestedBy: string,
): Promise<BulkIngestResult> {
  const driveFileId = String(e.driveFileId ?? "");
  const driveFileName = e.driveFileName ? String(e.driveFileName).slice(0, 300) : null;
  const driveMd5 = e.driveMd5 ? String(e.driveMd5).slice(0, 64) : null;
  const driveSize = typeof e.driveSize === "number" ? e.driveSize : null;
  const driveModified = e.driveModifiedTime ? String(e.driveModifiedTime) : null;
  const districtId = Number(e.districtId);
  const unit = String(e.unit ?? "");
  const sy = normalizeSchoolYear(e.schoolYear);
  const schoolYear = sy.ok ? sy.value : null;
  const filename = sanitizeFilename(
    String(e.filename || e.driveFileName || "contract.pdf"),
  );

  const fail = async (error: string): Promise<BulkIngestResult> => {
    await bulkRecordLedger({
      runId,
      driveFileId,
      driveFileName,
      driveMd5,
      driveSize,
      driveModified,
      districtId: Number.isFinite(districtId) ? districtId : null,
      unit: unit || null,
      schoolYear,
      filename,
      fileHash: null,
      sourceDocId: null,
      status: "failed",
      error: error.slice(0, 500),
    });
    return { driveFileId, status: "failed", sourceDocId: null, error: error.slice(0, 500) };
  };

  if (!driveFileId) {
    return { driveFileId, status: "failed", sourceDocId: null, error: "missing driveFileId" };
  }
  if (!Number.isFinite(districtId) || districtId < 1) return fail("invalid districtId");
  if (!VALID_BARGAINING_UNITS.has(unit)) return fail(`invalid bargaining_unit "${unit}"`);

  // Resume: an unchanged file already ingested in this run → reuse, skip download.
  const prior = await db.execute(sql`
    SELECT source_doc_id, drive_md5, status FROM bulk_cba_imports
    WHERE run_id = ${runId} AND drive_file_id = ${driveFileId} LIMIT 1
  `);
  if (prior.rows.length) {
    const p = prior.rows[0] as {
      source_doc_id: number | null;
      drive_md5: string | null;
      status: string;
    };
    if (
      p.source_doc_id != null &&
      (p.status === "ingested" || p.status === "duplicate") &&
      (driveMd5 == null || p.drive_md5 == null || p.drive_md5 === driveMd5)
    ) {
      return {
        driveFileId,
        status: p.status,
        sourceDocId: Number(p.source_doc_id),
        error: null,
      };
    }
  }

  // District must exist.
  const distRows = await db.execute(sql`SELECT id FROM districts WHERE id = ${districtId}`);
  if (!distRows.rows.length) return fail(`district ${districtId} not found`);

  // Download bytes (direct googleapis, 401→refresh once, 64MB cap).
  let buf: Buffer;
  try {
    buf = await downloadDriveFile(driveFileId);
  } catch (err) {
    return fail(`download failed: ${(err as Error).message}`);
  }
  if (buf.subarray(0, 1024).indexOf(Buffer.from("%PDF")) === -1) {
    return fail("not a valid PDF (missing %PDF header)");
  }
  const fileHash = createHash("sha256").update(buf).digest("hex");

  // Object storage MUST hold the PDF for it to be servable in prod (the prod fs
  // is ephemeral; resolvePdfBuffer reads il_cba/<hash>.pdf by hash FIRST). Do
  // this for BOTH new and duplicate docs: a pre-existing source_documents row
  // may have come from an older local-only path and otherwise be unservable in
  // prod. The write is idempotent by key, so re-uploading the same hash is safe.
  try {
    await uploadBuffer(uploadedCbaKey(fileHash), buf);
  } catch (err) {
    return fail(`object storage upload failed: ${(err as Error).message}`);
  }

  // Content-level dedup: same (district, unit, hash) → reuse existing source doc.
  const existing = await db.execute(sql`
    SELECT id FROM source_documents
    WHERE district_id = ${districtId} AND bargaining_unit = ${unit} AND file_hash = ${fileHash}
    LIMIT 1
  `);
  let sourceDocId: number;
  let status: string;
  if (existing.rows.length) {
    sourceDocId = Number((existing.rows[0] as { id: number }).id);
    status = "duplicate";
  } else {
    // Best-effort local copy for the dev pipeline; NULL storage_key in prod is OK.
    let storageKey: string | null = null;
    try {
      mkdirSync(IL_CBA_PDF_DIR, { recursive: true });
      const absPath = join(IL_CBA_PDF_DIR, `${fileHash}.pdf`);
      writeFileSync(absPath, buf);
      storageKey = `local:${absPath}`;
    } catch {
      storageKey = null;
    }
    const sourceUrl = `upload://district-${districtId}/${unit}/${filename}`;
    try {
      const inserted = await db.execute(sql`
        INSERT INTO source_documents
          (district_id, doc_type, bargaining_unit, source_url, file_hash, storage_key, school_year)
        VALUES (${districtId}, 'cba_pdf', ${unit}, ${sourceUrl}, ${fileHash}, ${storageKey}, ${schoolYear})
        RETURNING id
      `);
      sourceDocId = Number((inserted.rows[0] as { id: number }).id);
      status = "ingested";
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (/unique|duplicate/i.test(msg)) {
        const r = await db.execute(sql`
          SELECT id FROM source_documents
          WHERE district_id = ${districtId} AND bargaining_unit = ${unit} AND file_hash = ${fileHash}
          LIMIT 1
        `);
        if (r.rows.length) {
          sourceDocId = Number((r.rows[0] as { id: number }).id);
          status = "duplicate";
        } else {
          return fail(`source_documents insert conflict: ${msg}`);
        }
      } else {
        return fail(`source_documents insert failed: ${msg}`);
      }
    }
  }

  // Phase 6 — only a genuinely new doc (not a content-dedup hit) fires a
  // 'new_doc' alert for subscribed firms. Best-effort + idempotent.
  if (status === "ingested") {
    await recordNewContractAlert({
      sourceDocId,
      districtId,
      docName: filename,
      sourceUrl: `upload://district-${districtId}/${unit}/${filename}`,
      fileHash,
    });
  }

  // Pin the bargaining unit (unit_override), ensure an attachable contract row,
  // and enqueue extraction. If any of this fails AFTER the source doc exists,
  // record a failed ledger row that still carries the doc id, so progress/retry
  // can see and re-drive it instead of silently losing the row.
  try {
    await ensureContractForUpload(sourceDocId, districtId, unit, schoolYear, true);

    // Enqueue extraction only where the worker runs, and only if not already done.
    if (bulkShouldEnqueue()) {
      const succeeded = await db.execute(sql`
        SELECT 1 FROM extraction_runs WHERE source_doc_id = ${sourceDocId} AND status = 'success' LIMIT 1
      `);
      if (succeeded.rows.length === 0) {
        await enqueueJob({
          sourceDocId,
          domain: "cba",
          requestedBy,
          requestReason: "bulk-import",
        });
      }
    }
  } catch (err) {
    const msg = `post-ingest step failed: ${String((err as Error).message ?? err)}`;
    await bulkRecordLedger({
      runId,
      driveFileId,
      driveFileName,
      driveMd5,
      driveSize,
      driveModified,
      districtId,
      unit,
      schoolYear,
      filename,
      fileHash,
      sourceDocId,
      status: "failed",
      error: msg.slice(0, 500),
    });
    return { driveFileId, status: "failed", sourceDocId, error: msg.slice(0, 500) };
  }

  await bulkRecordLedger({
    runId,
    driveFileId,
    driveFileName,
    driveMd5,
    driveSize,
    driveModified,
    districtId,
    unit,
    schoolYear,
    filename,
    fileHash,
    sourceDocId,
    status,
    error: null,
  });
  return { driveFileId, status, sourceDocId, error: null };
}

// Find and read the mapping spreadsheet inside the Drive folder. Prefers a
// Google Sheet / CSV; rejects Excel (no xlsx parser) with a clear message.
async function bulkReadManifest(
  files: DriveFile[],
): Promise<
  | { ok: true; csv: string; manifest: DriveFile; candidates: DriveFile[] }
  | { ok: false; error: string; candidates: DriveFile[] }
> {
  const candidates = files.filter(
    (f) => f.mimeType === SHEET_MIME || /\.(csv|xlsx|xls)$/i.test(f.name),
  );
  if (!candidates.length) {
    return {
      ok: false,
      error: "No mapping spreadsheet found in the folder (expected a Google Sheet or a .csv).",
      candidates,
    };
  }
  const score = (f: DriveFile) => {
    const n = f.name.toLowerCase();
    let s = 0;
    if (/manifest|mapping|\bmap\b|index|list|districts?/.test(n)) s += 10;
    if (f.mimeType === SHEET_MIME) s += 2;
    if (/\.csv$/i.test(n)) s += 1;
    return s;
  };
  const chosen = [...candidates].sort((a, b) => score(b) - score(a))[0];
  if (/\.(xlsx|xls)$/i.test(chosen.name) && chosen.mimeType !== SHEET_MIME) {
    return {
      ok: false,
      error: `The mapping file "${chosen.name}" is an Excel file, which is not supported. Re-save it as a Google Sheet or export it as CSV.`,
      candidates,
    };
  }
  try {
    const csv =
      chosen.mimeType === SHEET_MIME
        ? await exportGoogleSheetCsv(chosen.id)
        : (await downloadDriveFile(chosen.id)).toString("utf8");
    return { ok: true, csv, manifest: chosen, candidates };
  } catch (err) {
    return {
      ok: false,
      error: `Could not read mapping file "${chosen.name}": ${(err as Error).message}`,
      candidates,
    };
  }
}

// ---------------------------------------------------------------------------
// Folder-scan background jobs (Task #229). Scanning a very large Drive folder
// tree fans out one listFolderChildren proxy call per subfolder (thousands for
// a big import), rate-limited to ~7.7 RPS, so the crawl alone can exceed the
// deployment's ~300s request cap and time the preview out. Instead, the scan
// runs as an in-process background job (the api-server is an always-on Reserved
// VM, so a fire-and-forget async task survives) and the admin polls a status
// endpoint for live progress and, when finished, the same preview payload.
// ---------------------------------------------------------------------------
interface BulkScanProgress {
  foldersScanned: number;
  foldersKnown: number;
  filesFound: number;
  phase: string;
}
interface BulkScanJob {
  scanId: string;
  folderId: string;
  status: "running" | "done" | "error";
  progress: BulkScanProgress;
  /** Finished preview result: { httpStatus, body } mirroring the old route. */
  result: { httpStatus: number; body: Record<string, unknown> } | null;
  error: string | null;
  updatedAt: number;
}
const bulkScanJobs = new Map<string, BulkScanJob>();
const BULK_SCAN_TTL_MS = 30 * 60 * 1000; // forget finished/stale scans after 30m
const BULK_SCAN_MAX_ACTIVE = 4; // cap concurrent crawls (each holds proxy budget)

// Drop scans that finished or went idle long enough ago; keeps the map bounded
// without a timer (called on each start/status request).
function pruneBulkScans(): void {
  const now = Date.now();
  for (const [id, job] of bulkScanJobs) {
    if (now - job.updatedAt > BULK_SCAN_TTL_MS) bulkScanJobs.delete(id);
  }
}

// Run the full dry-run preview (folder crawl → manifest read → row matching)
// and return the exact HTTP status + body the synchronous route used to send,
// reporting live progress via the optional callback. Pure: writes nothing.
async function scanFolderForPreview(
  folderId: string,
  report?: (p: Partial<BulkScanProgress>) => void,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  let tree;
  try {
    tree = await listFolderTree(folderId, (p: FolderScanProgress) =>
      report?.({ ...p, phase: "listing" }),
    );
  } catch (err) {
    if (err instanceof DriveNotConnectedError) {
      return {
        httpStatus: 502,
        body: {
          error:
            "Google Drive is not connected. Connect it in the integrations panel and try again.",
        },
      };
    }
    console.error("[bulk-cba] folder list failed", err);
    return {
      httpStatus: 502,
      body: { error: `Could not list the Drive folder: ${(err as Error).message}` },
    };
  }
  report?.({ phase: "reading-manifest" });
  const pdfFiles = tree.files.filter(isPdfFile);
  const manifest = await bulkReadManifest(tree.files);
  if (!manifest.ok) {
    return {
      httpStatus: 200,
      body: {
        ok: false,
        folderId,
        fileCount: pdfFiles.length,
        truncated: tree.truncated,
        error: manifest.error,
        manifestCandidates: manifest.candidates.map((f) => ({ id: f.id, name: f.name })),
      },
    };
  }
  const grid = parseCsv(manifest.csv);
  if (grid.length < 2) {
    return { httpStatus: 400, body: { error: "The mapping spreadsheet has no data rows." } };
  }
  const cols = mapManifestColumns(grid[0]);
  if (!cols) {
    return {
      httpStatus: 400,
      body: {
        error:
          "The mapping spreadsheet is missing required columns. Include a file column plus an RCDTS or district-name column (bargaining_unit and school_year recommended).",
      },
    };
  }
  report?.({ phase: "matching" });
  const lookups = await loadDistrictLookups();
  const { entries, unreferencedFiles } = matchEntries({
    rows: grid.slice(1),
    startLine: 2,
    cols,
    files: pdfFiles,
    lookups,
  });
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const matched = entries.filter((e) => e.status === "matched");
  const unmatched = entries.filter((e) => e.status !== "matched");
  return {
    httpStatus: 200,
    body: {
      ok: true,
      folderId,
      fileCount: pdfFiles.length,
      truncated: tree.truncated,
      manifest: { id: manifest.manifest.id, name: manifest.manifest.name },
      rowCount: entries.length,
      counts,
      matchedCount: matched.length,
      matched,
      unmatched,
      unreferencedFiles,
      costNote:
        `Ingesting ${matched.length} contract(s) will enqueue ${matched.length} extraction job(s). ` +
        "Each runs salary + provisions + contract-meta via Claude Vision and is processed one at a time " +
        "on the production worker, so a full run takes time and incurs per-document API cost. " +
        "Start with a small batch to validate quality before releasing all.",
    },
  };
}

// POST /admin/bulk-cba/preview/start — body { folderId }. Kicks off the folder
// scan as a background job and returns a scanId to poll. Writes nothing.
router.post(
  "/admin/bulk-cba/preview/start",
  requireAdminToken,
  heavyAdminLimiter,
  async (req, res) => {
    const body = (req.body ?? {}) as { folderId?: unknown; folder?: unknown };
    const folderId = parseDriveFolderId(String(body.folderId ?? body.folder ?? ""));
    if (!folderId) {
      res.status(400).json({ error: "A Google Drive folder id or URL is required" });
      return;
    }
    pruneBulkScans();
    const active = [...bulkScanJobs.values()].filter((j) => j.status === "running").length;
    if (active >= BULK_SCAN_MAX_ACTIVE) {
      res.status(429).json({
        error: "Too many folder scans are in progress. Wait for one to finish and try again.",
      });
      return;
    }
    const scanId = `scan-${Date.now()}-${randomBytes(6).toString("hex")}`;
    const job: BulkScanJob = {
      scanId,
      folderId,
      status: "running",
      progress: { foldersScanned: 0, foldersKnown: 1, filesFound: 0, phase: "listing" },
      result: null,
      error: null,
      updatedAt: Date.now(),
    };
    bulkScanJobs.set(scanId, job);
    // Fire-and-forget: the crawl can run for minutes, well past this request.
    void (async () => {
      try {
        const result = await scanFolderForPreview(folderId, (p) => {
          job.progress = { ...job.progress, ...p };
          job.updatedAt = Date.now();
        });
        job.result = result;
        job.progress = { ...job.progress, phase: "done" };
        job.status = "done";
        job.updatedAt = Date.now();
      } catch (err) {
        job.status = "error";
        job.error = String((err as Error).message ?? err).slice(0, 500);
        job.updatedAt = Date.now();
      }
    })();
    res.json({ ok: true, scanId });
  },
);

// GET /admin/bulk-cba/preview/status?scanId=... — poll a background folder scan.
router.get("/admin/bulk-cba/preview/status", requireAdminToken, async (req, res) => {
  pruneBulkScans();
  const scanId = String(req.query.scanId ?? "");
  const job = bulkScanJobs.get(scanId);
  if (!job) {
    res.status(404).json({
      error: "No folder scan found with that id (it may have expired). Start a new preview.",
    });
    return;
  }
  if (job.status === "running") {
    res.json({ ok: true, status: "running", progress: job.progress });
    return;
  }
  if (job.status === "error") {
    res.json({ ok: true, status: "error", progress: job.progress, error: job.error });
    return;
  }
  res.json({
    ok: true,
    status: "done",
    progress: job.progress,
    result: job.result,
  });
});

// POST /admin/bulk-cba/ingest — body { runId, entries[] } (client batches ≤25).
router.post(
  "/admin/bulk-cba/ingest",
  requireAdminToken,
  heavyAdminLimiter,
  async (req, res) => {
    const body = (req.body ?? {}) as { runId?: unknown; entries?: unknown };
    const runId = String(body.runId ?? "");
    if (!BULK_RUN_ID_RE.test(runId)) {
      res.status(400).json({ error: "A valid runId (<=64 chars; letters, digits, _ : . -) is required" });
      return;
    }
    if (!Array.isArray(body.entries)) {
      res.status(400).json({ error: "entries[] is required" });
      return;
    }
    if (body.entries.length === 0) {
      res.json({ ok: true, runId, enqueued: bulkShouldEnqueue(), results: [], counts: {} });
      return;
    }
    if (body.entries.length > BULK_INGEST_BATCH_CAP) {
      res.status(400).json({
        error: `Too many entries in one batch (max ${BULK_INGEST_BATCH_CAP}). Split into smaller batches.`,
      });
      return;
    }
    const requestedBy = requestedByFromReq(req);
    const entries = body.entries as BulkIngestEntry[];
    const results = await mapLimit(entries, 4, (e) =>
      bulkIngestOneFile(runId, e, requestedBy).catch(
        (err): BulkIngestResult => ({
          driveFileId: String((e as BulkIngestEntry)?.driveFileId ?? ""),
          status: "failed",
          sourceDocId: null,
          error: String((err as Error).message ?? err).slice(0, 300),
        }),
      ),
    );
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    res.json({ ok: true, runId, enqueued: bulkShouldEnqueue(), results, counts });
  },
);

// GET /admin/bulk-cba/runs — list recent import runs for the picker.
router.get("/admin/bulk-cba/runs", requireAdminToken, async (_req, res) => {
  const rows = await db.execute(sql`
    SELECT run_id AS "runId",
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'ingested')::int  AS ingested,
           COUNT(*) FILTER (WHERE status = 'duplicate')::int AS duplicate,
           COUNT(*) FILTER (WHERE status = 'failed')::int    AS failed,
           MIN(created_at) AS "startedAt",
           MAX(updated_at) AS "updatedAt"
    FROM bulk_cba_imports
    GROUP BY run_id
    ORDER BY MAX(updated_at) DESC
    LIMIT 50
  `);
  res.json({ ok: true, runs: rows.rows });
});

// GET /admin/bulk-cba/progress?runId=... — ledger + extraction job/run rollup.
router.get("/admin/bulk-cba/progress", requireAdminToken, async (req, res) => {
  const runId = String(req.query.runId ?? "");
  if (!BULK_RUN_ID_RE.test(runId)) {
    res.status(400).json({ error: "runId is required" });
    return;
  }
  const ledger = await db.execute(sql`
    SELECT status, COUNT(*)::int AS n FROM bulk_cba_imports WHERE run_id = ${runId} GROUP BY status
  `);
  const ingest: Record<string, number> = {};
  let ingestTotal = 0;
  for (const r of ledger.rows as Array<{ status: string; n: number }>) {
    ingest[r.status] = r.n;
    ingestTotal += r.n;
  }
  if (ingestTotal === 0) {
    res.status(404).json({ error: "No bulk import found with that runId" });
    return;
  }
  // Latest extraction job status per ingested doc.
  const jobRows = await db.execute(sql`
    SELECT lj.status, COUNT(*)::int AS n FROM (
      SELECT DISTINCT ON (source_doc_id) source_doc_id, status
      FROM extraction_jobs
      WHERE domain = 'cba' AND source_doc_id IN (
        SELECT DISTINCT source_doc_id FROM bulk_cba_imports
        WHERE run_id = ${runId} AND source_doc_id IS NOT NULL
      )
      ORDER BY source_doc_id, id DESC
    ) lj GROUP BY lj.status
  `);
  const jobs: Record<string, number> = {};
  for (const r of jobRows.rows as Array<{ status: string; n: number }>) jobs[r.status] = r.n;
  const extractedRows = await db.execute(sql`
    SELECT COUNT(DISTINCT er.source_doc_id)::int AS n
    FROM extraction_runs er
    WHERE er.status = 'success' AND er.source_doc_id IN (
      SELECT DISTINCT source_doc_id FROM bulk_cba_imports
      WHERE run_id = ${runId} AND source_doc_id IS NOT NULL
    )
  `);
  const extracted = (extractedRows.rows[0] as { n: number } | undefined)?.n ?? 0;
  const failures = await db.execute(sql`
    SELECT drive_file_name AS "driveFileName", filename, district_id AS "districtId",
           bargaining_unit AS "bargainingUnit", error
    FROM bulk_cba_imports WHERE run_id = ${runId} AND status = 'failed'
    ORDER BY updated_at DESC LIMIT 200
  `);
  res.json({
    ok: true,
    runId,
    ingest: { total: ingestTotal, ...ingest },
    extraction: { jobs, extracted },
    queue: await getQueueStats(),
    failures: failures.rows,
  });
});

// POST /admin/bulk-cba/retry — body { runId }. Bounded re-enqueue of docs in the
// run that have neither a successful extraction nor an active/done job.
router.post(
  "/admin/bulk-cba/retry",
  requireAdminToken,
  heavyAdminLimiter,
  async (req, res) => {
    const body = (req.body ?? {}) as { runId?: unknown };
    const runId = String(body.runId ?? "");
    if (!BULK_RUN_ID_RE.test(runId)) {
      res.status(400).json({ error: "runId is required" });
      return;
    }
    if (!bulkShouldEnqueue()) {
      res.status(409).json({
        error: "Extraction enqueue is disabled in this environment (set BULK_IMPORT_ALLOW_DEV_ENQUEUE=1 to override in dev).",
      });
      return;
    }
    const docs = await db.execute(sql`
      SELECT DISTINCT b.source_doc_id::int AS source_doc_id
      FROM bulk_cba_imports b
      WHERE b.run_id = ${runId} AND b.source_doc_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM extraction_jobs ej
          WHERE ej.source_doc_id = b.source_doc_id AND ej.domain = 'cba'
            AND ej.status IN ('queued', 'running', 'done')
        )
        AND NOT EXISTS (
          SELECT 1 FROM extraction_runs er
          WHERE er.source_doc_id = b.source_doc_id AND er.status = 'success'
        )
      LIMIT ${BULK_RETRY_CAP}
    `);
    const requestedBy = requestedByFromReq(req);
    let enqueued = 0;
    for (const r of docs.rows as Array<{ source_doc_id: number }>) {
      const out = await enqueueJob({
        sourceDocId: r.source_doc_id,
        domain: "cba",
        requestedBy,
        requestReason: "bulk-import-retry",
      });
      if (!(out as { deduped?: boolean }).deduped) enqueued++;
    }
    res.json({
      ok: true,
      runId,
      candidates: docs.rows.length,
      enqueued,
      capped: docs.rows.length >= BULK_RETRY_CAP,
    });
  },
);

// ---------------------------------------------------------------------------
// Extraction engine (Task #175): in-process queue + immutable versions +
// diff/promote. The worker (worker.ts) runs jobs one at a time; these endpoints
// give the admin panel visibility (queue + est. duration), the per-document
// version history, a candidate-vs-promoted diff, a manual PROMOTE action, and a
// bounded "re-run flagged" bulk enqueue.
// ---------------------------------------------------------------------------

// How many flagged docs a single "re-run flagged" press may enqueue. Each job is
// a paid Claude Vision call, so the bulk action is capped and reports the cap.
const RERUN_FLAGGED_CAP = 100;

router.get("/admin/extraction/queue", requireAdminToken, async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const [stats, jobs] = await Promise.all([
      getQueueStats(),
      listJobs({ limit: Number.isFinite(limit) ? limit : 50 }),
    ]);
    res.json({ stats, jobs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/extraction/versions", requireAdminToken, async (req, res) => {
  try {
    const docId = parseInt(String(req.query.docId ?? req.query.doc_id ?? ""), 10);
    if (isNaN(docId) || docId < 1) {
      res.status(400).json({ error: "docId is required and must be a positive integer" });
      return;
    }
    const [versions, promotions] = await Promise.all([
      getVersionsForDoc(docId),
      getPromotions(docId),
    ]);
    res.json({ docId, versions, promotions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/extraction/diff", requireAdminToken, async (req, res) => {
  try {
    const versionId = parseInt(String(req.query.versionId ?? req.query.version_id ?? ""), 10);
    if (isNaN(versionId) || versionId < 1) {
      res.status(400).json({ error: "versionId is required and must be a positive integer" });
      return;
    }
    const diff = await diffAgainstPromoted(versionId);
    if (!diff) {
      res.status(404).json({ error: `Version ${versionId} not found` });
      return;
    }
    res.json(diff);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/extraction/promote", requireAdminToken, heavyAdminLimiter, async (req, res) => {
  try {
    const body = (req.body ?? {}) as { versionId?: number | string };
    const versionId = parseInt(String(body.versionId ?? ""), 10);
    if (isNaN(versionId) || versionId < 1) {
      res.status(400).json({ error: "versionId is required and must be a positive integer" });
      return;
    }
    const result = await promoteVersion(versionId, { promotedBy: requestedByFromReq(req) });
    if (!result.ok) {
      res.status(404).json({ error: result.reason ?? "Promotion failed", ...result });
      return;
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/extraction/rerun-flagged", requireAdminToken, heavyAdminLimiter, async (req, res) => {
  try {
    const requestedBy = requestedByFromReq(req);
    // Docs whose live data is low-confidence (provisions < 0.8 & unverified) or
    // salary needs review — the human-review backlog. Bounded by RERUN_FLAGGED_CAP.
    const flagged = await db.execute(sql`
      SELECT DISTINCT c.source_doc_id::int AS id
      FROM contracts c
      WHERE c.source_doc_id IS NOT NULL AND (
        EXISTS (
          SELECT 1 FROM contract_provisions cp
          WHERE cp.contract_id = c.id AND cp.confidence < 0.8 AND NOT cp.human_verified
        )
        OR EXISTS (
          SELECT 1 FROM contract_salary_schedules s
          WHERE s.contract_id = c.id AND s.needs_review
        )
      )
      ORDER BY c.source_doc_id
      LIMIT ${RERUN_FLAGGED_CAP}
    `);
    const docIds = (flagged.rows as Array<{ id: number }>).map((r) => r.id);
    let enqueued = 0;
    for (const id of docIds) {
      const { deduped } = await enqueueJob({
        sourceDocId: id,
        domain: "cba",
        requestedBy,
        requestReason: "rerun-flagged",
      });
      if (!deduped) enqueued++;
    }
    const stats = await getQueueStats();
    res.json({
      candidates: docIds.length,
      enqueued,
      cap: RERUN_FLAGGED_CAP,
      capped: docIds.length >= RERUN_FLAGGED_CAP,
      stats,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/extraction/enqueue — queue a single-doc extraction job for any
// domain (Task #176). Lets an admin re-run salary/provisions ("cba" = both),
// "settlement" (re-derive the doc's 'stated' settlements), or "final_offer"
// (re-extract this filing's positions) through the in-process worker. The result
// is versioned; promotion (auto on first, manual on re-run) writes live tables.
// Only one active job per doc is allowed (queue dedupes by source_doc_id), so
// enqueue domains for the same doc one at a time.
const ENQUEUE_DOMAINS = new Set([
  "cba",
  "salary",
  "provisions",
  "settlement",
  "final_offer",
  "contract_meta",
]);

router.post("/admin/extraction/enqueue", requireAdminToken, heavyAdminLimiter, async (req, res) => {
  try {
    const body = (req.body ?? {}) as { docId?: number | string; domain?: string };
    const docId = parseInt(String(body.docId ?? ""), 10);
    const domain = String(body.domain ?? "");
    if (!Number.isInteger(docId) || docId < 1) {
      res.status(400).json({ error: "docId is required and must be a positive integer" });
      return;
    }
    if (!ENQUEUE_DOMAINS.has(domain)) {
      res.status(400).json({
        error: `domain must be one of ${[...ENQUEUE_DOMAINS].join(", ")}`,
      });
      return;
    }
    const { job, deduped } = await enqueueJob({
      sourceDocId: docId,
      domain: domain as Parameters<typeof enqueueJob>[0]["domain"],
      requestedBy: requestedByFromReq(req),
      requestReason: "admin-enqueue",
    });
    res.json({ job, deduped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Fix a contract's bargaining unit (Task #158)
//
// Lets an admin correct a contract whose unit was mislabeled at upload or
// extraction time. The correction:
//   1. updates contracts.bargaining_unit and pins it via unit_override = true
//      so the pipeline's auto-classifier (backfill_contract_units) won't revert
//      it;
//   2. propagates to the derived settlements (contract_id linked) — these drive
//      the unit selector the customer sees;
//   3. for uploaded docs, also updates the authoritative
//      source_documents.bargaining_unit, because the extractor trusts that value
//      for upload:// docs on a re-extraction — otherwise the fix would silently
//      revert.
// All writes run in one transaction; a unique-constraint collision (another
// contract or settlement already occupies the target unit) rolls everything
// back and returns a 409 with a human-readable message.
// ---------------------------------------------------------------------------

// GET /admin/districts/:id/contracts — list a district's contracts so an admin
// can pick the one to correct.
router.get("/admin/districts/:id/contracts", requireAdminToken, (req, res) => {
  void (async () => {
    const districtId = parseInt(String(req.params.id ?? ""), 10);
    if (!Number.isInteger(districtId) || districtId < 1) {
      res.status(400).json({ error: "district id must be a positive integer" });
      return;
    }
    const distRows = await db.execute(sql`
      SELECT id, name FROM districts WHERE id = ${districtId}
    `);
    const district = distRows.rows[0] as { id: string | number; name: string } | undefined;
    if (!district) {
      res.status(404).json({ error: `District ${districtId} not found` });
      return;
    }
    const rows = await db.execute(sql`
      SELECT c.id,
             c.bargaining_unit AS "bargainingUnit",
             c.unit_override   AS "unitOverride",
             c.union_name      AS "unionName",
             c.affiliation,
             c.unit_scope      AS "unitScope",
             c.effective_start AS "effectiveStart",
             c.effective_end   AS "effectiveEnd",
             c.term_years      AS "termYears",
             sd.source_url     AS "sourceUrl",
             (SELECT COUNT(*)::int FROM settlements s WHERE s.contract_id = c.id)
               AS "settlementCount",
             -- Shared-PDF unit mismatch (Task #163): when an admin reassigns a
             -- contract backed by a PDF that's shared across multiple contracts,
             -- the anti-clobber guard intentionally leaves the authoritative
             -- source_documents.bargaining_unit unchanged. Surface that lingering
             -- divergence so operators can audit it before a re-extraction
             -- silently disagrees. Only flag when the doc backs >1 contract.
             sd.bargaining_unit AS "sourceUnit",
             (
               sd.id IS NOT NULL
               AND sd.bargaining_unit IS NOT NULL
               AND sd.bargaining_unit <> c.bargaining_unit
               AND (
                 SELECT COUNT(*) FROM contracts c2 WHERE c2.source_doc_id = sd.id
               ) > 1
             ) AS "sharedPdfUnitMismatch"
      FROM contracts c
      LEFT JOIN source_documents sd ON sd.id = c.source_doc_id
      WHERE c.district_id = ${districtId}
      ORDER BY (c.bargaining_unit = 'teachers') DESC, c.bargaining_unit,
               c.effective_start DESC NULLS LAST, c.id
    `);
    res.json({ districtId, districtName: district.name, contracts: rows.rows });
  })().catch((e) => {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  });
});

async function handleReassignUnit(req: Request, res: Response): Promise<void> {
  const contractId = parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isInteger(contractId) || contractId < 1) {
    res.status(400).json({ error: "contract id must be a positive integer" });
    return;
  }
  // Validate strictly against the controlled vocabulary. We deliberately do NOT
  // use parseUnit() here, which silently defaults invalid input to 'teachers' —
  // for a manual correction, bad input must be a 400, not a silent mislabel.
  const body = (req.body ?? {}) as { bargainingUnit?: unknown };
  const newUnit = body.bargainingUnit != null ? String(body.bargainingUnit) : "";
  if (!VALID_BARGAINING_UNITS.has(newUnit)) {
    res.status(400).json({ error: `Invalid bargaining_unit: ${newUnit || "(missing)"}` });
    return;
  }

  const cRows = await db.execute(sql`
    SELECT c.id, c.bargaining_unit, c.source_doc_id,
           d.name AS district_name, sd.source_url
    FROM contracts c
    LEFT JOIN districts d ON d.id = c.district_id
    LEFT JOIN source_documents sd ON sd.id = c.source_doc_id
    WHERE c.id = ${contractId}
  `);
  const contract = cRows.rows[0] as
    | {
        id: string | number;
        bargaining_unit: string;
        source_doc_id: string | number | null;
        district_name: string | null;
        source_url: string | null;
      }
    | undefined;
  if (!contract) {
    res.status(404).json({ error: `Contract ${contractId} not found` });
    return;
  }
  const districtName = contract.district_name ?? "this district";
  const label = BARGAINING_UNIT_LABELS[newUnit] ?? newUnit;

  // No-op: same unit. Still pin it (unit_override = true) — the admin has
  // explicitly confirmed this unit is correct, so protect it from the
  // auto-classifier going forward.
  if (contract.bargaining_unit === newUnit) {
    await db.execute(sql`UPDATE contracts SET unit_override = true WHERE id = ${contractId}`);
    res.json({
      ok: true,
      contractId,
      bargainingUnit: newUnit,
      settlementsUpdated: 0,
      unchanged: true,
      districtName,
    });
    return;
  }

  const isUpload =
    !!contract.source_url && String(contract.source_url).startsWith("upload://");
  const sourceDocId =
    contract.source_doc_id == null ? null : Number(contract.source_doc_id);

  try {
    const result = await db.transaction(async (tx) => {
      // Lock the contract row so a concurrent reassignment can't interleave.
      await tx.execute(sql`SELECT id FROM contracts WHERE id = ${contractId} FOR UPDATE`);
      await tx.execute(sql`
        UPDATE contracts
        SET bargaining_unit = ${newUnit}, unit_override = true
        WHERE id = ${contractId}
      `);
      const upd = await tx.execute(sql`
        UPDATE settlements SET bargaining_unit = ${newUnit}
        WHERE contract_id = ${contractId}
      `);
      // Uploaded docs: source_documents.bargaining_unit is the authoritative
      // human choice the extractor honors on re-extraction. Update it too — but
      // only when this doc maps to exactly this one contract (uploads are
      // single-unit), so a PDF shared across units is never mislabeled.
      //
      // sourceDocumentUpdated tells the admin what happened to that authoritative
      // unit: null when there's nothing to update (non-upload doc / no source
      // doc), true when we rewrote it, false when the shared-doc guard skipped it
      // (the doc backs multiple contracts, so its unit still differs and a future
      // re-extraction could disagree).
      let sourceDocumentUpdated: boolean | null = null;
      if (isUpload && sourceDocId != null) {
        const docUpd = await tx.execute(sql`
          UPDATE source_documents sd
          SET bargaining_unit = ${newUnit}
          WHERE sd.id = ${sourceDocId}
            AND (SELECT COUNT(*) FROM contracts c2 WHERE c2.source_doc_id = sd.id) = 1
        `);
        sourceDocumentUpdated =
          Number((docUpd as { rowCount?: number | null }).rowCount ?? 0) > 0;
      }
      return {
        settlementsUpdated: Number((upd as { rowCount?: number | null }).rowCount ?? 0),
        sourceDocumentUpdated,
      };
    });

    res.json({
      ok: true,
      contractId,
      bargainingUnit: newUnit,
      settlementsUpdated: result.settlementsUpdated,
      sourceDocumentUpdated: result.sourceDocumentUpdated,
      districtName,
    });
  } catch (err) {
    // drizzle wraps the driver error in a "Failed query" Error, so the pg
    // fields (code/constraint) live on the .cause chain, not the top error.
    // Walk the chain to find the first node that carries them.
    let pg: { code?: string; constraint?: string } = {};
    let node: unknown = err;
    for (let i = 0; i < 5 && node; i++) {
      const n = node as { code?: string; constraint?: string; cause?: unknown };
      if (n.code != null || n.constraint != null) {
        pg = { code: n.code, constraint: n.constraint };
        break;
      }
      node = n.cause;
    }
    const constraint = pg.constraint;
    const code = pg.code;
    const msg = String((err as { message?: string })?.message ?? err);
    const isUnique = code === "23505" || /unique|duplicate/i.test(msg) || constraint != null;
    if (isUnique) {
      if (constraint === "settlements_district_unit_year_unique") {
        res.status(409).json({
          error:
            `A ${label} settlement already exists for ${districtName} covering the same ` +
            `year(s). Reassigning this contract would duplicate it — resolve the existing ` +
            `settlement first. No changes were made.`,
        });
        return;
      }
      res.status(409).json({
        error:
          `Another ${label} contract already exists for ${districtName} with the same scope ` +
          `and start date. Reassigning would create a duplicate — resolve that contract ` +
          `first. No changes were made.`,
      });
      return;
    }
    throw err;
  }
}

// PATCH /admin/contracts/:id/bargaining-unit — reassign one contract's unit.
router.patch(
  "/admin/contracts/:id/bargaining-unit",
  requireAdminToken,
  json(),
  (req, res) => {
    handleReassignUnit(req, res).catch((e) => {
      console.error(e);
      res.status(500).json({ error: "Internal server error" });
    });
  },
);

// ---------------------------------------------------------------------------
// Directory Refresh — exported spawn helper (used by cron in index.ts) + routes
// ---------------------------------------------------------------------------

const DIR_REFRESH_SCRIPT = join(PIPELINE_DIR, "12_refresh_il_directory.py");
const DIR_REFRESH_LOG    = join(PIPELINE_DIR, "logs", "il_dir_refresh.log");
let _refreshPid: number | null = null;

export function spawnDirectoryRefresh(): { status: string; pid: number | null } {
  if (_refreshPid !== null) {
    try {
      process.kill(_refreshPid, 0);
      return { status: "already_running", pid: _refreshPid };
    } catch {
      _refreshPid = null;
    }
  }

  mkdirSync(join(PIPELINE_DIR, "logs"), { recursive: true });
  const logFd = openSync(DIR_REFRESH_LOG, "a");

  const child = spawn(
    "python3",
    ["-u", DIR_REFRESH_SCRIPT],
    {
      cwd: PIPELINE_DIR,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PYTHONPATH: PIPELINE_DIR },
    },
  );
  child.unref();
  _refreshPid = child.pid ?? null;
  return { status: "started", pid: _refreshPid };
}

router.post("/admin/run-directory-refresh", requireAdminToken, heavyAdminLimiter, (_req, res) => {
  try {
    const result = spawnDirectoryRefresh();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/directory-refresh-status", requireAdminToken, async (_req, res) => {
  let running = false;
  if (_refreshPid !== null) {
    try { process.kill(_refreshPid, 0); running = true; } catch { _refreshPid = null; }
  }

  try {
    const countRows = await db.execute(sql.raw(
      `SELECT COUNT(*)::int AS n FROM districts WHERE state = 'IL' AND website_url IS NOT NULL`,
    ));
    const ilWithUrl = (countRows.rows[0] as { n: number }).n;

    // directory_refresh_log is created by the Python script on first run.
    // Return latest: null gracefully if the table doesn't exist yet.
    let latest: Record<string, unknown> | null = null;
    try {
      const latestRows = await db.execute(sql.raw(`
        SELECT id, run_at, file_hash, row_count, new_districts, updated_districts,
               with_website, changed, status, error
        FROM directory_refresh_log
        ORDER BY run_at DESC LIMIT 1
      `));
      latest = (latestRows.rows[0] as Record<string, unknown>) ?? null;
    } catch (tableErr) {
      const msg = String(tableErr);
      if (!msg.includes("does not exist") && !msg.includes("relation")) throw tableErr;
      // table not yet created — silently return null
    }

    res.json({ running, pid: _refreshPid, latest, il_with_url: ilWithUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// IL minimum teacher salary sync — exported spawn helper (cron in index.ts) + routes
// ---------------------------------------------------------------------------

const MIN_SALARY_SCRIPT = join(PIPELINE_DIR, "17_sync_il_min_salary.py");
const MIN_SALARY_LOG    = join(PIPELINE_DIR, "logs", "min_salary_sync.log");
const MIN_SALARY_SYNC_NAME = "il_min_teacher_salary";
let _minSalaryPid: number | null = null;
let _minSalaryLastRunAt: Date | null = null;
let _minSalaryLastStatus: "running" | "success" | "error" | null = null;

/**
 * Persist a terminal (success/error) outcome for a background sync so it
 * survives an API server restart. The Python script writes the same record on
 * its own completion; this exit-handler write is a fallback for when the script
 * crashes before it can record its own status. Best-effort — never throws.
 */
async function recordSyncRunStatus(
  syncName: string,
  status: "success" | "error",
  logRef: string,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO sync_run_status (sync_name, status, run_at, log_ref, updated_at)
      VALUES (${syncName}, ${status}, NOW(), ${logRef}, NOW())
      ON CONFLICT (sync_name) DO UPDATE SET
        status     = EXCLUDED.status,
        run_at     = EXCLUDED.run_at,
        log_ref    = EXCLUDED.log_ref,
        updated_at = NOW()
    `);
  } catch (err) {
    console.error("recordSyncRunStatus failed", err);
  }
}

export function spawnMinSalarySync(extraArgs: string[] = []): { status: string; pid: number | null } {
  if (_minSalaryPid !== null) {
    try {
      process.kill(_minSalaryPid, 0);
      return { status: "already_running", pid: _minSalaryPid };
    } catch {
      _minSalaryPid = null;
    }
  }

  mkdirSync(join(PIPELINE_DIR, "logs"), { recursive: true });
  const logFd = openSync(MIN_SALARY_LOG, "a");

  const child = spawn(
    "python3",
    ["-u", MIN_SALARY_SCRIPT, ...extraArgs],
    {
      cwd: PIPELINE_DIR,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PYTHONPATH: PIPELINE_DIR },
    },
  );
  _minSalaryLastRunAt = new Date();
  _minSalaryLastStatus = "running";
  child.on("exit", (code) => {
    const finalStatus = code === 0 ? "success" : "error";
    _minSalaryLastStatus = finalStatus;
    _minSalaryLastRunAt = new Date();
    _minSalaryPid = null;
    void recordSyncRunStatus(MIN_SALARY_SYNC_NAME, finalStatus, MIN_SALARY_LOG);
  });
  child.unref();
  _minSalaryPid = child.pid ?? null;
  return { status: "started", pid: _minSalaryPid };
}

router.post("/admin/run-min-salary-sync", requireAdminToken, heavyAdminLimiter, (_req, res) => {
  try {
    const result = spawnMinSalarySync();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/admin/min-salary-status", requireAdminToken, async (_req, res) => {
  let running = false;
  if (_minSalaryPid !== null) {
    try { process.kill(_minSalaryPid, 0); running = true; } catch { _minSalaryPid = null; }
  }
  if (!running && _minSalaryLastStatus === "running") _minSalaryLastStatus = null;

  let tailLines: string[] = [];
  try {
    const content = readFileSync(MIN_SALARY_LOG, "utf8");
    tailLines = content.split("\n").filter(Boolean).slice(-30);
  } catch { /* log may not exist yet */ }

  try {
    // il_min_teacher_salary is created by app.ts runMigrations() / the Python
    // script. Return latest: null gracefully if it doesn't exist yet.
    let latest: Record<string, unknown> | null = null;
    try {
      const rows = await db.execute(sql.raw(`
        SELECT school_year, prior_year, prior_year_rate,
               percentage_increase::float AS percentage_increase,
               new_year_rate, certified_date, source_url, updated_at
        FROM il_min_teacher_salary
        ORDER BY school_year DESC LIMIT 1
      `));
      latest = (rows.rows[0] as Record<string, unknown>) ?? null;
    } catch (tableErr) {
      const msg = String(tableErr);
      if (!msg.includes("does not exist") && !msg.includes("relation")) throw tableErr;
    }

    // Durable last-run outcome — survives API server restarts. The in-memory
    // values are only authoritative for the live "running" case; otherwise the
    // persisted row is the source of truth so a past failure still flags after
    // a restart (this sync only runs once a year).
    let persistedStatus: "success" | "error" | null = null;
    let persistedRunAt: string | null = null;
    let persistedLogRef: string | null = null;
    try {
      const rows = await db.execute(sql`
        SELECT status, run_at, log_ref
        FROM sync_run_status
        WHERE sync_name = ${MIN_SALARY_SYNC_NAME}
        LIMIT 1
      `);
      const row = rows.rows[0] as
        | { status: string; run_at: string | Date; log_ref: string | null }
        | undefined;
      if (row) {
        persistedStatus = row.status === "success" ? "success" : "error";
        persistedRunAt =
          row.run_at instanceof Date ? row.run_at.toISOString() : String(row.run_at);
        persistedLogRef = row.log_ref ?? null;
      }
    } catch (tableErr) {
      const msg = String(tableErr);
      if (!msg.includes("does not exist") && !msg.includes("relation")) throw tableErr;
    }

    const lastStatus = running
      ? "running"
      : (_minSalaryLastStatus ?? persistedStatus ?? null);
    const lastRunAt = running
      ? (_minSalaryLastRunAt?.toISOString() ?? null)
      : (_minSalaryLastRunAt?.toISOString() ?? persistedRunAt);

    res.json({
      running,
      pid: _minSalaryPid,
      latest,
      tail: tailLines,
      lastRunAt,
      lastStatus,
      lastLogRef: persistedLogRef,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// ISBE salary-dataset uploads (EIS/ATSB + TSS) — browser upload → parse → upsert
//
// Deliberately simple: mirrors the min-salary sync (detached python spawn +
// in-memory pid + sync_run_status row), with a raw-body file upload bolted on.
// No AI extraction, versioning, or job queue — the loaders just parse the
// spreadsheet and upsert district aggregates. The DB is the system of record;
// the uploaded file is copied to object storage best-effort for reproducibility.
// ---------------------------------------------------------------------------

type DatasetKind = "eis" | "tss";

const LOAD_EIS_SCRIPT = join(PIPELINE_DIR, "load_il_eis.py");
const LOAD_TSS_SCRIPT = join(PIPELINE_DIR, "load_il_tss.py");
const IL_EIS_DIR = join(PIPELINE_DIR, "data", "il_eis");
const IL_TSS_DIR = join(PIPELINE_DIR, "data", "il_tss");

const DATASET_LOG: Record<DatasetKind, string> = {
  eis: join(PIPELINE_DIR, "logs", "load_il_eis.log"),
  tss: join(PIPELINE_DIR, "logs", "load_il_tss.log"),
};
const DATASET_SYNC_NAME: Record<DatasetKind, string> = {
  eis: "il_eis_load",
  tss: "il_tss_load",
};

interface DatasetRunState {
  pid: number | null;
  lastRunAt: Date | null;
  lastStatus: "running" | "success" | "error" | null;
  lastFile: string | null;
  lastSchoolYear: string | null;
}
const _datasetState: Record<DatasetKind, DatasetRunState> = {
  eis: { pid: null, lastRunAt: null, lastStatus: null, lastFile: null, lastSchoolYear: null },
  tss: { pid: null, lastRunAt: null, lastStatus: null, lastFile: null, lastSchoolYear: null },
};

/**
 * Reduce an uploaded filename to a safe basename with an allowed spreadsheet
 * extension. EIS accepts only .xlsx (openpyxl); TSS accepts .xlsx or .xls.
 * Returns null if the name is empty or the extension is not allowed.
 */
function safeDatasetFilename(rawValue: unknown, kind: DatasetKind): string | null {
  const base = String(rawValue ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 200);
  if (!cleaned) return null;
  const ok = kind === "eis" ? /\.xlsx$/i.test(cleaned) : /\.(xlsx|xls)$/i.test(cleaned);
  return ok ? cleaned : null;
}

/** Spawn a salary-dataset loader in single-file mode (detached, like min-salary). */
function spawnDatasetLoad(
  kind: DatasetKind,
  filePath: string,
  schoolYear: string | null,
): { status: string; pid: number | null } {
  const st = _datasetState[kind];
  if (st.pid !== null) {
    try {
      process.kill(st.pid, 0);
      return { status: "already_running", pid: st.pid };
    } catch {
      st.pid = null;
    }
  }

  mkdirSync(join(PIPELINE_DIR, "logs"), { recursive: true });
  const logFd = openSync(DATASET_LOG[kind], "a");

  const script = kind === "eis" ? LOAD_EIS_SCRIPT : LOAD_TSS_SCRIPT;
  const scriptArgs = ["-u", script, "--file", filePath];
  if (kind === "tss" && schoolYear) scriptArgs.push("--school-year", schoolYear);

  const child = spawn("python3", scriptArgs, {
    cwd: PIPELINE_DIR,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PYTHONPATH: PIPELINE_DIR },
  });
  st.lastRunAt = new Date();
  st.lastStatus = "running";
  child.on("exit", (code) => {
    const finalStatus = code === 0 ? "success" : "error";
    st.lastStatus = finalStatus;
    st.lastRunAt = new Date();
    st.pid = null;
    void recordSyncRunStatus(DATASET_SYNC_NAME[kind], finalStatus, DATASET_LOG[kind]);
  });
  child.unref();
  st.pid = child.pid ?? null;
  return { status: "started", pid: st.pid };
}

async function handleDatasetUpload(req: Request, res: Response): Promise<void> {
  const kindRaw = String(req.query.kind ?? "").toLowerCase();
  if (kindRaw !== "eis" && kindRaw !== "tss") {
    res.status(400).json({ error: "kind must be 'eis' or 'tss'" });
    return;
  }
  const kind = kindRaw as DatasetKind;

  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    res.status(400).json({ error: "Empty upload — choose a spreadsheet file." });
    return;
  }

  const filename = safeDatasetFilename(req.query.filename, kind);
  if (!filename) {
    res.status(400).json({
      error: kind === "eis"
        ? "EIS/ATSB files must be .xlsx"
        : "TSS files must be .xlsx or .xls",
    });
    return;
  }

  // Validate the file's magic bytes so a mistaken PDF/CSV fails fast with a
  // clear message instead of a confusing Python traceback. .xlsx is a ZIP
  // ("PK"); legacy .xls is an OLE2 compound file (0xD0 0xCF).
  const isXlsx = /\.xlsx$/i.test(filename);
  if (isXlsx) {
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
      res.status(400).json({ error: "That doesn't look like a valid .xlsx file." });
      return;
    }
  } else if (!(buf[0] === 0xd0 && buf[1] === 0xcf)) {
    res.status(400).json({ error: "That doesn't look like a valid .xls file." });
    return;
  }

  // School year: required for TSS (the loader cannot auto-detect it), optional
  // for EIS (derived from the SchoolYearId column in the data).
  const syNorm = normalizeSchoolYear(req.query.school_year);
  if (!syNorm.ok) {
    res.status(400).json({ error: "school_year must look like 2026-27" });
    return;
  }
  const schoolYear = syNorm.value;
  if (kind === "tss" && !schoolYear) {
    res.status(400).json({ error: "A school year (e.g. 2026-27) is required for TSS uploads." });
    return;
  }

  // Reject a concurrent upload BEFORE writing anything. Otherwise a retry or
  // double-click during a running load would overwrite the spreadsheet the
  // child process is still reading (and we'd mutate disk/object storage only to
  // return "already_running" with an unprocessed file).
  const active = _datasetState[kind];
  if (active.pid !== null) {
    try {
      process.kill(active.pid, 0);
      res.status(409).json({
        error: "A load is already running for this dataset — wait for it to finish.",
      });
      return;
    } catch {
      active.pid = null;
    }
  }

  const dir = kind === "eis" ? IL_EIS_DIR : IL_TSS_DIR;
  mkdirSync(dir, { recursive: true });
  const absPath = join(dir, filename);
  writeFileSync(absPath, buf);

  // Best-effort durable copy: the local filesystem is dev-only and autoscale
  // instances are stateless, so persist the source spreadsheet to object
  // storage for reproducibility. The DB is the system of record, so a failure
  // here must NOT block the load (unlike CBA PDFs, which must be servable).
  try {
    await uploadBuffer(
      `il_salary_datasets/${kind}/${filename}`,
      buf,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  } catch (err) {
    console.error("Object storage copy failed for salary dataset", kind, filename, err);
  }

  const { status, pid } = spawnDatasetLoad(kind, absPath, schoolYear);
  if (status === "already_running") {
    // Lost a race against another concurrent upload after the pre-write check.
    res.status(409).json({
      error: "A load is already running for this dataset — wait for it to finish.",
    });
    return;
  }
  _datasetState[kind].lastFile = filename;
  _datasetState[kind].lastSchoolYear = schoolYear;
  res.json({ ok: true, kind, filename, schoolYear, fileBytes: buf.length, status, pid });
}

router.post("/admin/upload-salary-dataset", requireAdminToken, heavyAdminLimiter, (req, res) => {
  uploadPdfBody(req, res, (err?: unknown) => {
    if (err) {
      const status =
        (err as { status?: number }).status ??
        (err as { statusCode?: number }).statusCode;
      if (status === 413) {
        res.status(413).json({ error: "File too large (max 64 MB)" });
      } else {
        res.status(400).json({ error: "Failed to read upload body" });
      }
      return;
    }
    handleDatasetUpload(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    });
  });
});

router.get("/admin/salary-dataset-status", requireAdminToken, async (req, res) => {
  const kindRaw = String(req.query.kind ?? "").toLowerCase();
  if (kindRaw !== "eis" && kindRaw !== "tss") {
    res.status(400).json({ error: "kind must be 'eis' or 'tss'" });
    return;
  }
  const kind = kindRaw as DatasetKind;
  const st = _datasetState[kind];

  let running = false;
  if (st.pid !== null) {
    try { process.kill(st.pid, 0); running = true; } catch { st.pid = null; }
  }
  if (!running && st.lastStatus === "running") st.lastStatus = null;

  let tailLines: string[] = [];
  try {
    const content = readFileSync(DATASET_LOG[kind], "utf8");
    tailLines = content.split("\n").filter(Boolean).slice(-40);
  } catch { /* log may not exist yet */ }

  try {
    // Durable last-run outcome — survives API restarts (these load rarely).
    let persistedStatus: "success" | "error" | null = null;
    let persistedRunAt: string | null = null;
    try {
      const rows = await db.execute(sql`
        SELECT status, run_at FROM sync_run_status
        WHERE sync_name = ${DATASET_SYNC_NAME[kind]} LIMIT 1
      `);
      const row = rows.rows[0] as { status: string; run_at: string | Date } | undefined;
      if (row) {
        persistedStatus = row.status === "success" ? "success" : "error";
        persistedRunAt =
          row.run_at instanceof Date ? row.run_at.toISOString() : String(row.run_at);
      }
    } catch (tableErr) {
      const msg = String(tableErr);
      if (!msg.includes("does not exist") && !msg.includes("relation")) throw tableErr;
    }

    // School years already loaded for this dataset, straight from the data table.
    let loadedYears: string[] = [];
    try {
      const table = kind === "eis" ? "il_eis_district" : "tss_annual";
      const whereIL = kind === "tss" ? "WHERE state = 'IL'" : "";
      const rows = await db.execute(sql.raw(
        `SELECT DISTINCT school_year FROM ${table} ${whereIL} ORDER BY school_year DESC LIMIT 8`,
      ));
      loadedYears = rows.rows.map((r) => String((r as { school_year: string }).school_year));
    } catch (tableErr) {
      const msg = String(tableErr);
      if (!msg.includes("does not exist") && !msg.includes("relation")) throw tableErr;
    }

    const lastStatus = running ? "running" : (st.lastStatus ?? persistedStatus ?? null);
    const lastRunAt = running
      ? (st.lastRunAt?.toISOString() ?? null)
      : (st.lastRunAt?.toISOString() ?? persistedRunAt);

    res.json({
      running,
      pid: st.pid,
      lastStatus,
      lastRunAt,
      lastFile: st.lastFile,
      lastSchoolYear: st.lastSchoolYear,
      loadedYears,
      tail: tailLines,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Customer management endpoints (users table, role = 'district_user')
// ---------------------------------------------------------------------------

// GET /admin/customers — list all district_user accounts
router.get("/admin/customers", requireAdminToken, async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT u.id, u.name, u.email, u.active, u.plan, u.district_id, d.name AS district_name,
             u.created_at, u.last_sign_in_at,
             (u.password_hash IS NOT NULL) AS has_password,
             COALESCE(le.login_count, 0)::int AS login_count
      FROM users u
      LEFT JOIN districts d ON d.id = u.district_id
      LEFT JOIN (
        SELECT user_id, COUNT(*)::int AS login_count
        FROM login_events
        GROUP BY user_id
      ) le ON le.user_id = u.id
      WHERE u.role = 'district_user'
      ORDER BY u.created_at DESC
    `);
    res.json({ customers: rows.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/customers — create a new district user account
router.post("/admin/customers", requireAdminToken, heavyAdminLimiter, async (req, res) => {
  const { name, email, district_id, password, plan } = req.body as {
    name?: string;
    email?: string;
    district_id?: number | null;
    password?: string;
    plan?: string;
  };
  if (!name?.trim() || !email?.includes("@")) {
    res.status(400).json({ error: "Name and valid email are required" });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  const normalPlan = plan === "pro" ? "pro" : "free";
  const normalEmail = email.toLowerCase().trim();
  const bcrypt = await import("bcrypt");
  const hash = await bcrypt.hash(password, 12);
  try {
    const rows = await db.execute(sql`
      INSERT INTO users (name, email, role, plan, active, district_id, password_hash)
      VALUES (${name.trim()}, ${normalEmail}, 'district_user', ${normalPlan}, true, ${district_id ?? null}, ${hash})
      RETURNING id, name, email, active, plan, district_id, created_at, last_sign_in_at
    `);
    res.json({ customer: rows.rows[0] });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      res.status(409).json({ error: "This email is already registered" });
    } else {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ---------------------------------------------------------------------------
// Firm provisioning (admin-only). Public firm self-signup was removed; the
// platform admin creates a firm + its first firm_admin user here and hands the
// credentials to the client. This reuses the same users + firms + firm_members
// creation logic and bcrypt cost as the old POST /api/firm/signup, but never
// touches the admin's own session.
// ---------------------------------------------------------------------------

const FIRM_PLAN_TIERS = ["state", "region", "national"] as const;
const FIRM_MIN_PASSWORD = 8;

// Generate a readable, high-entropy password for hand-off. base64url avoids
// shell/URL-unsafe characters; ~16 chars from 12 random bytes.
function generateFirmPassword(): string {
  return randomBytes(12).toString("base64url");
}

// GET /admin/firms — list firms with member counts and created dates.
router.get("/admin/firms", requireAdminToken, async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT f.id, f.name, f.plan_tier, f.created_at,
             COUNT(fm.user_id)::int AS member_count
      FROM firms f
      LEFT JOIN firm_members fm ON fm.firm_id = f.id
      GROUP BY f.id, f.name, f.plan_tier, f.created_at
      ORDER BY f.created_at DESC, f.id DESC
    `);
    res.json({ firms: rows.rows });
  } catch (err) {
    console.error("admin/firms list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/firms — create a firm plus its first firm_admin user in one
// transaction. Body: { firmName, planTier?, email, name?, password? }. When no
// password is supplied a secure one is generated and returned once. Duplicate
// email is rejected. Does NOT modify the admin's session.
router.post("/admin/firms", requireAdminToken, heavyAdminLimiter, async (req, res) => {
  const { firmName, planTier, email, name, password } = req.body as {
    firmName?: string;
    planTier?: string;
    email?: string;
    name?: string;
    password?: string;
  };

  if (!firmName?.trim()) {
    res.status(400).json({ error: "Firm name is required." });
    return;
  }
  const normalEmail = (email ?? "").toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalEmail)) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }
  const tier = (FIRM_PLAN_TIERS as readonly string[]).includes(planTier ?? "")
    ? (planTier as string)
    : "state";

  // Use the supplied password, or generate one to hand off. Validate length
  // only when the admin typed one.
  const suppliedPassword = typeof password === "string" && password.length > 0;
  if (suppliedPassword && (password as string).length < FIRM_MIN_PASSWORD) {
    res.status(400).json({ error: `Password must be at least ${FIRM_MIN_PASSWORD} characters.` });
    return;
  }
  const plainPassword = suppliedPassword ? (password as string) : generateFirmPassword();

  try {
    const existing = await db.execute(
      sql`SELECT id FROM users WHERE email = ${normalEmail} LIMIT 1`,
    );
    if (existing.rows.length) {
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }

    const bcrypt = await import("bcrypt");
    const passwordHash = await bcrypt.hash(plainPassword, 12);

    const created = await db.transaction(async (tx) => {
      const u = await tx.execute(sql`
        INSERT INTO users (email, name, password_hash, role, plan, active)
        VALUES (${normalEmail}, ${name?.trim() || null}, ${passwordHash}, 'district_user', 'free', true)
        RETURNING id
      `);
      const uid = Number((u.rows[0] as { id: unknown }).id);
      const f = await tx.execute(sql`
        INSERT INTO firms (name, plan_tier) VALUES (${firmName.trim()}, ${tier})
        RETURNING id, name, plan_tier, created_at
      `);
      const frow = f.rows[0] as {
        id: unknown;
        name: unknown;
        plan_tier: unknown;
        created_at: unknown;
      };
      await tx.execute(sql`
        INSERT INTO firm_members (firm_id, user_id, role)
        VALUES (${Number(frow.id)}, ${uid}, 'firm_admin')
      `);
      return { userId: uid, firm: frow };
    });

    res.json({
      ok: true,
      firm: {
        id: Number(created.firm.id),
        name: String(created.firm.name),
        plan_tier: String(created.firm.plan_tier),
        created_at: created.firm.created_at,
        member_count: 1,
      },
      user: {
        id: created.userId,
        email: normalEmail,
        name: name?.trim() || null,
      },
      // Returned once for the admin's hand-off panel. A generated password is
      // not stored anywhere in plaintext and cannot be retrieved again.
      password: plainPassword,
      passwordGenerated: !suppliedPassword,
    });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("users_email") || msg.includes("unique") || msg.includes("duplicate")) {
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }
    console.error("admin/firms create error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/bulk-import-customers — load a CSV of paying district contacts as
// district_user accounts, all marked plan='pro' + active=true. Idempotent by
// email (re-running updates in place). ROE rows are skipped; rows missing an
// email or password are skipped and reported. District is matched by RCDTS
// 9-digit prefix against districts.state_district_id (IL), falling back to a
// district-name match.
// ---------------------------------------------------------------------------

const MAX_CSV_BYTES = 32 * 1024 * 1024; // 32 MB
const uploadCsvBody = raw({ type: () => true, limit: MAX_CSV_BYTES });
const uploadJsonBody = json({ limit: MAX_CSV_BYTES });

/** RFC4180-ish CSV parser: handles quoted fields, embedded commas/quotes, and
 *  newlines inside quotes. Returns an array of string[] rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  // Strip a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // swallow; the following \n (or its absence) ends the row
      if (text[i + 1] !== "\n") pushRow();
    } else {
      field += c;
    }
  }
  // Flush a trailing field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/** Run an async mapper over items with a bounded concurrency. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

interface SkippedRow {
  row: number;
  district: string;
  email: string;
  reason: string;
}
interface UnmatchedRow {
  row: number;
  district: string;
  email: string;
  rcdts: string;
}

const ALLOWED_ENTITY = new Set(["district", "district (add'l contact)"]);

interface ColumnMap {
  iEntity: number;
  iDistrict: number;
  iRcdts: number;
  iName: number;
  iEmail: number;
  iPassword: number;
}

/** Map header names (case-insensitive, trimmed) to column indexes. Returns null
 *  if a required column ('Entity Type', 'Email', 'Password') is missing. */
function mapColumns(headerRow: string[]): ColumnMap | null {
  const header = headerRow.map((h) => String(h ?? "").trim().toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());
  const map: ColumnMap = {
    iEntity: col("Entity Type"),
    iDistrict: col("District"),
    iRcdts: col("RCDTS"),
    iName: col("Administrator"),
    iEmail: col("Email"),
    iPassword: col("Password"),
  };
  if (map.iEntity < 0 || map.iEmail < 0 || map.iPassword < 0) return null;
  return map;
}

interface DistrictLookups {
  byPrefix: Map<string, number>;
  byName: Map<string, number>;
}

/** Load all IL districts once for in-memory matching (RCDTS prefix + name). */
async function loadDistrictLookups(): Promise<DistrictLookups> {
  const distRows = await db.execute(sql`
    SELECT id, name, state_district_id FROM districts WHERE state = 'IL'
  `);
  const byPrefix = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const r of distRows.rows as {
    id: number | string;
    name: string;
    state_district_id: string;
  }[]) {
    const id = Number(r.id);
    const sid = String(r.state_district_id ?? "");
    if (sid.length >= 9) {
      const prefix = sid.slice(0, 9);
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, id);
    }
    const nameKey = (r.name ?? "").trim().toLowerCase();
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, id);
  }
  return { byPrefix, byName };
}

interface ProcessResult {
  created: number;
  updated: number;
  skipped: SkippedRow[];
  unmatchedDistrict: UnmatchedRow[];
}

/** Validate, district-match, hash, and upsert a set of CSV data rows. `startLine`
 *  is the 1-based spreadsheet line number of the first row in `dataRows` (the
 *  header is line 1, so the first data row is line 2). Processing is stateless so
 *  a large import can be split into batches that each finish within the
 *  deployment's request timeout. */
async function processDataRows(
  cols: ColumnMap,
  dataRows: string[][],
  startLine: number,
  lookups: DistrictLookups,
): Promise<ProcessResult> {
  const { iEntity, iDistrict, iRcdts, iName, iEmail, iPassword } = cols;
  const { byPrefix, byName } = lookups;

  interface Candidate {
    rowNum: number;
    district: string;
    email: string;
    name: string;
    password: string;
    districtId: number | null;
    rcdts: string;
  }
  const candidates: Candidate[] = [];
  const skipped: SkippedRow[] = [];
  const unmatchedDistrict: UnmatchedRow[] = [];

  for (let j = 0; j < dataRows.length; j++) {
    const cells = dataRows[j] ?? [];
    // Skip completely blank lines.
    if (cells.every((c) => String(c ?? "").trim() === "")) continue;
    const rowNum = startLine + j; // 1-based spreadsheet line number
    const entity = String(cells[iEntity] ?? "").trim().toLowerCase();
    const districtName = iDistrict >= 0 ? String(cells[iDistrict] ?? "").trim() : "";
    const email = String(cells[iEmail] ?? "").trim().toLowerCase();
    const password = String(cells[iPassword] ?? "");
    const rcdts = iRcdts >= 0 ? String(cells[iRcdts] ?? "").trim() : "";
    const name = iName >= 0 ? String(cells[iName] ?? "").trim() : "";

    if (!ALLOWED_ENTITY.has(entity)) {
      skipped.push({
        row: rowNum,
        district: districtName,
        email,
        reason: entity ? `entity type "${entity}"` : "missing entity type",
      });
      continue;
    }
    if (!email || !email.includes("@")) {
      skipped.push({ row: rowNum, district: districtName, email, reason: "no email" });
      continue;
    }
    if (!password.trim()) {
      skipped.push({ row: rowNum, district: districtName, email, reason: "no password" });
      continue;
    }

    // Resolve district: RCDTS 9-digit prefix first, then district-name match.
    let districtId: number | null = null;
    if (rcdts) {
      const padded = rcdts.length < 9 ? rcdts.padStart(9, "0") : rcdts.slice(0, 9);
      districtId = byPrefix.get(padded) ?? byPrefix.get(rcdts) ?? null;
    }
    if (districtId == null && districtName) {
      districtId = byName.get(districtName.toLowerCase()) ?? null;
    }

    candidates.push({
      rowNum,
      district: districtName,
      email,
      name: name || email.split("@")[0],
      password,
      districtId,
      rcdts,
    });
  }

  // Hash all passwords with bounded concurrency (bcrypt releases the event
  // loop via the thread pool, so a few in flight at once is much faster than
  // serial while staying well-behaved).
  const bcrypt = await import("bcrypt");
  const hashes = await mapLimit(candidates, 8, (c) => bcrypt.hash(c.password, 12));

  let created = 0;
  let updated = 0;
  for (let k = 0; k < candidates.length; k++) {
    const c = candidates[k];
    const hash = hashes[k];
    try {
      const result = await db.execute(sql`
        INSERT INTO users (name, email, role, plan, active, district_id, password_hash)
        VALUES (${c.name}, ${c.email}, 'district_user', 'pro', true, ${c.districtId}, ${hash})
        ON CONFLICT (email) DO UPDATE SET
          name = EXCLUDED.name,
          district_id = COALESCE(EXCLUDED.district_id, users.district_id),
          plan = 'pro',
          active = true,
          password_hash = EXCLUDED.password_hash,
          failed_login_count = 0,
          lockout_until = NULL
        WHERE users.role = 'district_user'
        RETURNING (xmax = 0) AS inserted
      `);
      if (result.rows.length === 0) {
        // Conflict on a non-district_user (e.g. an admin) — left untouched.
        skipped.push({
          row: c.rowNum,
          district: c.district,
          email: c.email,
          reason: "email belongs to a non-customer account",
        });
        continue;
      }
      const inserted = (result.rows[0] as { inserted: boolean }).inserted;
      if (inserted) created++;
      else updated++;
      // Only report rows that were actually imported but couldn't be linked to
      // a district — so the admin can fix exactly those accounts.
      if (c.districtId == null) {
        unmatchedDistrict.push({
          row: c.rowNum,
          district: c.district,
          email: c.email,
          rcdts: c.rcdts,
        });
      }
    } catch (err) {
      console.error(`Bulk import row ${c.rowNum} (${c.email}) failed:`, err);
      skipped.push({
        row: c.rowNum,
        district: c.district,
        email: c.email,
        reason: "database error",
      });
    }
  }

  return { created, updated, skipped, unmatchedDistrict };
}

async function handleBulkImportCustomers(req: Request, res: Response): Promise<void> {
  const ct = String(req.headers["content-type"] || "");

  // Batch mode: the client parses the CSV and POSTs JSON batches of rows so each
  // request finishes well within the deployment's request timeout. Hashing is
  // CPU-bound (bcrypt), so a single huge upload can exceed the proxy timeout and
  // be aborted mid-flight.
  if (ct.includes("application/json")) {
    const payload = (req.body ?? {}) as {
      header?: unknown;
      rows?: unknown;
      startRow?: unknown;
    };
    if (!Array.isArray(payload.header) || !Array.isArray(payload.rows)) {
      res.status(400).json({ error: "Batch must include 'header' and 'rows' arrays" });
      return;
    }
    const cols = mapColumns(payload.header as string[]);
    if (!cols) {
      res.status(400).json({
        error:
          "CSV is missing required columns. Expected at least 'Entity Type', 'Email', and 'Password'.",
      });
      return;
    }
    const startRow =
      typeof payload.startRow === "number" && payload.startRow >= 2 ? payload.startRow : 2;
    const lookups = await loadDistrictLookups();
    const result = await processDataRows(cols, payload.rows as string[][], startRow, lookups);
    res.json({
      ok: true,
      processed: (payload.rows as string[][]).length,
      created: result.created,
      updated: result.updated,
      skippedCount: result.skipped.length,
      unmatchedCount: result.unmatchedDistrict.length,
      skipped: result.skipped,
      unmatchedDistrict: result.unmatchedDistrict,
    });
    return;
  }

  // Legacy single-shot mode: raw CSV body (kept for backwards compatibility and
  // small files).
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    res.status(400).json({ error: "No CSV file received" });
    return;
  }
  const grid = parseCsv(buf.toString("utf8"));
  if (grid.length < 2) {
    res.status(400).json({ error: "CSV has no data rows" });
    return;
  }
  const cols = mapColumns(grid[0]);
  if (!cols) {
    res.status(400).json({
      error:
        "CSV is missing required columns. Expected at least 'Entity Type', 'Email', and 'Password'.",
    });
    return;
  }
  const lookups = await loadDistrictLookups();
  const result = await processDataRows(cols, grid.slice(1), 2, lookups);
  res.json({
    ok: true,
    total: grid.length - 1,
    created: result.created,
    updated: result.updated,
    skippedCount: result.skipped.length,
    unmatchedCount: result.unmatchedDistrict.length,
    skipped: result.skipped,
    unmatchedDistrict: result.unmatchedDistrict,
  });
}

router.post("/admin/bulk-import-customers", requireAdminToken, heavyAdminLimiter, (req, res) => {
  // JSON batches (the large-import path) parse as JSON; legacy single-shot CSV
  // uploads parse as a raw buffer.
  const ct = String(req.headers["content-type"] || "");
  const parser = ct.includes("application/json") ? uploadJsonBody : uploadCsvBody;
  parser(req, res, (err?: unknown) => {
    if (err) {
      const status =
        (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
      if (status === 413) {
        res.status(413).json({ error: "Upload too large (max 32 MB per batch)" });
      } else {
        res.status(400).json({ error: "Failed to read upload body" });
      }
      return;
    }
    handleBulkImportCustomers(req, res).catch((e) => {
      console.error("Bulk import error:", e);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    });
  });
});

// PATCH /admin/customers/:id — update name, district, or active status
router.patch("/admin/customers/:id", requireAdminToken, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Valid numeric id required" });
    return;
  }
  const { active, name, district_id, plan } = req.body as {
    active?: boolean;
    name?: string;
    district_id?: number | null;
    plan?: string;
  };
  if (plan !== undefined && plan !== "free" && plan !== "pro") {
    res.status(400).json({ error: "Plan must be 'free' or 'pro'" });
    return;
  }

  try {
    if (active !== undefined) {
      await db.execute(sql`UPDATE users SET active = ${active} WHERE id = ${id} AND role = 'district_user'`);
    }
    if (name !== undefined) {
      await db.execute(sql`UPDATE users SET name = ${name.trim()} WHERE id = ${id} AND role = 'district_user'`);
    }
    if (district_id !== undefined) {
      await db.execute(sql`UPDATE users SET district_id = ${district_id ?? null} WHERE id = ${id} AND role = 'district_user'`);
    }
    if (plan !== undefined) {
      await db.execute(sql`UPDATE users SET plan = ${plan} WHERE id = ${id} AND role = 'district_user'`);
    }
    const updated = await db.execute(sql`
      SELECT id, name, email, active, plan, district_id, created_at, last_sign_in_at,
             (password_hash IS NOT NULL) AS has_password
      FROM users WHERE id = ${id} AND role = 'district_user'
    `);
    if (updated.rows.length === 0) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    res.json({ customer: updated.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /admin/customers/:id/password — set or reset a customer's password
router.patch("/admin/customers/:id/password", requireAdminToken, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Valid numeric id required" });
    return;
  }
  const { password } = req.body as { password?: string };
  if (!password || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  try {
    const bcrypt = await import("bcrypt");
    const hash = await bcrypt.hash(password, 12);
    const result = await db.execute(sql`
      UPDATE users
      SET password_hash = ${hash}, failed_login_count = 0, lockout_until = NULL
      WHERE id = ${id} AND role = 'district_user'
    `);
    const affected = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (affected === 0) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /admin/customers/:id — remove a customer account
router.delete("/admin/customers/:id", requireAdminToken, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Valid numeric id required" });
    return;
  }
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${id} AND role = 'district_user'`);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// CBA data promotion (dev -> prod). Accepts a gzipped JSON bundle produced by
// pipeline/20_export_promotion_bundle.py. Defaults to a dry run; pass
// ?apply=true to commit. Auth: admin session OR Authorization: Bearer <secret>,
// where the secret is ADMIN_TOKEN if set, else the existing ADMIN_PASSWORD
// (so programmatic / cross-environment calls work without a new secret).
// ---------------------------------------------------------------------------
function requirePromoteAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session.adminAuthenticated) {
    next();
    return;
  }
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD || "";
  if (expected && token) {
    const a = createHash("sha256").update(token).digest();
    const b = createHash("sha256").update(expected).digest();
    if (timingSafeEqual(a, b)) {
      next();
      return;
    }
  }
  res.status(401).json({ error: "Unauthorized: admin login or bearer token required" });
}

router.post(
  "/admin/promote",
  requirePromoteAuth,
  heavyAdminLimiter,
  raw({ type: () => true, limit: "256mb" }),
  async (req: Request, res: Response) => {
    try {
      let buf = req.body as Buffer;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        res.status(400).json({ error: "Empty request body" });
        return;
      }
      // gunzip if gzip-magic (0x1f 0x8b), otherwise treat as UTF-8 JSON.
      if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        buf = gunzipSync(buf);
      }
      let bundle: { tables?: Record<string, unknown[]> };
      try {
        bundle = JSON.parse(buf.toString("utf8"));
      } catch {
        res.status(400).json({ error: "Body is not valid JSON" });
        return;
      }
      if (!bundle || typeof bundle !== "object" || !bundle.tables) {
        res.status(400).json({ error: "Bundle missing 'tables'" });
        return;
      }
      const dryRun = req.query.apply !== "true";
      const summary = await runPromotion(pool, bundle as { tables?: Record<string, any[]> }, {
        dryRun,
      });
      res.json(summary);
    } catch (err) {
      console.error("Promotion error:", err);
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Promotion failed" });
    }
  },
);

// Recent promotion runs (most recent first).
router.get("/admin/promotion-runs", requirePromoteAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, dry_run, summary FROM promotion_runs
       ORDER BY created_at DESC LIMIT 25`,
    );
    res.json({ runs: rows });
  } catch (err) {
    // Table may not exist yet (no apply has run).
    if (err instanceof Error && /relation .* does not exist/.test(err.message)) {
      res.json({ runs: [] });
      return;
    }
    res.status(500).json({ error: "Could not load promotion runs" });
  }
});

export default router;
