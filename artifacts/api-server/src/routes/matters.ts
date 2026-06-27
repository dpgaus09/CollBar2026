import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireFirmSession } from "../lib/firm-access.js";
import { coerceIds } from "../lib/coerce.js";

// ============================================================================
// Phase 2 — Client roster & matters (firm workspace selection sets).
//
// Every route is firm-scoped: access requires firm membership
// (requireFirmSession → req.firmAccess) and every read/write is constrained to
// req.firmAccess.firmId. This is the firm entitlement system; it shares NO code
// with the per-district CFO gate() / users.plan. Firm members are plan 'free'
// users, so we MUST NOT reuse the paid-gated peer-set district search here —
// this file ships its own firm-guarded search.
// ============================================================================

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface MatterRow {
  id: number;
  firm_id: number;
  name: string;
  status: string;
  primary_district_id: number | null;
}

// Load a matter ONLY if it belongs to the caller's firm. Returns null otherwise
// (used to produce a 404 for cross-firm ids — no existence leak).
async function firmOwnsMatter(
  matterId: number,
  firmId: number,
): Promise<MatterRow | null> {
  const r = await db.execute(sql`
    SELECT id, firm_id, name, status, primary_district_id
    FROM matters WHERE id = ${matterId} AND firm_id = ${firmId}
  `);
  const row = r.rows[0] as
    | {
        id: unknown;
        firm_id: unknown;
        name: unknown;
        status: unknown;
        primary_district_id: unknown;
      }
    | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    firm_id: Number(row.firm_id),
    name: String(row.name),
    status: String(row.status),
    primary_district_id:
      row.primary_district_id == null ? null : Number(row.primary_district_id),
  };
}

interface MatterDistrictDTO {
  districtId: number;
  role: "client" | "peer";
  name: string;
  county: string | null;
  districtType: string | null;
  enrollment: number | null;
  state: string;
}

interface MatterDTO {
  id: number;
  name: string;
  status: string;
  primaryDistrictId: number | null;
  primaryDistrictName: string | null;
  createdAt: string;
  districts: MatterDistrictDTO[];
}

// Load the full firm-scoped matter (with its client + peer districts) for
// detail responses. Returns null when the matter is not in the firm.
async function loadMatter(
  matterId: number,
  firmId: number,
): Promise<MatterDTO | null> {
  const mr = await db.execute(sql`
    SELECT m.id, m.name, m.status, m.primary_district_id, m.created_at,
           pd.name AS primary_district_name
    FROM matters m
    LEFT JOIN districts pd ON pd.id = m.primary_district_id
    WHERE m.id = ${matterId} AND m.firm_id = ${firmId}
  `);
  const m = mr.rows[0] as
    | {
        id: unknown;
        name: unknown;
        status: unknown;
        primary_district_id: unknown;
        created_at: unknown;
        primary_district_name: unknown;
      }
    | undefined;
  if (!m) return null;

  const dr = await db.execute(sql`
    SELECT md.district_id, md.role,
           d.name, d.county, d.district_type, d.enrollment, d.state
    FROM matter_districts md
    JOIN districts d ON d.id = md.district_id
    WHERE md.matter_id = ${matterId}
    ORDER BY (md.role = 'client') DESC, d.name
  `);
  const districts: MatterDistrictDTO[] = (
    dr.rows as Array<{
      district_id: unknown;
      role: unknown;
      name: unknown;
      county: unknown;
      district_type: unknown;
      enrollment: unknown;
      state: unknown;
    }>
  ).map((row) => ({
    districtId: Number(row.district_id),
    role: row.role === "client" ? "client" : "peer",
    name: String(row.name),
    county: row.county == null ? null : String(row.county),
    districtType: row.district_type == null ? null : String(row.district_type),
    enrollment: row.enrollment == null ? null : Number(row.enrollment),
    state: String(row.state ?? ""),
  }));

  return {
    id: Number(m.id),
    name: String(m.name),
    status: String(m.status),
    primaryDistrictId:
      m.primary_district_id == null ? null : Number(m.primary_district_id),
    primaryDistrictName:
      m.primary_district_name == null ? null : String(m.primary_district_name),
    createdAt: String(m.created_at),
    districts,
  };
}

// Confirm a set of district ids all exist. Returns the ids that are missing.
async function missingDistricts(ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const frag = sql.join(
    ids.map((n) => sql`${n}`),
    sql`, `,
  );
  const r = await db.execute(
    sql`SELECT id FROM districts WHERE id IN (${frag})`,
  );
  const found = new Set(
    (r.rows as Array<{ id: unknown }>).map((row) => Number(row.id)),
  );
  return ids.filter((id) => !found.has(id));
}

// Read + validate the session's active matter against the active firm. Clears a
// stale selection (matter deleted, or no longer in this firm — e.g. the user
// switched firms) so later phases never act on a foreign matter.
async function resolveActiveMatterId(
  req: Request,
  firmId: number,
): Promise<number | null> {
  const raw = req.session.activeMatterId;
  if (raw == null) return null;
  const owned = await firmOwnsMatter(Number(raw), firmId);
  if (!owned) {
    req.session.activeMatterId = null;
    return null;
  }
  return owned.id;
}

// ---------------------------------------------------------------------------
// GET /api/firm/districts/search?q=&state=
// Firm-guarded district search (mirrors the peer-set search query, but gated by
// firm membership, never the paid plan).
// ---------------------------------------------------------------------------
router.get(
  "/firm/districts/search",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const q = String(req.query.q ?? "").trim();
    const state = req.query.state
      ? String(req.query.state).toUpperCase()
      : null;
    if (q.length < 2) {
      res.json({ districts: [] });
      return;
    }
    try {
      const like = `%${q}%`;
      const rows = state
        ? await db.execute(sql`
            SELECT id, name, county, district_type, enrollment, state
            FROM districts
            WHERE (name ILIKE ${like} OR county ILIKE ${like}) AND state = ${state}
            ORDER BY name
            LIMIT 20
          `)
        : await db.execute(sql`
            SELECT id, name, county, district_type, enrollment, state
            FROM districts
            WHERE name ILIKE ${like} OR county ILIKE ${like}
            ORDER BY name
            LIMIT 20
          `);
      res.json({ districts: coerceIds(rows.rows) });
    } catch (err) {
      console.error("firm district search error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// Roster — GET / POST / DELETE /api/firm/roster
// ---------------------------------------------------------------------------

router.get(
  "/firm/roster",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    try {
      const r = await db.execute(sql`
        SELECT td.district_id, td.label, td.created_at,
               d.name, d.county, d.district_type, d.enrollment, d.state
        FROM tracked_districts td
        JOIN districts d ON d.id = td.district_id
        WHERE td.firm_id = ${firm.firmId}
        ORDER BY d.name
      `);
      const roster = (
        r.rows as Array<{
          district_id: unknown;
          label: unknown;
          created_at: unknown;
          name: unknown;
          county: unknown;
          district_type: unknown;
          enrollment: unknown;
          state: unknown;
        }>
      ).map((row) => ({
        districtId: Number(row.district_id),
        label: row.label == null ? null : String(row.label),
        createdAt: String(row.created_at),
        name: String(row.name),
        county: row.county == null ? null : String(row.county),
        districtType:
          row.district_type == null ? null : String(row.district_type),
        enrollment: row.enrollment == null ? null : Number(row.enrollment),
        state: String(row.state ?? ""),
      }));
      res.json({ roster });
    } catch (err) {
      console.error("firm roster list error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.post(
  "/firm/roster",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const { districtId, label } = req.body as {
      districtId?: unknown;
      label?: unknown;
    };
    const did = toInt(districtId);
    if (did == null) {
      res.status(400).json({ error: "A valid districtId is required." });
      return;
    }
    const labelVal =
      typeof label === "string" && label.trim().length > 0
        ? label.trim()
        : null;
    try {
      if ((await missingDistricts([did])).length > 0) {
        res.status(404).json({ error: "District not found." });
        return;
      }
      await db.execute(sql`
        INSERT INTO tracked_districts (firm_id, district_id, label, created_by)
        VALUES (${firm.firmId}, ${did}, ${labelVal}, ${firm.userId})
        ON CONFLICT (firm_id, district_id)
        DO UPDATE SET label = COALESCE(EXCLUDED.label, tracked_districts.label)
      `);
      res.status(201).json({ ok: true, districtId: did });
    } catch (err) {
      console.error("firm roster add error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.delete(
  "/firm/roster/:districtId",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const did = toInt(req.params.districtId);
    if (did == null) {
      res.status(400).json({ error: "Invalid district id" });
      return;
    }
    try {
      await db.execute(sql`
        DELETE FROM tracked_districts
        WHERE firm_id = ${firm.firmId} AND district_id = ${did}
      `);
      res.status(204).end();
    } catch (err) {
      console.error("firm roster delete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// Matters — list / create
// ---------------------------------------------------------------------------

router.get(
  "/firm/matters",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    try {
      const r = await db.execute(sql`
        SELECT m.id, m.name, m.status, m.primary_district_id, m.created_at,
               pd.name AS primary_district_name,
               (SELECT COUNT(*) FROM matter_districts md
                  WHERE md.matter_id = m.id AND md.role = 'peer') AS peer_count
        FROM matters m
        LEFT JOIN districts pd ON pd.id = m.primary_district_id
        WHERE m.firm_id = ${firm.firmId}
        ORDER BY m.created_at DESC, m.id DESC
      `);
      const matters = (
        r.rows as Array<{
          id: unknown;
          name: unknown;
          status: unknown;
          primary_district_id: unknown;
          created_at: unknown;
          primary_district_name: unknown;
          peer_count: unknown;
        }>
      ).map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        status: String(row.status),
        primaryDistrictId:
          row.primary_district_id == null
            ? null
            : Number(row.primary_district_id),
        primaryDistrictName:
          row.primary_district_name == null
            ? null
            : String(row.primary_district_name),
        peerCount: Number(row.peer_count ?? 0),
        createdAt: String(row.created_at),
      }));
      res.json({ matters });
    } catch (err) {
      console.error("firm matters list error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.post(
  "/firm/matters",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const { name, primaryDistrictId, peerDistrictIds } = req.body as {
      name?: unknown;
      primaryDistrictId?: unknown;
      peerDistrictIds?: unknown;
    };
    const nm = typeof name === "string" ? name.trim() : "";
    if (!nm) {
      res.status(400).json({ error: "A matter name is required." });
      return;
    }
    const clientId = toInt(primaryDistrictId);
    if (clientId == null) {
      res
        .status(400)
        .json({ error: "A valid client (primary) district is required." });
      return;
    }
    const peers = Array.isArray(peerDistrictIds)
      ? [...new Set(peerDistrictIds.map(toInt).filter((n): n is number => n != null))].filter(
          (id) => id !== clientId,
        )
      : [];

    try {
      const missing = await missingDistricts([clientId, ...peers]);
      if (missing.length > 0) {
        res
          .status(404)
          .json({ error: `Unknown district id(s): ${missing.join(", ")}` });
        return;
      }

      const matterId = await db.transaction(async (tx) => {
        const ins = await tx.execute(sql`
          INSERT INTO matters (firm_id, name, primary_district_id, status, created_by)
          VALUES (${firm.firmId}, ${nm}, ${clientId}, 'active', ${firm.userId})
          RETURNING id
        `);
        const mid = Number((ins.rows[0] as { id: unknown }).id);

        await tx.execute(sql`
          INSERT INTO matter_districts (matter_id, district_id, role)
          VALUES (${mid}, ${clientId}, 'client')
        `);
        for (const pid of peers) {
          await tx.execute(sql`
            INSERT INTO matter_districts (matter_id, district_id, role)
            VALUES (${mid}, ${pid}, 'peer')
            ON CONFLICT (matter_id, district_id) DO NOTHING
          `);
        }

        // Keep the roster coherent: every district referenced by a matter is
        // also tracked by the firm, so the switcher/roster stay in sync.
        for (const did of [clientId, ...peers]) {
          await tx.execute(sql`
            INSERT INTO tracked_districts (firm_id, district_id, created_by)
            VALUES (${firm.firmId}, ${did}, ${firm.userId})
            ON CONFLICT (firm_id, district_id) DO NOTHING
          `);
        }
        return mid;
      });

      const matter = await loadMatter(matterId, firm.firmId);
      res.status(201).json({ matter });
    } catch (err) {
      console.error("firm matter create error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// Matters — get / update / delete by id
// ---------------------------------------------------------------------------

router.get(
  "/firm/matters/:id",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const id = toInt(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "Invalid matter id" });
      return;
    }
    try {
      const matter = await loadMatter(id, firm.firmId);
      if (!matter) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ matter });
    } catch (err) {
      console.error("firm matter get error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.put(
  "/firm/matters/:id",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const id = toInt(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "Invalid matter id" });
      return;
    }
    const { name, status, primaryDistrictId } = req.body as {
      name?: unknown;
      status?: unknown;
      primaryDistrictId?: unknown;
    };

    try {
      const existing = await firmOwnsMatter(id, firm.firmId);
      if (!existing) {
        res.status(404).json({ error: "Not found" });
        return;
      }

      const newName =
        typeof name === "string" && name.trim().length > 0
          ? name.trim()
          : existing.name;
      let newStatus = existing.status;
      if (status !== undefined) {
        if (status !== "active" && status !== "archived") {
          res
            .status(400)
            .json({ error: "status must be 'active' or 'archived'." });
          return;
        }
        newStatus = status;
      }

      // Optional client reassignment.
      let newPrimary = existing.primary_district_id;
      if (primaryDistrictId !== undefined && primaryDistrictId !== null) {
        const pid = toInt(primaryDistrictId);
        if (pid == null) {
          res.status(400).json({ error: "Invalid primaryDistrictId" });
          return;
        }
        if ((await missingDistricts([pid])).length > 0) {
          res.status(404).json({ error: "Client district not found." });
          return;
        }
        newPrimary = pid;
      }

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE matters
          SET name = ${newName}, status = ${newStatus},
              primary_district_id = ${newPrimary}
          WHERE id = ${id} AND firm_id = ${firm.firmId}
        `);
        if (
          newPrimary != null &&
          newPrimary !== existing.primary_district_id
        ) {
          // Re-point the canonical client role: drop the previous client and
          // any existing row for the new district, then insert it as client.
          await tx.execute(sql`
            DELETE FROM matter_districts
            WHERE matter_id = ${id}
              AND (role = 'client' OR district_id = ${newPrimary})
          `);
          await tx.execute(sql`
            INSERT INTO matter_districts (matter_id, district_id, role)
            VALUES (${id}, ${newPrimary}, 'client')
          `);
          await tx.execute(sql`
            INSERT INTO tracked_districts (firm_id, district_id, created_by)
            VALUES (${firm.firmId}, ${newPrimary}, ${firm.userId})
            ON CONFLICT (firm_id, district_id) DO NOTHING
          `);
        }
      });

      const matter = await loadMatter(id, firm.firmId);
      res.json({ matter });
    } catch (err) {
      console.error("firm matter update error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.delete(
  "/firm/matters/:id",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const id = toInt(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "Invalid matter id" });
      return;
    }
    try {
      const r = await db.execute(sql`
        DELETE FROM matters WHERE id = ${id} AND firm_id = ${firm.firmId}
        RETURNING id
      `);
      if (r.rows.length === 0) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if (Number(req.session.activeMatterId) === id) {
        req.session.activeMatterId = null;
      }
      res.status(204).end();
    } catch (err) {
      console.error("firm matter delete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// Matter districts — attach / detach
// ---------------------------------------------------------------------------

router.post(
  "/firm/matters/:id/districts",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const id = toInt(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "Invalid matter id" });
      return;
    }
    const { districtId, role } = req.body as {
      districtId?: unknown;
      role?: unknown;
    };
    const did = toInt(districtId);
    const roleVal = role === "client" ? "client" : role === "peer" ? "peer" : null;
    if (did == null || roleVal == null) {
      res
        .status(400)
        .json({ error: "districtId and role ('client'|'peer') are required." });
      return;
    }

    try {
      const existing = await firmOwnsMatter(id, firm.firmId);
      if (!existing) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      if ((await missingDistricts([did])).length > 0) {
        res.status(404).json({ error: "District not found." });
        return;
      }

      if (roleVal === "peer") {
        if (existing.primary_district_id === did) {
          res.status(400).json({
            error:
              "That district is the client on this matter. Reassign the client before adding it as a peer.",
          });
          return;
        }
        await db.execute(sql`
          INSERT INTO matter_districts (matter_id, district_id, role)
          VALUES (${id}, ${did}, 'peer')
          ON CONFLICT (matter_id, district_id) DO UPDATE SET role = 'peer'
        `);
      } else {
        // role === 'client' → reassign the canonical client.
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            UPDATE matters SET primary_district_id = ${did}
            WHERE id = ${id} AND firm_id = ${firm.firmId}
          `);
          await tx.execute(sql`
            DELETE FROM matter_districts
            WHERE matter_id = ${id} AND (role = 'client' OR district_id = ${did})
          `);
          await tx.execute(sql`
            INSERT INTO matter_districts (matter_id, district_id, role)
            VALUES (${id}, ${did}, 'client')
          `);
        });
      }

      // Keep the roster coherent.
      await db.execute(sql`
        INSERT INTO tracked_districts (firm_id, district_id, created_by)
        VALUES (${firm.firmId}, ${did}, ${firm.userId})
        ON CONFLICT (firm_id, district_id) DO NOTHING
      `);

      const matter = await loadMatter(id, firm.firmId);
      res.json({ matter });
    } catch (err) {
      console.error("firm matter attach district error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.delete(
  "/firm/matters/:id/districts/:districtId",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const id = toInt(req.params.id);
    const did = toInt(req.params.districtId);
    if (id == null || did == null) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    try {
      // Delete the role row and (if it was the client) clear primary_district_id
      // atomically, so the dual-stored client invariant can never be left half
      // applied. The DELETE joins through matters so a foreign matter id can
      // never touch another firm's rows.
      const removedRole = await db.transaction(async (tx) => {
        const del = await tx.execute(sql`
          DELETE FROM matter_districts md
          USING matters m
          WHERE md.matter_id = m.id
            AND m.id = ${id} AND m.firm_id = ${firm.firmId}
            AND md.district_id = ${did}
          RETURNING md.role
        `);
        if (del.rows.length === 0) return null;
        const role = String((del.rows[0] as { role: unknown }).role);
        if (role === "client") {
          await tx.execute(sql`
            UPDATE matters SET primary_district_id = NULL
            WHERE id = ${id} AND firm_id = ${firm.firmId}
          `);
        }
        return role;
      });
      if (removedRole === null) {
        // Either the matter is not in this firm, or the district wasn't attached.
        const owned = await firmOwnsMatter(id, firm.firmId);
        res.status(404).json({ error: owned ? "District not attached" : "Not found" });
        return;
      }
      const matter = await loadMatter(id, firm.firmId);
      res.json({ matter });
    } catch (err) {
      console.error("firm matter detach district error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// Active matter — the workspace's current selection context (session-scoped,
// parallel to activeFirmId). Later phases (comparison matrix, clause search,
// exports, alerts) read this to know which selection set to operate over.
// ---------------------------------------------------------------------------

router.get(
  "/firm/active-matter",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    try {
      const activeId = await resolveActiveMatterId(req, firm.firmId);
      const matter = activeId == null ? null : await loadMatter(activeId, firm.firmId);
      res.json({ matter });
    } catch (err) {
      console.error("firm active-matter get error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.post(
  "/firm/active-matter",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const { matterId } = req.body as { matterId?: unknown };
    try {
      if (matterId == null) {
        req.session.activeMatterId = null;
        res.json({ ok: true, matter: null });
        return;
      }
      const id = toInt(matterId);
      if (id == null) {
        res.status(400).json({ error: "Invalid matter id" });
        return;
      }
      const owned = await firmOwnsMatter(id, firm.firmId);
      if (!owned) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      req.session.activeMatterId = id;
      const matter = await loadMatter(id, firm.firmId);
      res.json({ ok: true, matter });
    } catch (err) {
      console.error("firm active-matter set error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
