import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// In-memory rate limiter (60 req/min per IP for public endpoints)
// ---------------------------------------------------------------------------

const _rateLimits = new Map<string, { count: number; reset: number }>();
function rateLimited(req: Request, max = 60, windowMs = 60_000): boolean {
  const ip = String(req.ip ?? req.socket?.remoteAddress ?? "anon");
  const now = Date.now();
  const entry = _rateLimits.get(ip);
  if (!entry || entry.reset < now) {
    _rateLimits.set(ip, { count: 1, reset: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > max;
}
function publicRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (rateLimited(req)) {
    res.status(429).json({ error: "Too many requests — try again in a minute." });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// In-memory tracker stats cache (1 hour TTL; refreshed daily via setInterval)
// ---------------------------------------------------------------------------

interface TrackerStats {
  total_settlements: number;
  districts_covered: number;
  median_base: number | null;
  avg_base: number | null;
  year_min: string | null;
  year_max: string | null;
  band_medians: Array<{ band: string; label: string; median_base: number | null; n: number }>;
  newest: Array<{
    district_name: string;
    county: string | null;
    state: string | null;
    from_year: string | null;
    base_increase_pct: string | null;
    term_years: string | null;
    human_verified: boolean;
    verified_by: string | null;
    source_url: string | null;
    district_slug: string | null;
  }>;
  computed_at: string;
}

const _statsCacheMap = new Map<string, { data: TrackerStats; expires: number }>();
const STATS_TTL_MS = 60 * 60 * 1000; // 1 hour

const BAND_LABELS: Record<string, string> = {
  tiny: "< 500 students",
  small: "500 – 999",
  medium: "1,000 – 2,499",
  large: "2,500 – 4,999",
  xlarge: "5,000+",
};
const BAND_ORDER = ["tiny", "small", "medium", "large", "xlarge"];

async function computeTrackerStats(state?: string): Promise<TrackerStats> {
  const sc = state ? sql`AND d.state = ${state}` : sql.empty();
  const [globalRows, bandRows, newestRows] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)::int                                                 AS total_settlements,
        COUNT(DISTINCT s.district_id)::int                           AS districts_covered,
        ROUND(CAST(PERCENTILE_CONT(0.5) WITHIN GROUP
          (ORDER BY s.base_increase_pct::float) AS numeric), 2)      AS median_base,
        ROUND(CAST(AVG(s.base_increase_pct::float) AS numeric), 2)   AS avg_base,
        MIN(s.from_year)                                             AS year_min,
        MAX(s.from_year)                                             AS year_max
      FROM settlements s
      JOIN districts d ON s.district_id = d.id
      WHERE s.base_increase_pct IS NOT NULL ${sc}
    `),
    db.execute(sql`
      SELECT
        CASE
          WHEN d.enrollment < 500  THEN 'tiny'
          WHEN d.enrollment < 1000 THEN 'small'
          WHEN d.enrollment < 2500 THEN 'medium'
          WHEN d.enrollment < 5000 THEN 'large'
          ELSE 'xlarge'
        END                                                           AS band,
        ROUND(CAST(PERCENTILE_CONT(0.5) WITHIN GROUP
          (ORDER BY s.base_increase_pct::float) AS numeric), 2)      AS median_base,
        COUNT(*)::int                                                 AS n
      FROM settlements s
      JOIN districts d ON s.district_id = d.id
      WHERE s.base_increase_pct IS NOT NULL
        AND d.enrollment IS NOT NULL ${sc}
      GROUP BY band
      ORDER BY MIN(d.enrollment)
    `),
    db.execute(sql`
      SELECT
        d.name   AS district_name,
        d.county,
        d.state,
        d.slug   AS district_slug,
        s.from_year,
        s.base_increase_pct,
        s.term_years,
        s.human_verified,
        s.verified_by,
        sd.source_url
      FROM settlements s
      JOIN districts d ON s.district_id = d.id
      LEFT JOIN LATERAL (
        SELECT c2.source_doc_id FROM contracts c2
        WHERE c2.district_id = s.district_id
        ORDER BY c2.effective_end DESC NULLS LAST LIMIT 1
      ) lc ON true
      LEFT JOIN source_documents sd ON lc.source_doc_id = sd.id
      WHERE s.base_increase_pct IS NOT NULL ${sc}
      ORDER BY s.id DESC
      LIMIT 30
    `),
  ]);

  const g = (globalRows.rows[0] ?? {}) as Record<string, unknown>;
  const bandMap = new Map<string, { median_base: number | null; n: number }>();
  for (const r of bandRows.rows as Array<Record<string, unknown>>) {
    bandMap.set(String(r.band), {
      median_base: r.median_base != null ? Number(r.median_base) : null,
      n: Number(r.n ?? 0),
    });
  }

  return {
    total_settlements: Number(g.total_settlements ?? 0),
    districts_covered: Number(g.districts_covered ?? 0),
    median_base: g.median_base != null ? Number(g.median_base) : null,
    avg_base: g.avg_base != null ? Number(g.avg_base) : null,
    year_min: g.year_min ? String(g.year_min) : null,
    year_max: g.year_max ? String(g.year_max) : null,
    band_medians: BAND_ORDER.map((b) => ({
      band: b,
      label: BAND_LABELS[b] ?? b,
      ...(bandMap.get(b) ?? { median_base: null, n: 0 }),
    })),
    newest: (newestRows.rows as Array<Record<string, unknown>>).map((r) => ({
      district_name: String(r.district_name ?? ""),
      county: r.county ? String(r.county) : null,
      state: r.state ? String(r.state) : null,
      from_year: r.from_year ? String(r.from_year) : null,
      base_increase_pct: r.base_increase_pct != null ? String(r.base_increase_pct) : null,
      term_years: r.term_years != null ? String(r.term_years) : null,
      human_verified: Boolean(r.human_verified),
      verified_by: r.verified_by ? String(r.verified_by) : null,
      source_url: r.source_url ? String(r.source_url) : null,
      district_slug: r.district_slug ? String(r.district_slug) : null,
    })),
    computed_at: new Date().toISOString(),
  };
}

async function getTrackerStats(state?: string): Promise<TrackerStats> {
  const key = state ?? "__all__";
  const cached = _statsCacheMap.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }
  const data = await computeTrackerStats(state);
  _statsCacheMap.set(key, { data, expires: Date.now() + STATS_TTL_MS });
  return data;
}

// Refresh daily
setInterval(
  () => {
    for (const st of [undefined, "OH", "IL"]) {
      const key = st ?? "__all__";
      computeTrackerStats(st)
        .then((data) => { _statsCacheMap.set(key, { data, expires: Date.now() + STATS_TTL_MS }); })
        .catch((err) => logger.warn({ err, state: st }, "tracker stats refresh failed"));
    }
  },
  24 * 60 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// GET /api/public/tracker-stats
// ---------------------------------------------------------------------------

router.get(
  "/public/tracker-stats",
  publicRateLimit,
  async (req: Request, res: Response) => {
    try {
      const stateParam = req.query.state ? String(req.query.state).toUpperCase() : undefined;
      const stats = await getTrackerStats(stateParam);
      res
        .setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600")
        .json(stats);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/public/district/:slug
// ---------------------------------------------------------------------------

router.get(
  "/public/district/:slug",
  publicRateLimit,
  async (req: Request, res: Response) => {
    const slug = String(req.params.slug ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!slug) { res.status(400).json({ error: "slug required" }); return; }

    try {
      const districtRows = await db.execute(
        sql`SELECT id, name, county, district_type, enrollment, slug, state
            FROM districts WHERE slug = ${slug} LIMIT 1`,
      );
      if (districtRows.rows.length === 0) {
        res.status(404).json({ error: "District not found" });
        return;
      }
      const d = districtRows.rows[0] as {
        id: bigint; name: string; county: string | null;
        district_type: string | null; enrollment: number | null; slug: string; state: string;
      };
      const districtId = Number(d.id);

      const [settleRows, contractRows, compRows] = await Promise.all([
        db.execute(sql`
          SELECT from_year, to_year, base_increase_pct, year2_pct, year3_pct,
                 term_years, human_verified
          FROM settlements
          WHERE district_id = ${districtId} AND base_increase_pct IS NOT NULL
          ORDER BY from_year DESC NULLS LAST, id DESC LIMIT 1
        `),
        db.execute(sql`
          SELECT effective_start, effective_end, term_years, union_name
          FROM contracts WHERE district_id = ${districtId}
          ORDER BY effective_end DESC NULLS LAST LIMIT 1
        `),
        db.execute(sql`
          SELECT d2.name, d2.county, d2.slug,
            (SELECT base_increase_pct FROM settlements
             WHERE district_id = d2.id AND base_increase_pct IS NOT NULL
             ORDER BY from_year DESC LIMIT 1)  AS base_pct,
            (SELECT term_years FROM settlements
             WHERE district_id = d2.id AND base_increase_pct IS NOT NULL
             ORDER BY from_year DESC LIMIT 1)  AS term_years
          FROM districts d2
          WHERE d2.county = ${d.county ?? ""}
            AND d2.id != ${districtId}
            AND d2.state = ${d.state ?? "OH"}
          ORDER BY RANDOM()
          LIMIT 3
        `),
      ]);

      res
        .setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600")
        .json({
          district: d,
          latestSettlement: settleRows.rows[0] ?? null,
          currentContract: contractRows.rows[0] ?? null,
          comparables: compRows.rows,
        });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/public/districts  (for sitemap generation)
// ---------------------------------------------------------------------------

router.get(
  "/public/districts",
  publicRateLimit,
  async (_req: Request, res: Response) => {
    try {
      const rows = await db.execute(sql`
        SELECT id, slug, name, county, updated_at
        FROM districts WHERE slug IS NOT NULL ORDER BY name
      `);
      res
        .setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400")
        .json({ districts: rows.rows, total: rows.rows.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export { getTrackerStats };
export default router;
