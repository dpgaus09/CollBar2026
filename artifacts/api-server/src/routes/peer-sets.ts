import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { BoardPacketPDF } from "./pdf-template.js";
import type { BoardPacketProps, SettlementRow, PeerMedians } from "./pdf-template.js";

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

// ---------------------------------------------------------------------------
// Band helper (mirrors dashboard.ts)
// ---------------------------------------------------------------------------

function bandWhere(band: string, alias = "d"): string | null {
  const map: Record<string, string> = {
    tiny: `${alias}.enrollment < 500`,
    small: `${alias}.enrollment BETWEEN 500 AND 999`,
    medium: `${alias}.enrollment BETWEEN 1000 AND 2499`,
    large: `${alias}.enrollment BETWEEN 2500 AND 4999`,
    xlarge: `${alias}.enrollment >= 5000`,
  };
  return map[band] ?? null;
}

// Build WHERE fragment for district filters (no alias prefix issues)
function buildDistrictFilters(
  filters: Record<string, unknown>,
  alias = "d",
): string {
  const parts: string[] = [];
  if (filters.county && typeof filters.county === "string") {
    parts.push(`${alias}.county = '${filters.county.replace(/'/g, "''")}'`);
  }
  if (filters.district_type && typeof filters.district_type === "string") {
    parts.push(
      `${alias}.district_type = '${filters.district_type.replace(/'/g, "''")}'`,
    );
  }
  if (filters.band && typeof filters.band === "string") {
    const b = bandWhere(filters.band, alias);
    if (b) parts.push(b);
  }
  if (filters.valuation_min != null) {
    parts.push(`${alias}.valuation >= ${Number(filters.valuation_min)}`);
  }
  if (filters.valuation_max != null) {
    parts.push(`${alias}.valuation <= ${Number(filters.valuation_max)}`);
  }
  return parts.length > 0 ? parts.join(" AND ") : "";
}

// ---------------------------------------------------------------------------
// Helper — load + own-check for a peer set
// ---------------------------------------------------------------------------

interface PeerSetRow {
  id: number;
  user_id: number;
  name: string;
  district_ids: number[];
  filters_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

async function ownedPeerSet(
  id: number,
  userId: number,
): Promise<PeerSetRow | null> {
  const r = await db.execute(
    sql`SELECT id, user_id, name, district_ids, filters_json, created_at, updated_at
        FROM peer_sets WHERE id = ${id} AND user_id = ${userId}`,
  );
  return (r.rows[0] as unknown as PeerSetRow) ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/peer-sets/preview?county=&band=&districtType=
// (must be before /:id so Express routes it correctly)
// ---------------------------------------------------------------------------

router.get(
  "/peer-sets/preview",
  requireAuth,
  async (req: Request, res: Response) => {
    const county = req.query.county ? String(req.query.county) : null;
    const band = req.query.band ? String(req.query.band) : null;
    const districtType = req.query.districtType
      ? String(req.query.districtType)
      : null;

    const parts: string[] = [];
    if (county) parts.push(`county = '${county.replace(/'/g, "''")}'`);
    if (districtType)
      parts.push(`district_type = '${districtType.replace(/'/g, "''")}'`);
    if (band) {
      const b = bandWhere(band, "");
      // bandWhere uses alias prefix; strip alias since no alias here
      const stripped = b
        ? b.replace(/\bd\./g, "")
        : null;
      if (stripped) parts.push(stripped);
    }

    if (parts.length === 0) {
      res.json({ districts: [], total: 0 });
      return;
    }

    try {
      const rows = await db.execute(
        sql.raw(
          `SELECT id, name, county, district_type, enrollment
           FROM districts
           WHERE ${parts.join(" AND ")}
           ORDER BY name
           LIMIT 200`,
        ),
      );
      res.json({ districts: rows.rows, total: rows.rows.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/peer-sets/districts/search?q=X
// ---------------------------------------------------------------------------

router.get(
  "/peer-sets/districts/search",
  requireAuth,
  async (req: Request, res: Response) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) {
      res.json({ districts: [] });
      return;
    }
    try {
      const rows = await db.execute(sql`
        SELECT id, name, county, district_type, enrollment
        FROM districts
        WHERE name ILIKE ${"%" + q + "%"} OR county ILIKE ${"%" + q + "%"}
        ORDER BY name
        LIMIT 20
      `);
      res.json({ districts: rows.rows });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/peer-sets
// ---------------------------------------------------------------------------

router.get("/peer-sets", requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  try {
    const rows = await db.execute(sql`
      SELECT id, name, district_ids, filters_json, created_at, updated_at,
             COALESCE(array_length(district_ids, 1), 0) AS district_count
      FROM peer_sets
      WHERE user_id = ${userId}
      ORDER BY updated_at DESC
    `);
    res.json({ peerSets: rows.rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/peer-sets
// ---------------------------------------------------------------------------

router.post("/peer-sets", requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { name, district_ids = [], filters_json = {} } = req.body as {
    name?: string;
    district_ids?: number[];
    filters_json?: Record<string, unknown>;
  };

  if (!name || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const ids = district_ids.map(Number).filter((n) => !isNaN(n));

  try {
    const rows = await db.execute(sql`
      INSERT INTO peer_sets (user_id, name, district_ids, filters_json)
      VALUES (
        ${userId},
        ${name.trim()},
        ${ids.length > 0 ? ids.join(",") : ""}::bigint[],
        ${JSON.stringify(filters_json)}::jsonb
      )
      RETURNING id, name, district_ids, filters_json, created_at, updated_at
    `);
    res.status(201).json({ peerSet: rows.rows[0] });
  } catch (err) {
    // Try with ARRAY[] literal
    try {
      const arrLit = ids.length > 0 ? `{${ids.join(",")}}` : "{}";
      const rows = await db.execute(sql`
        INSERT INTO peer_sets (user_id, name, district_ids, filters_json)
        VALUES (
          ${userId},
          ${name.trim()},
          ${arrLit}::bigint[],
          ${JSON.stringify(filters_json)}::jsonb
        )
        RETURNING id, name, district_ids, filters_json, created_at, updated_at
      `);
      res.status(201).json({ peerSet: rows.rows[0] });
    } catch (err2) {
      res.status(500).json({ error: String(err2) });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /api/peer-sets/:id
// ---------------------------------------------------------------------------

router.get(
  "/peer-sets/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.session.userId!;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const ps = await ownedPeerSet(id, userId);
    if (!ps) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ peerSet: ps });
  },
);

// ---------------------------------------------------------------------------
// PUT /api/peer-sets/:id
// ---------------------------------------------------------------------------

router.put(
  "/peer-sets/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.session.userId!;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const ps = await ownedPeerSet(id, userId);
    if (!ps) { res.status(404).json({ error: "Not found" }); return; }

    const { name, district_ids, filters_json } = req.body as {
      name?: string;
      district_ids?: number[];
      filters_json?: Record<string, unknown>;
    };

    const ids = (district_ids ?? ps.district_ids).map(Number).filter((n) => !isNaN(n));
    const newName = name?.trim() ?? ps.name;
    const newFilters = filters_json ?? ps.filters_json;
    const arrLit = ids.length > 0 ? `{${ids.join(",")}}` : "{}";

    try {
      const rows = await db.execute(sql`
        UPDATE peer_sets
        SET name         = ${newName},
            district_ids = ${arrLit}::bigint[],
            filters_json = ${JSON.stringify(newFilters)}::jsonb,
            updated_at   = NOW()
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING id, name, district_ids, filters_json, created_at, updated_at
      `);
      res.json({ peerSet: rows.rows[0] });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/peer-sets/:id
// ---------------------------------------------------------------------------

router.delete(
  "/peer-sets/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.session.userId!;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    try {
      await db.execute(
        sql`DELETE FROM peer_sets WHERE id = ${id} AND user_id = ${userId}`,
      );
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/peer-sets/:id/export/pdf?district_id=X
// ---------------------------------------------------------------------------

router.get(
  "/peer-sets/:id/export/pdf",
  requireAuth,
  async (req: Request, res: Response) => {
    const userId = req.session.userId!;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const ps = await ownedPeerSet(id, userId);
    if (!ps) { res.status(404).json({ error: "Not found" }); return; }

    const districtId = req.query.district_id
      ? parseInt(String(req.query.district_id), 10)
      : null;

    try {
      const memberIds = (ps.district_ids ?? []).map(Number).filter(Boolean);

      // Also resolve any filter-based districts
      const filters = ps.filters_json ?? {};
      const filterSql = buildDistrictFilters(filters, "");
      if (filterSql) {
        const fr = await db.execute(
          sql.raw(
            `SELECT id FROM districts WHERE ${filterSql} ORDER BY id LIMIT 300`,
          ),
        );
        for (const r of fr.rows as { id: number }[]) {
          if (!memberIds.includes(Number(r.id))) memberIds.push(Number(r.id));
        }
      }

      if (memberIds.length === 0) {
        res.status(400).json({ error: "Peer set is empty" });
        return;
      }

      // Include focal district in the query even if not in peer set
      const allIds = [...memberIds];
      if (districtId && !allIds.includes(districtId)) {
        allIds.push(districtId);
      }

      const idList = allIds.join(",");

      const settlementRows = await db.execute(sql.raw(`
        SELECT
          s.id, s.from_year, s.to_year,
          s.base_increase_pct, s.year2_pct, s.year3_pct,
          s.off_schedule_payment, s.insurance_changed, s.term_years,
          s.confidence, s.human_verified, s.page_ref,
          d.id AS district_id, d.name AS district_name, d.county,
          sd.source_url
        FROM settlements s
        JOIN districts d ON s.district_id = d.id
        LEFT JOIN LATERAL (
          SELECT c2.source_doc_id FROM contracts c2
          WHERE c2.district_id = s.district_id
          ORDER BY c2.effective_end DESC NULLS LAST LIMIT 1
        ) lc ON true
        LEFT JOIN source_documents sd ON lc.source_doc_id = sd.id
        WHERE s.district_id IN (${idList})
          AND s.base_increase_pct IS NOT NULL
        ORDER BY s.from_year DESC, d.name
      `));

      const allSettlements = settlementRows.rows as unknown as SettlementRow[];

      // Focal district name
      let districtName = "District";
      if (districtId) {
        const dr = await db.execute(
          sql`SELECT name FROM districts WHERE id = ${districtId} LIMIT 1`,
        );
        if (dr.rows.length > 0) districtName = (dr.rows[0] as { name: string }).name;
      }

      const focalSettlements = districtId
        ? allSettlements.filter((s) => Number(s.district_id) === districtId)
        : [];
      const peerSettlements = allSettlements.filter((s) =>
        memberIds.includes(Number(s.district_id)),
      );

      const medians = computeMedians(peerSettlements);
      const chartData = buildChartData(focalSettlements, peerSettlements);

      const props: BoardPacketProps = {
        districtName,
        peerSetName: ps.name,
        generatedAt: new Date().toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        focalSettlements,
        allSettlements,
        medians,
        chartData,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const element = React.createElement(BoardPacketPDF, props) as any;
      const buffer = await renderToBuffer(element);

      const safeName = districtName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="collbar-${safeName}-board-packet.pdf"`,
      );
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function median(vals: number[]): number | null {
  const sorted = vals.filter((v) => isFinite(v) && !isNaN(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function computeMedians(rows: SettlementRow[]): PeerMedians {
  const pct = (v: string | number | null | undefined) => {
    if (v == null || v === "") return null;
    const n = parseFloat(String(v));
    return isNaN(n) ? null : n;
  };
  return {
    median_base: median(rows.map((s) => pct(s.base_increase_pct)).filter((v): v is number => v != null)),
    median_yr2: median(rows.map((s) => pct(s.year2_pct)).filter((v): v is number => v != null)),
    median_yr3: median(rows.map((s) => pct(s.year3_pct)).filter((v): v is number => v != null)),
    median_lump: median(rows.map((s) => pct(s.off_schedule_payment)).filter((v): v is number => v != null)),
    median_term: median(rows.map((s) => pct(s.term_years)).filter((v): v is number => v != null)),
    n: new Set(rows.map((s) => s.district_id)).size,
  };
}

function buildChartData(
  focal: SettlementRow[],
  peers: SettlementRow[],
): Array<{ year: string; districtPct: number | null; medianPct: number | null }> {
  const years = Array.from(
    new Set([...focal.map((s) => s.from_year), ...peers.map((s) => s.from_year)]),
  ).sort();

  return years.map((year) => {
    const f = focal.find((s) => s.from_year === year);
    const yPeers = peers.filter((s) => s.from_year === year);
    const pct = (v: string | number | null | undefined) => {
      if (v == null) return null;
      const n = parseFloat(String(v));
      return isNaN(n) ? null : n;
    };
    return {
      year,
      districtPct: f ? pct(f.base_increase_pct) : null,
      medianPct: median(yPeers.map((s) => pct(s.base_increase_pct)).filter((v): v is number => v != null)),
    };
  });
}

export default router;
