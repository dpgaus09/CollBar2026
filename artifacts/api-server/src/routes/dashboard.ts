import { Router, raw, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { parseUnit } from "./bargaining-units.js";
import {
  CUSTOMER_STATE,
  bandSql,
  buildWhere,
  isCustomerDistrict,
} from "../lib/dashboard-query.js";
import { gate, isFree, loadAccess, loadAccessForUser, UPGRADE_MESSAGE, type Access } from "../lib/access.js";
import {
  queryDistrictList,
  queryDistrictDetail,
  queryDistrictSettlements,
  queryDistrictSalarySchedules,
  queryDistrictProvisions,
  queryDistrictBaseline,
} from "../lib/district-reads.js";
import { verifyDocumentAccessToken } from "../lib/documentToken.js";
import { uploadCustomerSubmission, DriveNotConnectedError } from "../lib/google-drive.js";
import { uploadedCbaKey, streamObjectTo } from "../lib/objectStorage.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId || req.session.userRole !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/min-teacher-salary
// IL statutory minimum full-time teacher salary (CGFA, PA 103-515). Statewide
// reference data — IL-only, so it is empty when the customer state is not IL.
// ---------------------------------------------------------------------------
router.get("/dashboard/min-teacher-salary", requireAuth, async (_req: Request, res: Response) => {
  if (CUSTOMER_STATE && CUSTOMER_STATE !== "IL") {
    res.json({ state: CUSTOMER_STATE, latest: null, history: [] });
    return;
  }
  try {
    const rows = await db.execute(sql`
      SELECT school_year          AS "schoolYear",
             prior_year           AS "priorYear",
             prior_year_rate      AS "priorYearRate",
             percentage_increase::float AS "percentageIncrease",
             new_year_rate        AS "newYearRate",
             certified_date       AS "certifiedDate",
             source_url           AS "sourceUrl"
      FROM il_min_teacher_salary
      ORDER BY school_year DESC
    `);
    const history = rows.rows;
    res.json({ state: "IL", latest: history[0] ?? null, history });
  } catch (err) {
    const msg = String(err);
    if (msg.includes("does not exist") || msg.includes("relation")) {
      res.json({ state: "IL", latest: null, history: [] });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts
// ---------------------------------------------------------------------------
router.get("/dashboard/districts", requireAuth, async (req: Request, res: Response) => {
  const q = req.query.q ? String(req.query.q).trim() : "";
  try {
    const districts = await queryDistrictList(q);
    res.json({ districts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id", gate({ ownDistrict: true }), async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }
  // Overview is scoped to one bargaining unit (CBAs are negotiated per unit and
  // never mixed). Defaults to teachers; the current contract + provisions below
  // reflect the selected unit so toggling the unit selector actually changes them.
  const unit = parseUnit(req.query.bargainingUnit);

  try {
    const detail = await queryDistrictDetail(districtId, unit);
    if (!detail) { res.status(404).json({ error: "District not found" }); return; }
    res.json(detail);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/provisions
// Overview data source. Free customers may read this for their OWN district
// (Overview is free), but the verbatim contract language (clause_excerpt) is the
// signature content of the paid Key Clauses feature, so it is stripped for free
// users. The full, browsable clause set lives behind the paid /clauses endpoint.
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/provisions", gate({ ownDistrict: true }), async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }

  const VALID = new Set(["compensation","insurance","retirement","leave","workday","evaluation","rif","grievance","other"]);
  const rawCat = req.query.category ? String(req.query.category) : "";
  if (rawCat && !VALID.has(rawCat)) { res.status(400).json({ error: "Invalid category" }); return; }
  // Provisions belong to a single bargaining unit's contract; scope to the
  // selected unit (default teachers) so the Overview cards switch with the unit.
  const unit = parseUnit(req.query.bargainingUnit);

  try {
    if (!(await isCustomerDistrict(districtId))) { res.status(404).json({ error: "District not found" }); return; }
    // Free customers may read their own Overview, but the verbatim clause
    // excerpt stays paid-only — strip it for free users (includeExcerpt=false).
    const free = req.access ? isFree(req.access) : false;
    const { provisions } = await queryDistrictProvisions(districtId, unit, rawCat || null, {
      includeExcerpt: !free,
    });
    res.json({ provisions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/clauses
// Full, browsable provision set incl. verbatim clause excerpts — the paid Key
// Clauses feature. Gated paid + own-district so free users cannot reconstruct it
// via direct API calls.
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/clauses", gate({ ownDistrict: true, paid: true }), async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }

  const VALID = new Set(["compensation","insurance","retirement","leave","workday","evaluation","rif","grievance","other"]);
  const rawCat = req.query.category ? String(req.query.category) : "";
  if (rawCat && !VALID.has(rawCat)) { res.status(400).json({ error: "Invalid category" }); return; }

  try {
    if (!(await isCustomerDistrict(districtId))) { res.status(404).json({ error: "District not found" }); return; }
    const catCondition = rawCat ? sql`AND cp.category = ${rawCat}` : sql``;
    const rows = await db.execute(sql`
      SELECT cp.id, cp.category, cp.provision_key, cp.value_numeric, cp.value_text,
             cp.unit, cp.clause_excerpt, cp.page_ref, cp.confidence, cp.human_verified,
             c.id AS contract_id, c.effective_start, c.effective_end,
             c.source_doc_id, sd.source_url, sd.retrieved_at
      FROM contract_provisions cp
      JOIN contracts c ON cp.contract_id = c.id
      LEFT JOIN source_documents sd ON c.source_doc_id = sd.id
      WHERE c.district_id = ${districtId}
      ${catCondition}
      ORDER BY c.effective_start DESC NULLS LAST, cp.category, cp.provision_key
      LIMIT 200
    `);
    res.json({ provisions: rows.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/settlements
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/settlements", gate({ ownDistrict: true }), async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }
  const unit = parseUnit(req.query.bargainingUnit);
  try {
    if (!(await isCustomerDistrict(districtId))) { res.status(404).json({ error: "District not found" }); return; }
    res.json(await queryDistrictSettlements(districtId, unit));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboard/districts/:id/settlements/:settlementId/verify
// Lets a district's own administrator confirm (or un-confirm) one of THEIR
// settlement figures. body: { verified: boolean }.
//
// Access: any authenticated user whose account is tied to this district may
// verify its data; CollBar admins may verify any district (recorded as an
// 'internal' verification). Everyone else is rejected server-side regardless of
// the UI (no IDOR) — gate() only scopes FREE users, so Pro district users are
// still re-checked here against their own districtId. District users may never
// touch an 'internal' verification (that stays an admin-only review path).
// ---------------------------------------------------------------------------
router.post(
  "/dashboard/districts/:id/settlements/:settlementId/verify",
  gate(),
  async (req: Request, res: Response) => {
    const districtId = parseInt(String(req.params.id), 10);
    const settlementId = parseInt(String(req.params.settlementId), 10);
    if (isNaN(districtId) || isNaN(settlementId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const verified = (req.body as { verified?: unknown })?.verified;
    if (typeof verified !== "boolean") {
      res.status(400).json({ error: "verified (boolean) is required" });
      return;
    }
    const access = req.access!;
    const isAdmin = access.role === "admin";
    // Non-admins may only act on their OWN district, regardless of plan.
    if (!isAdmin && (access.districtId == null || access.districtId !== districtId)) {
      res.status(403).json({ error: "FORBIDDEN_DISTRICT", message: UPGRADE_MESSAGE });
      return;
    }
    try {
      // The settlement must exist AND belong to the district named in the path
      // (prevents verifying another district's row via a mismatched URL).
      const cur = await db.execute(sql`
        SELECT id, district_id, verified_by
        FROM settlements
        WHERE id = ${settlementId} AND district_id = ${districtId}
        LIMIT 1
      `);
      const row = cur.rows[0] as
        | { id: unknown; district_id: unknown; verified_by: string | null }
        | undefined;
      if (!row) {
        res.status(404).json({ error: "Settlement not found" });
        return;
      }
      // Protect CollBar staff verifications: a district user cannot overwrite or
      // clear an 'internal' verification (admin-only review path stays intact).
      if (!isAdmin && row.verified_by === "internal") {
        res.status(403).json({ error: "FORBIDDEN", message: "This figure was verified by CollBar staff." });
        return;
      }
      if (verified) {
        const verifier = isAdmin ? "internal" : "district";
        await db.execute(sql`
          UPDATE settlements
          SET human_verified = true,
              verified_by = ${verifier},
              verified_by_user_id = ${access.userId},
              verified_at = NOW()
          WHERE id = ${settlementId} AND district_id = ${districtId}
        `);
        res.json({ ok: true, human_verified: true, verified_by: verifier });
      } else {
        await db.execute(sql`
          UPDATE settlements
          SET human_verified = false,
              verified_by = NULL,
              verified_by_user_id = NULL,
              verified_at = NULL
          WHERE id = ${settlementId} AND district_id = ${districtId}
        `);
        res.json({ ok: true, human_verified: false, verified_by: null });
      }
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/salary-schedules
// Full salary-schedule grids extracted from the CBA appendix: for teachers,
// experience steps x education lanes (BA, BA+15, MA or 36, MA+30, ...); for
// non-lane units (custodial, etc.) a single step->salary column (or a job-class
// grid with no education lanes). Unit-scoped (CBAs never mix units; defaults to
// teachers) and own-district gated, like the rest of the Overview.
//
// Returns the MOST RECENT (district, unit) contract that has extracted grids —
// a single contract already spans several school years, so we never mix
// overlapping years across successive CBAs. Each schedule carries every dollar
// cell plus selector metadata (job families, school years) and a small derived
// summary (base/MA-base/max for the default family's latest year).
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/salary-schedules", gate({ ownDistrict: true }), async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }
  const unit = parseUnit(req.query.bargainingUnit);

  try {
    if (!(await isCustomerDistrict(districtId))) { res.status(404).json({ error: "District not found" }); return; }
    res.json(await queryDistrictSalarySchedules(districtId, unit));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/baseline
// State-reported baseline salary & benefits for a single district: the ISBE
// Teacher Salary Study snapshot (tss_annual) — schedule lanes + benefits — and
// the ISBE EIS actual-pay statistics (il_eis_district, plus a per-position
// aggregate from il_eis_position_summary). These are the state's official
// baseline figures, DISTINCT from the negotiated CBA grid the rest of the
// profile shows, and exist even for districts whose CBA hasn't been extracted.
//
// Aggregates only — never individual educator names. Scoped exactly like the
// rest of the profile: gate({ ownDistrict: true }) restricts free customers to
// their own district, and isCustomerDistrict() blocks reading another state's
// district by id (anti-IDOR). The EIS tables have no `state` column, so every
// query is anchored through districts d on state_district_id + d.state.
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/baseline", gate({ ownDistrict: true }), async (req: Request, res: Response) => {
  const idStr = String(req.params.id);
  // Strict numeric id — "10588abc" must 400, not silently parse to 10588.
  if (!/^\d+$/.test(idStr)) { res.status(400).json({ error: "Invalid district id" }); return; }
  const districtId = Number(idStr);

  try {
    if (!(await isCustomerDistrict(districtId))) { res.status(404).json({ error: "District not found" }); return; }

    res.json(await queryDistrictBaseline(districtId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/document?src=upload://...
// Streams a locally-stored uploaded CBA PDF so its source link renders in the
// browser. Crawled docs use real http(s) URLs and are linked directly by the
// client, so only the 'upload://' scheme is served here.
// ---------------------------------------------------------------------------
// Render a document-route error. "View source PDF" links open in a NEW
// top-level browser tab, so on failure the user would otherwise stare at raw
// JSON on a blank white page. For genuine top-level navigations (which set
// Sec-Fetch-Dest: document) return a small readable HTML page instead; API/XHR
// callers (and tests) still receive the original JSON body.
function sendDocumentError(
  req: Request,
  res: Response,
  status: number,
  error: string,
  message?: string,
): void {
  if (req.headers["sec-fetch-dest"] === "document") {
    const heading =
      status === 401 ? "Sign-in required" :
      status === 403 ? "Access restricted" :
      "Document unavailable";
    const detail = message ?? (
      status === 404 ? "This source document could not be found. It may not have been saved to storage yet." :
      status === 401 ? "Your session has expired. Return to CollBar and sign in again to view this document." :
      "We couldn't open this document."
    );
    res
      .status(status)
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${heading}</title>` +
        `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
        `background:#020617;color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}` +
        `.card{max-width:28rem;padding:2rem;text-align:center}` +
        `h1{font-size:1.1rem;margin:0 0 .5rem;color:#f1f5f9}` +
        `p{font-size:.85rem;line-height:1.5;color:#94a3b8;margin:0}</style></head>` +
        `<body><div class="card"><h1>${heading}</h1><p>${detail}</p></div></body></html>`,
      );
    return;
  }
  res.status(status).json(message ? { error, message } : { error });
}

router.get("/dashboard/document", async (req: Request, res: Response) => {
  // Resolve the caller from the session cookie OR a self-contained signed
  // token. A "View source PDF" link opens a brand-new top-level tab, which in
  // the cross-site Replit preview iframe does not carry the SameSite=Lax
  // session cookie — so these links embed a short-lived HMAC token instead
  // (see lib/documentToken.ts). Either way we resolve the user's LIVE access
  // and apply the identical per-district checks below; the token only proves
  // identity, it does not bypass any authorization.
  let access: Access | null = null;
  try {
    if (req.session.userId) {
      access = await loadAccess(req);
    } else {
      const token = typeof req.query.token === "string" ? req.query.token : "";
      const userId = token ? verifyDocumentAccessToken(token) : null;
      if (userId != null) access = await loadAccessForUser(userId);
    }
  } catch {
    sendDocumentError(req, res, 500, "Internal server error");
    return;
  }
  if (!access || !access.active) {
    sendDocumentError(req, res, 401, "Authentication required");
    return;
  }
  const src = typeof req.query.src === "string" ? req.query.src : "";
  if (!src.startsWith("upload://")) {
    sendDocumentError(req, res, 400, "Unsupported document source");
    return;
  }
  try {
    const result = await db.execute(sql`
      SELECT storage_key, district_id, file_hash
      FROM source_documents
      WHERE source_url = ${src}
      LIMIT 1
    `);
    const row = result.rows[0] as
      | { storage_key: string | null; district_id: number | null; file_hash: string | null }
      | undefined;
    if (!row || !row.storage_key) {
      sendDocumentError(req, res, 404, "Document not found");
      return;
    }
    // bigint district_id comes back from db.execute as a string; coerce so it
    // compares correctly against the numeric access.districtId.
    const docDistrictId = row.district_id == null ? null : Number(row.district_id);
    // Only serve documents for customer-state (IL) districts.
    if (docDistrictId == null || !(await isCustomerDistrict(docDistrictId))) {
      sendDocumentError(req, res, 404, "Document not found");
      return;
    }
    // Access control (mirrors the rest of the dashboard): free customers may
    // only fetch their OWN district's documents (like gate({ ownDistrict: true })).
    // Paid customers and admins may fetch any IL district's document, consistent
    // with the paid Comparables feature which surfaces other districts' source
    // links. Without this any authenticated session could fetch any IL upload.
    if (isFree(access) && (access.districtId == null || docDistrictId !== access.districtId)) {
      sendDocumentError(req, res, 403, "FORBIDDEN_DISTRICT", UPGRADE_MESSAGE);
      return;
    }
    // Primary path: stream the persisted copy from object storage. This is the
    // only source that exists in production — the local filesystem is dev-only
    // and excluded from the deployment image, and autoscale instances are
    // stateless. Falls back to the local file in dev when the object has not
    // been backfilled yet.
    if (row.file_hash) {
      const streamed = await streamObjectTo(uploadedCbaKey(row.file_hash), res);
      if (streamed) return;
    }
    if (row.storage_key.startsWith("local:")) {
      const absPath = row.storage_key.slice("local:".length);
      // storage_key is a trusted server-written value; still keep this to PDFs.
      if (absPath.endsWith(".pdf")) {
        const { existsSync, createReadStream } = await import("fs");
        if (existsSync(absPath)) {
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", "inline");
          createReadStream(absPath).pipe(res);
          return;
        }
      }
    }
    // The row exists but its bytes are absent from object storage. This is the
    // prod symptom of a doc whose only copy was local: (dev-only / ephemeral).
    sendDocumentError(req, res, 404, "Document file missing");
    return;
  } catch (err) {
    console.error(err);
    sendDocumentError(req, res, 500, "Internal server error");
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/factfinding
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/factfinding", gate({ ownDistrict: true, paid: true }), async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }
  try {
    if (!(await isCustomerDistrict(districtId))) { res.status(404).json({ error: "District not found" }); return; }
    const rows = await db.execute(sql`
      SELECT fp.id, fp.case_number, fp.report_date, fp.union_name,
             fp.employer_proposal_pct, fp.union_proposal_pct,
             fp.factfinder_recommendation_pct, fp.year_covered,
             fp.page_ref, fp.confidence, fp.human_verified,
             sd.source_url, sd.retrieved_at
      FROM factfinding_proposals fp
      LEFT JOIN source_documents sd ON fp.source_doc_id = sd.id
      WHERE fp.district_id = ${districtId}
      ORDER BY fp.report_date DESC NULLS LAST
    `);
    res.json({ proposals: rows.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/final-offers
// ELRB board-vs-union final-offer cases for a district: each case's posting
// metadata, the two posted offer PDFs, and the per-topic comparison (diff /
// aligned / one-sided) with each side's position and the numeric gap.
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/final-offers", gate({ ownDistrict: true, paid: true }), async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }
  try {
    if (!(await isCustomerDistrict(districtId))) { res.status(404).json({ error: "District not found" }); return; }

    const postingRows = await db.execute(sql`
      SELECT p.id, p.case_number, p.year, p.bargaining_unit, p.district_name,
             p.union_name, p.posted_date, p.district_offer_url, p.union_offer_url,
             p.page_url
      FROM final_offer_postings p
      WHERE p.district_id = ${districtId}
      ORDER BY p.year DESC, p.posted_date DESC NULLS LAST, p.id DESC
    `);

    const postingIds = postingRows.rows.map((r) => Number((r as Record<string, unknown>).id));

    type Comparison = Record<string, unknown>;
    const compsByPosting = new Map<number, Comparison[]>();
    if (postingIds.length > 0) {
      const compRows = await db.execute(sql`
        SELECT c.posting_id, c.topic, c.topic_label, c.status,
               c.numeric_gap, c.gap_unit, c.district_summary, c.union_summary,
               di.numeric_value AS district_value, di.numeric_unit AS district_unit,
               di.raw_text AS district_raw,
               ui.numeric_value AS union_value, ui.numeric_unit AS union_unit,
               ui.raw_text AS union_raw
        FROM final_offer_comparisons c
        LEFT JOIN final_offer_items di ON c.district_item_id = di.id
        LEFT JOIN final_offer_items ui ON c.union_item_id = ui.id
        WHERE c.posting_id IN (${sql.join(postingIds.map((i) => sql`${i}`), sql`, `)})
        ORDER BY c.posting_id,
          CASE c.status WHEN 'diff' THEN 0 WHEN 'union_only' THEN 1 WHEN 'district_only' THEN 2 ELSE 3 END,
          c.topic
      `);
      for (const row of compRows.rows as Comparison[]) {
        const pid = Number(row.posting_id);
        if (!compsByPosting.has(pid)) compsByPosting.set(pid, []);
        compsByPosting.get(pid)!.push(row);
      }
    }

    const postings = postingRows.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const comparisons = compsByPosting.get(Number(row.id)) ?? [];
      return {
        ...row,
        diff_count: comparisons.filter((c) => c.status === "diff").length,
        aligned_count: comparisons.filter((c) => c.status === "aligned").length,
        comparisons,
      };
    });

    res.json({ postings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/medians — dynamic WHERE via sql.join
// ---------------------------------------------------------------------------
router.get("/dashboard/medians", gate({ ownFilters: true }), async (req: Request, res: Response) => {
  const county = req.query.county ? String(req.query.county) : null;
  const band = req.query.band ? String(req.query.band) : null;
  const yearFrom = req.query.yearFrom ? String(req.query.yearFrom) : null;
  const yearTo = req.query.yearTo ? String(req.query.yearTo) : null;
  const state = CUSTOMER_STATE;
  const unit = parseUnit(req.query.bargainingUnit);

  const conds: Array<SQL | null> = [
    sql`s.base_increase_pct IS NOT NULL`,
    sql`s.bargaining_unit = ${unit}`,
    state ? sql`d.state = ${state}` : null,
    county ? sql`d.county = ${county}` : null,
    yearFrom ? sql`s.from_year >= ${yearFrom}` : null,
    yearTo ? sql`s.to_year <= ${yearTo}` : null,
    band ? bandSql(band) : null,
  ];
  const where = buildWhere(conds);

  try {
    const rows = await db.execute(sql`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.base_increase_pct) AS median_base,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.year2_pct) AS median_year2,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY s.year3_pct) AS median_year3,
        AVG(s.base_increase_pct) AS avg_base,
        COUNT(*)::int AS n,
        COUNT(DISTINCT s.district_id)::int AS district_count
      FROM settlements s
      JOIN districts d ON s.district_id = d.id
      WHERE ${where}
    `);
    const row = (rows.rows[0] ?? null) as Record<string, unknown> | null;
    res.json({
      median_base: row?.median_base ?? null,
      median_year2: row?.median_year2 ?? null,
      median_year3: row?.median_year3 ?? null,
      avg_base: row?.avg_base ?? null,
      n: Number(row?.n ?? 0),
      district_count: Number(row?.district_count ?? 0),
      bargainingUnit: unit,
      coverage: {
        unit,
        settlementCount: Number(row?.n ?? 0),
        districtCount: Number(row?.district_count ?? 0),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/comparables
// ---------------------------------------------------------------------------
router.get("/dashboard/comparables", gate({ paid: true }), async (req: Request, res: Response) => {
  const county = req.query.county ? String(req.query.county) : null;
  const band = req.query.band ? String(req.query.band) : null;
  const districtType = req.query.districtType ? String(req.query.districtType) : null;
  const yearFrom = req.query.yearFrom ? String(req.query.yearFrom) : null;
  const yearTo = req.query.yearTo ? String(req.query.yearTo) : null;
  const state = CUSTOMER_STATE;
  const unit = parseUnit(req.query.bargainingUnit);
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
  const offset = (page - 1) * limit;
  const peerSetId = req.query.peer_set_id ? parseInt(String(req.query.peer_set_id), 10) : null;

  // Resolve peer set district IDs if requested
  let peerDistrictIds: number[] | null = null;
  let peerSetName: string | null = null;
  if (peerSetId && !isNaN(peerSetId)) {
    const userId = req.session.userId!;
    const psRows = await db.execute(sql`
      SELECT name, district_ids FROM peer_sets
      WHERE id = ${peerSetId} AND user_id = ${userId}
    `);
    if (psRows.rows.length > 0) {
      const ps = psRows.rows[0] as { name: string; district_ids: number[] };
      peerSetName = ps.name;
      peerDistrictIds = (ps.district_ids ?? []).map(Number).filter(Boolean);
    }
  }

  // Build WHERE conditions
  const conds: Array<SQL | null> = [
    sql`s.base_increase_pct IS NOT NULL`,
    sql`s.bargaining_unit = ${unit}`,
    state ? sql`d.state = ${state}` : null,
    county ? sql`d.county = ${county}` : null,
    districtType ? sql`d.district_type = ${districtType}` : null,
    yearFrom ? sql`s.from_year >= ${yearFrom}` : null,
    yearTo ? sql`s.to_year <= ${yearTo}` : null,
    band ? bandSql(band) : null,
  ];

  // Add peer set filter
  if (peerDistrictIds !== null) {
    if (peerDistrictIds.length === 0) {
      // Empty peer set → no results
      res.json({ items: [], total: 0, page, limit, pages: 0, medians: null, peer_set_name: peerSetName });
      return;
    }
    const idSql = sql.join(peerDistrictIds.map((id) => sql`${id}`), sql`, `);
    conds.push(sql`d.id IN (${idSql})`);
  }

  const where = buildWhere(conds);

  try {
    const [dataRows, countRows, mediansRows] = await Promise.all([
      db.execute(sql`
        SELECT
          s.id, s.from_year, s.to_year, s.base_increase_pct, s.year2_pct, s.year3_pct,
          s.off_schedule_payment, s.insurance_changed, s.term_years,
          s.method, s.confidence, s.human_verified, s.page_ref,
          s.bargaining_unit, s.verified_by, s.verified_at,
          d.id AS district_id, d.name AS district_name,
          d.county, d.district_type, d.enrollment,
          sd.source_url, sd.retrieved_at
        FROM settlements s
        JOIN districts d ON s.district_id = d.id
        LEFT JOIN LATERAL (
          SELECT c2.source_doc_id
          FROM contracts c2
          WHERE c2.district_id = s.district_id
            AND c2.bargaining_unit = s.bargaining_unit
          ORDER BY c2.effective_end DESC NULLS LAST
          LIMIT 1
        ) lc ON true
        LEFT JOIN source_documents sd ON COALESCE(s.source_doc_id, lc.source_doc_id) = sd.id
        WHERE ${where}
        ORDER BY s.from_year DESC, d.name
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS n
        FROM settlements s
        JOIN districts d ON s.district_id = d.id
        WHERE ${where}
      `),
      db.execute(sql`
        SELECT
          percentile_cont(0.5) WITHIN GROUP (ORDER BY s.base_increase_pct::numeric) AS median_base,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY s.year2_pct::numeric)         AS median_yr2,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY s.year3_pct::numeric)         AS median_yr3,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY s.off_schedule_payment::numeric) AS median_lump,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY s.term_years::numeric)        AS median_term,
          AVG(s.base_increase_pct::numeric)::numeric(10,4)                          AS avg_base,
          COUNT(*)::int                                                              AS n,
          COUNT(DISTINCT s.district_id)::int                                        AS district_count
        FROM settlements s
        JOIN districts d ON s.district_id = d.id
        WHERE ${where}
      `),
    ]);

    const total = (countRows.rows[0] as { n: number })?.n ?? 0;
    const medians = mediansRows.rows[0] ?? null;

    const med = medians as Record<string, unknown> | null;
    res.json({
      items: dataRows.rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      medians,
      bargainingUnit: unit,
      coverage: {
        unit,
        settlementCount: total,
        districtCount: Number(med?.district_count ?? 0),
      },
      peer_set_name: peerSetName,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/expiration-calendar — admin only
// ---------------------------------------------------------------------------
router.get("/dashboard/expiration-calendar", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        d.id AS district_id,
        d.name AS district_name,
        d.county,
        d.enrollment,
        c.id AS contract_id,
        c.union_name,
        c.unit_scope,
        c.effective_end,
        DATE_PART('year',  c.effective_end::date) AS expiry_year,
        DATE_PART('month', c.effective_end::date) AS expiry_month,
        TO_CHAR(c.effective_end::date, 'YYYY-MM')  AS expiry_ym
      FROM contracts c
      JOIN districts d ON c.district_id = d.id
      WHERE c.effective_end IS NOT NULL
      ORDER BY c.effective_end ASC, d.name
    `);

    const byMonth: Record<string, unknown[]> = {};
    for (const row of rows.rows) {
      const r = row as { expiry_ym: string; [k: string]: unknown };
      if (!byMonth[r.expiry_ym]) byMonth[r.expiry_ym] = [];
      byMonth[r.expiry_ym].push(r);
    }

    const months = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, districts]) => ({ month, districts }));

    res.json({ months, totalContracts: rows.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/counties
// ---------------------------------------------------------------------------
router.get("/dashboard/counties", requireAuth, async (req: Request, res: Response) => {
  const stateFilter = CUSTOMER_STATE;
  try {
    const rows = stateFilter
      ? await db.execute(sql`SELECT DISTINCT county FROM districts WHERE county IS NOT NULL AND state = ${stateFilter} ORDER BY county`)
      : await db.execute(sql`SELECT DISTINCT county FROM districts WHERE county IS NOT NULL ORDER BY county`);
    res.json({ counties: (rows.rows as { county: string }[]).map((r) => r.county) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/district-types
// ---------------------------------------------------------------------------
router.get("/dashboard/district-types", requireAuth, async (req: Request, res: Response) => {
  const stateFilter = CUSTOMER_STATE;
  try {
    const rows = stateFilter
      ? await db.execute(sql`SELECT DISTINCT district_type FROM districts WHERE district_type IS NOT NULL AND state = ${stateFilter} ORDER BY district_type`)
      : await db.execute(sql`SELECT DISTINCT district_type FROM districts WHERE district_type IS NOT NULL ORDER BY district_type`);
    res.json({ districtTypes: (rows.rows as { district_type: string }[]).map((r) => r.district_type) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/provision-medians
// Returns per-provision-key medians for a given category, filtered by
// county and/or enrollment band. Used to show "vs. county median" context
// in Insurance, Retirement, and Leave cards.
// ---------------------------------------------------------------------------
router.get("/dashboard/provision-medians", gate({ ownFilters: true }), async (req: Request, res: Response) => {
  const category = req.query.category ? String(req.query.category) : null;
  const county = req.query.county ? String(req.query.county) : null;
  const band = req.query.band ? String(req.query.band) : null;
  const state = CUSTOMER_STATE;
  // Provision medians are a per-unit benchmark: mixing (e.g.) teacher and
  // custodian insurance contributions into one median is meaningless, so scope
  // to the selected bargaining unit (default teachers).
  const unit = parseUnit(req.query.bargainingUnit);

  if (!category) {
    res.status(400).json({ error: "category query parameter is required" });
    return;
  }

  const conds: Array<SQL | null> = [
    sql`cp.category = ${category}`,
    sql`cp.value_numeric IS NOT NULL`,
    sql`c.bargaining_unit = ${unit}`,
    state ? sql`d.state = ${state}` : null,
    county ? sql`d.county = ${county}` : null,
    band ? bandSql(band) : null,
  ];
  const where = buildWhere(conds);

  try {
    const rows = await db.execute(sql`
      SELECT
        cp.provision_key,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY cp.value_numeric) AS median_value,
        COUNT(*)::int AS n
      FROM contract_provisions cp
      JOIN contracts c ON cp.contract_id = c.id
      JOIN districts d ON c.district_id = d.id
      WHERE ${where}
      GROUP BY cp.provision_key
      ORDER BY cp.provision_key
    `);

    const medians: Record<string, number | null> = {};
    let totalN = 0;
    for (const row of rows.rows as { provision_key: string; median_value: string | null; n: number }[]) {
      medians[row.provision_key] = row.median_value != null ? parseFloat(row.median_value) : null;
      totalN = Math.max(totalN, row.n);
    }

    res.json({ medians, n: totalN });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/acceptance — admin only
// Provenance-gap audit across all districts with extracted provisions.
// Used to verify extraction quality without running a separate script.
// ---------------------------------------------------------------------------
router.get("/dashboard/acceptance", requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Run three simple counts to avoid any subquery syntax issues
    const totalDistricts = await db.execute(sql`SELECT COUNT(*)::int AS n FROM districts`);
    const withContracts = await db.execute(sql`SELECT COUNT(DISTINCT district_id)::int AS n FROM contracts`);
    const withProvisions = await db.execute(sql`
      SELECT COUNT(DISTINCT c.district_id)::int AS n
      FROM contract_provisions cp
      JOIN contracts c ON cp.contract_id = c.id
    `);

    const [withSettlements, withFactfinding] = await Promise.all([
      db.execute(sql`SELECT COUNT(DISTINCT district_id)::int AS n FROM settlements`),
      db.execute(sql`SELECT COUNT(DISTINCT district_id)::int AS n FROM factfinding_proposals`),
    ]);

    const summary = {
      districts_total: (totalDistricts.rows[0] as { n: number }).n,
      districts_with_contracts: (withContracts.rows[0] as { n: number }).n,
      districts_with_provisions: (withProvisions.rows[0] as { n: number }).n,
      districts_with_settlements: (withSettlements.rows[0] as { n: number }).n,
      districts_with_factfinding: (withFactfinding.rows[0] as { n: number }).n,
    };

    // Districts with at least one provision missing source doc or page reference
    const [gapRows, okRows, settlementGaps, factfindingGaps] = await Promise.all([
      db.execute(sql`
        SELECT
          d.id AS district_id,
          d.name AS district_name,
          COUNT(cp.id)::int AS total_provisions,
          COUNT(cp.id) FILTER (WHERE c.source_doc_id IS NULL)::int AS missing_source_doc,
          COUNT(cp.id) FILTER (WHERE cp.page_ref IS NULL)::int AS missing_page_ref,
          COUNT(cp.id) FILTER (WHERE cp.confidence IS NULL)::int AS missing_confidence,
          COUNT(cp.id) FILTER (WHERE cp.human_verified = false)::int AS unverified_count,
          AVG(cp.confidence)::numeric(4,3) AS avg_confidence
        FROM contract_provisions cp
        JOIN contracts c ON cp.contract_id = c.id
        JOIN districts d ON c.district_id = d.id
        GROUP BY d.id, d.name
        HAVING
          COUNT(cp.id) FILTER (WHERE c.source_doc_id IS NULL) > 0
          OR COUNT(cp.id) FILTER (WHERE cp.page_ref IS NULL) > 0
        ORDER BY missing_source_doc DESC, missing_page_ref DESC
      `),
      // Districts where all provisions have source doc + page ref
      db.execute(sql`
        SELECT
          d.id AS district_id,
          d.name AS district_name,
          COUNT(cp.id)::int AS total_provisions,
          COUNT(cp.id) FILTER (WHERE cp.human_verified = true)::int AS verified_count,
          AVG(cp.confidence)::numeric(4,3) AS avg_confidence
        FROM contract_provisions cp
        JOIN contracts c ON cp.contract_id = c.id
        JOIN districts d ON c.district_id = d.id
        GROUP BY d.id, d.name
        HAVING
          COUNT(cp.id) FILTER (WHERE c.source_doc_id IS NULL) = 0
          AND COUNT(cp.id) FILTER (WHERE cp.page_ref IS NULL) = 0
        ORDER BY d.name
      `),
      // Settlements missing source_url (via contract source doc)
      db.execute(sql`
        SELECT
          d.id AS district_id,
          d.name AS district_name,
          COUNT(s.id)::int AS total_settlements,
          COUNT(s.id) FILTER (WHERE lc.source_doc_id IS NULL)::int AS missing_source_doc
        FROM settlements s
        JOIN districts d ON s.district_id = d.id
        LEFT JOIN LATERAL (
          SELECT c2.source_doc_id
          FROM contracts c2
          WHERE c2.district_id = s.district_id
          ORDER BY c2.effective_end DESC NULLS LAST
          LIMIT 1
        ) lc ON true
        GROUP BY d.id, d.name
        HAVING COUNT(s.id) FILTER (WHERE lc.source_doc_id IS NULL) > 0
        ORDER BY missing_source_doc DESC
      `),
      // Factfinding proposals missing source_doc_id
      db.execute(sql`
        SELECT
          d.id AS district_id,
          d.name AS district_name,
          COUNT(fp.id)::int AS total_proposals,
          COUNT(fp.id) FILTER (WHERE fp.source_doc_id IS NULL)::int AS missing_source_doc
        FROM factfinding_proposals fp
        JOIN districts d ON fp.district_id = d.id
        GROUP BY d.id, d.name
        HAVING COUNT(fp.id) FILTER (WHERE fp.source_doc_id IS NULL) > 0
        ORDER BY missing_source_doc DESC
      `),
    ]);

    res.json({
      summary: {
        ...summary,
        districts_with_gaps: gapRows.rows.length,
        districts_fully_provenanced: okRows.rows.length,
        districts_settlements_missing_source: settlementGaps.rows.length,
        districts_factfinding_missing_source: factfindingGaps.rows.length,
      },
      provision_gaps: gapRows.rows,
      provision_ok: okRows.rows,
      settlement_gaps: settlementGaps.rows,
      factfinding_gaps: factfindingGaps.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/dashboard/submit-document
// Customer-contributed document upload. A logged-in district user uploads a
// single file (their salary schedule or a CBA PDF); the file is forwarded to the
// admin's Google Drive "CollBar Customer Submissions" folder, organized per
// district. The submission is ALWAYS attributed to the user's own district from
// the session — never a client-supplied id — so a user cannot submit for another
// district. The admin reviews in Drive and loads good files via the admin tool.
// ---------------------------------------------------------------------------

const SUBMIT_MAX_BYTES = 32 * 1024 * 1024; // 32 MB
const submitDocBody = raw({ type: () => true, limit: SUBMIT_MAX_BYTES });

const SUBMIT_ALLOWED_EXT: Record<string, string[]> = {
  salary_schedule: ["pdf", "xlsx", "xls", "csv"],
  cba: ["pdf"],
};
const SUBMIT_EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
};

router.post("/dashboard/submit-document", requireAuth, (req: Request, res: Response) => {
  submitDocBody(req, res, (err?: unknown) => {
    if (err) {
      const status =
        (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
      if (status === 413) {
        res.status(413).json({ error: "File too large (max 32 MB)" });
      } else {
        res.status(400).json({ error: "Failed to read upload body" });
      }
      return;
    }
    handleSubmitDocument(req, res).catch((e) => {
      console.error("submit-document error:", e);
      res.status(500).json({ error: "Internal server error" });
    });
  });
});

async function handleSubmitDocument(req: Request, res: Response): Promise<void> {
  const kind = String(req.query.kind ?? "");
  if (kind !== "salary_schedule" && kind !== "cba") {
    res.status(400).json({ error: "kind must be salary_schedule or cba" });
    return;
  }

  const rawName = String(req.query.filename ?? "").trim();
  if (!rawName) {
    res.status(400).json({ error: "filename is required" });
    return;
  }
  // Keep the base name only; strip path separators and risky characters.
  const safeName = rawName
    .replace(/[\\/]/g, "_")
    .replace(/[^\w.\- ]/g, "_")
    .slice(0, 180);
  const ext = (safeName.includes(".") ? safeName.split(".").pop()! : "").toLowerCase();
  const allowed = SUBMIT_ALLOWED_EXT[kind];
  if (!allowed.includes(ext)) {
    res
      .status(400)
      .json({ error: `Unsupported file type for ${kind}. Allowed: ${allowed.join(", ")}` });
    return;
  }

  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: "Empty file" });
    return;
  }

  const districtId = req.session.userDistrictId ?? null;
  if (districtId == null) {
    res
      .status(400)
      .json({ error: "Your account isn't linked to a district. Contact your administrator." });
    return;
  }

  // District name for human-readable Drive folder labeling (best-effort).
  let districtName = `District ${districtId}`;
  try {
    const r = await db.execute(sql`SELECT name FROM districts WHERE id = ${districtId} LIMIT 1`);
    const n = (r.rows[0] as { name?: unknown } | undefined)?.name;
    if (typeof n === "string" && n.trim()) districtName = n.trim();
  } catch {
    /* keep fallback label */
  }

  const uploaderEmail = req.session.userEmail ?? "unknown";
  const dateStr = new Date().toISOString().slice(0, 10);
  const kindLabel = kind === "salary_schedule" ? "Salary Schedule" : "CBA";
  const driveFileName = `${kindLabel} — ${safeName} — ${uploaderEmail} — ${dateStr}`;
  const mimeType = SUBMIT_EXT_MIME[ext] ?? "application/octet-stream";

  try {
    const result = await uploadCustomerSubmission({
      districtId,
      districtName,
      fileName: driveFileName,
      mimeType,
      content: body,
    });
    res.json({ ok: true, fileId: result.fileId, name: result.name });
  } catch (e) {
    if (e instanceof DriveNotConnectedError) {
      res.status(503).json({
        error:
          "Document uploads aren't available yet — Google Drive isn't connected. Please contact your administrator.",
      });
      return;
    }
    console.error("Drive upload failed:", e);
    res.status(502).json({ error: "Upload to Google Drive failed. Please try again." });
  }
}

export default router;
