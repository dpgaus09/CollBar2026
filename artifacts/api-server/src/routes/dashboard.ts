import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

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

function canAccessDistrict(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const districtId = parseInt(String(req.params.id), 10);
  if (
    req.session.userRole === "district_user" &&
    // Normalize both sides — postgres bigint comes back as string from node-postgres
    Number(req.session.userDistrictId) !== districtId
  ) {
    res.status(403).json({ error: "Access denied: you can only view your own district" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enrollmentBand(enrollment: number | null): string {
  if (!enrollment || enrollment <= 0) return "unknown";
  if (enrollment < 500) return "tiny";
  if (enrollment < 1000) return "small";
  if (enrollment < 2500) return "medium";
  if (enrollment < 5000) return "large";
  return "xlarge";
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86_400_000);
}

function bandSql(band: string): SQL | null {
  const map: Record<string, SQL> = {
    tiny: sql`d.enrollment < 500`,
    small: sql`d.enrollment BETWEEN 500 AND 999`,
    medium: sql`d.enrollment BETWEEN 1000 AND 2499`,
    large: sql`d.enrollment BETWEEN 2500 AND 4999`,
    xlarge: sql`d.enrollment >= 5000`,
  };
  return map[band] ?? null;
}

function buildWhere(conditions: Array<SQL | null | undefined>): SQL {
  const parts = conditions.filter(Boolean) as SQL[];
  if (parts.length === 0) return sql`1=1`;
  return sql.join(parts, sql` AND `);
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts
// ---------------------------------------------------------------------------
router.get("/dashboard/districts", requireAuth, async (req: Request, res: Response) => {
  const stateFilter = req.query.state ? String(req.query.state).toUpperCase() : null;
  try {
    let rows;
    if (req.session.userRole === "admin") {
      if (stateFilter) {
        rows = await db.execute(sql`
          SELECT id, name, county, district_type, enrollment, state, updated_at
          FROM districts
          WHERE state = ${stateFilter}
          ORDER BY name
          LIMIT 1000
        `);
      } else {
        rows = await db.execute(sql`
          SELECT id, name, county, district_type, enrollment, state, updated_at
          FROM districts
          ORDER BY name
          LIMIT 1000
        `);
      }
    } else {
      const districtId = req.session.userDistrictId;
      rows = await db.execute(sql`
        SELECT id, name, county, district_type, enrollment, state, updated_at
        FROM districts
        WHERE id = ${districtId}
      `);
    }
    res.json({ districts: rows.rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id", canAccessDistrict, async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }

  try {
    const distRows = await db.execute(sql`
      SELECT id, name, county, district_type, enrollment, state, avg_teacher_salary, valuation, website_url, updated_at
      FROM districts
      WHERE id = ${districtId}
    `);
    if (!distRows.rows.length) { res.status(404).json({ error: "District not found" }); return; }

    const district = distRows.rows[0] as {
      id: number; name: string; county: string | null; district_type: string | null;
      enrollment: number | null; state: string; avg_teacher_salary: string | null; updated_at: string;
    };

    const contractRows = await db.execute(sql`
      SELECT c.id, c.union_name, c.affiliation, c.unit_scope,
             c.effective_start, c.effective_end, c.term_years,
             c.has_reopener, c.reopener_terms,
             c.source_doc_id, sd.source_url
      FROM contracts c
      LEFT JOIN source_documents sd ON c.source_doc_id = sd.id
      WHERE c.district_id = ${districtId}
      ORDER BY c.effective_start DESC NULLS LAST
      LIMIT 5
    `);

    const contracts = (contractRows.rows as {
      id: number; union_name: string | null; effective_start: string | null;
      effective_end: string | null; term_years: string | null;
      has_reopener: boolean | null; source_url: string | null;
      unit_scope: string | null; affiliation: string | null;
      source_doc_id: number | null; reopener_terms: string | null;
    }[]).map((c) => ({ ...c, daysUntilExpiration: daysUntil(c.effective_end) }));

    res.json({
      ...district,
      enrollmentBand: enrollmentBand(district.enrollment),
      currentContract: contracts[0] ?? null,
      recentContracts: contracts,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/provisions
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/provisions", canAccessDistrict, async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }

  const VALID = new Set(["compensation","insurance","retirement","leave","workday","evaluation","rif","grievance","other"]);
  const rawCat = req.query.category ? String(req.query.category) : "";
  if (rawCat && !VALID.has(rawCat)) { res.status(400).json({ error: "Invalid category" }); return; }

  try {
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
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/settlements
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/settlements", canAccessDistrict, async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }
  try {
    // Settlements have no direct source_doc link; derive provenance from the
    // most recent contract whose period overlaps the settlement's to_year.
    const rows = await db.execute(sql`
      SELECT s.id, s.from_year, s.to_year, s.base_increase_pct, s.year2_pct, s.year3_pct,
             s.off_schedule_payment, s.insurance_changed, s.term_years,
             s.method, s.confidence, s.human_verified, s.page_ref, s.notes,
             sd.source_url, sd.retrieved_at
      FROM settlements s
      LEFT JOIN LATERAL (
        SELECT c2.source_doc_id
        FROM contracts c2
        WHERE c2.district_id = s.district_id
        ORDER BY c2.effective_end DESC NULLS LAST
        LIMIT 1
      ) lc ON true
      LEFT JOIN source_documents sd ON lc.source_doc_id = sd.id
      WHERE s.district_id = ${districtId}
      ORDER BY s.from_year DESC
    `);
    res.json({ settlements: rows.rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/districts/:id/factfinding
// ---------------------------------------------------------------------------
router.get("/dashboard/districts/:id/factfinding", canAccessDistrict, async (req: Request, res: Response) => {
  const districtId = parseInt(String(req.params.id), 10);
  if (isNaN(districtId)) { res.status(400).json({ error: "Invalid district id" }); return; }
  try {
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
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/medians — dynamic WHERE via sql.join
// ---------------------------------------------------------------------------
router.get("/dashboard/medians", requireAuth, async (req: Request, res: Response) => {
  const county = req.query.county ? String(req.query.county) : null;
  const band = req.query.band ? String(req.query.band) : null;
  const yearFrom = req.query.yearFrom ? String(req.query.yearFrom) : null;
  const yearTo = req.query.yearTo ? String(req.query.yearTo) : null;
  const state = req.query.state ? String(req.query.state).toUpperCase() : null;

  const conds: Array<SQL | null> = [
    sql`s.base_increase_pct IS NOT NULL`,
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
        COUNT(*)::int AS n
      FROM settlements s
      JOIN districts d ON s.district_id = d.id
      WHERE ${where}
    `);
    res.json(rows.rows[0] ?? { median_base: null, avg_base: null, n: 0 });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/comparables
// ---------------------------------------------------------------------------
router.get("/dashboard/comparables", requireAuth, async (req: Request, res: Response) => {
  const county = req.query.county ? String(req.query.county) : null;
  const band = req.query.band ? String(req.query.band) : null;
  const districtType = req.query.districtType ? String(req.query.districtType) : null;
  const yearFrom = req.query.yearFrom ? String(req.query.yearFrom) : null;
  const yearTo = req.query.yearTo ? String(req.query.yearTo) : null;
  const state = req.query.state ? String(req.query.state).toUpperCase() : null;
  const format = req.query.format ? String(req.query.format) : "json";
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
          d.id AS district_id, d.name AS district_name,
          d.county, d.district_type, d.enrollment,
          sd.source_url, sd.retrieved_at
        FROM settlements s
        JOIN districts d ON s.district_id = d.id
        LEFT JOIN LATERAL (
          SELECT c2.source_doc_id
          FROM contracts c2
          WHERE c2.district_id = s.district_id
          ORDER BY c2.effective_end DESC NULLS LAST
          LIMIT 1
        ) lc ON true
        LEFT JOIN source_documents sd ON lc.source_doc_id = sd.id
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

    if (format === "csv") {
      const rows = dataRows.rows as Record<string, unknown>[];
      const headers = [
        "district_name", "county", "district_type", "enrollment",
        "from_year", "to_year", "base_increase_pct", "year2_pct", "year3_pct",
        "off_schedule_payment", "insurance_changed", "term_years", "method",
      ];
      const csv = [
        headers.join(","),
        ...rows.map((r) =>
          headers
            .map((h) => {
              const v = r[h];
              return v == null ? "" : String(v).includes(",") ? `"${String(v)}"` : String(v);
            })
            .join(","),
        ),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=collbar-comparables.csv");
      res.send(csv);
      return;
    }

    res.json({
      items: dataRows.rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      medians,
      peer_set_name: peerSetName,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/counties
// ---------------------------------------------------------------------------
router.get("/dashboard/counties", requireAuth, async (req: Request, res: Response) => {
  const stateFilter = req.query.state ? String(req.query.state).toUpperCase() : null;
  try {
    const rows = stateFilter
      ? await db.execute(sql`SELECT DISTINCT county FROM districts WHERE county IS NOT NULL AND state = ${stateFilter} ORDER BY county`)
      : await db.execute(sql`SELECT DISTINCT county FROM districts WHERE county IS NOT NULL ORDER BY county`);
    res.json({ counties: (rows.rows as { county: string }[]).map((r) => r.county) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/district-types
// ---------------------------------------------------------------------------
router.get("/dashboard/district-types", requireAuth, async (req: Request, res: Response) => {
  const stateFilter = req.query.state ? String(req.query.state).toUpperCase() : null;
  try {
    const rows = stateFilter
      ? await db.execute(sql`SELECT DISTINCT district_type FROM districts WHERE district_type IS NOT NULL AND state = ${stateFilter} ORDER BY district_type`)
      : await db.execute(sql`SELECT DISTINCT district_type FROM districts WHERE district_type IS NOT NULL ORDER BY district_type`);
    res.json({ districtTypes: (rows.rows as { district_type: string }[]).map((r) => r.district_type) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/provision-medians
// Returns per-provision-key medians for a given category, filtered by
// county and/or enrollment band. Used to show "vs. county median" context
// in Insurance, Retirement, and Leave cards.
// ---------------------------------------------------------------------------
router.get("/dashboard/provision-medians", requireAuth, async (req: Request, res: Response) => {
  const category = req.query.category ? String(req.query.category) : null;
  const county = req.query.county ? String(req.query.county) : null;
  const band = req.query.band ? String(req.query.band) : null;
  const state = req.query.state ? String(req.query.state).toUpperCase() : null;

  if (!category) {
    res.status(400).json({ error: "category query parameter is required" });
    return;
  }

  const conds: Array<SQL | null> = [
    sql`cp.category = ${category}`,
    sql`cp.value_numeric IS NOT NULL`,
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
    res.status(500).json({ error: String(err) });
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
    res.status(500).json({ error: String(err) });
  }
});

export default router;
