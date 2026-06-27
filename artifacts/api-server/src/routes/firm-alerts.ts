import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireFirmSession } from "../lib/firm-access.js";
import { firmScopeDistrictIds } from "../lib/firm-scope.js";
import { logger } from "../lib/logger.js";

// ============================================================================
// Phase 6 — Settlement alerts on tracked districts (firm workspace).
//
// A firm member subscribes a district to an event type and unsubscribes; the
// feed surfaces alerts that the on-demand data refresh wrote (see
// lib/alert-detection.ts) for those subscriptions. NO new alerts store — the
// feed JOINs the shared global `alerts` table to this firm's subscriptions on
// (district_id, event_type ↔ alert_type).
//
// HARD INVARIANTS:
//  - Entitlement is requireFirmSession (firm membership) — NEVER gate()/isFree().
//  - Every subscription a firm creates must be for a district inside its CURRENT
//    scope (roster ∪ matters). An out-of-scope districtId is a 404 (no leak).
//  - Reads (list + feed) are re-filtered to the CURRENT scope so a subscription
//    whose district later left the roster/matters stops surfacing — and another
//    firm's subscription id can never be deleted (cross-firm DELETE → 404).
//  - event_type mirrors alerts.alert_type ('new_settlement' / 'new_doc'). The UI
//    labels 'new_doc' "New contract" and may POST the 'new_contract' alias,
//    which we normalize to 'new_doc'.
// ============================================================================

const router: IRouter = Router();

const FEED_LIMIT = 200;

type EventType = "new_settlement" | "new_doc";
const EVENT_TYPES: readonly EventType[] = ["new_settlement", "new_doc"];

// Accept the on-screen alias 'new_contract' for 'new_doc'; reject anything else.
function parseEventType(v: unknown): EventType | null {
  if (v === "new_contract") return "new_doc";
  return EVENT_TYPES.includes(v as EventType) ? (v as EventType) : null;
}

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A reusable "id IN (...)" fragment for a non-empty id set. Callers must
// short-circuit on an empty scope (an empty IN-list is a SQL error).
function idInList(ids: number[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

// ---------------------------------------------------------------------------
// GET /api/firm/alert-subscriptions — this firm's subscriptions, newest first,
// filtered to the firm's CURRENT district scope.
// ---------------------------------------------------------------------------
router.get(
  "/firm/alert-subscriptions",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    try {
      const scope = await firmScopeDistrictIds(firm.firmId);
      if (scope.size === 0) {
        res.json({ subscriptions: [] });
        return;
      }
      const idList = idInList([...scope]);
      const r = await db.execute(sql`
        SELECT s.id, s.district_id, d.name AS district_name, s.event_type,
               s.created_at
        FROM alert_subscriptions s
        JOIN districts d ON d.id = s.district_id
        WHERE s.firm_id = ${firm.firmId} AND s.district_id IN (${idList})
        ORDER BY d.name ASC, s.event_type ASC
      `);
      const subscriptions = (r.rows as Array<Record<string, unknown>>).map(
        (row) => ({
          id: Number(row.id),
          districtId: Number(row.district_id),
          districtName: String(row.district_name ?? ""),
          eventType: String(row.event_type),
          createdAt: row.created_at == null ? null : String(row.created_at),
        }),
      );
      res.json({ subscriptions });
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "alert-subscriptions list failed");
      res.status(500).json({ error: "Could not load alert subscriptions." });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/firm/alert-subscriptions  { districtId, eventType }
// Subscribe a district (must be in scope) to an event type. Idempotent: a
// repeat subscribe returns the existing row (ON CONFLICT DO NOTHING upsert).
// ---------------------------------------------------------------------------
router.post(
  "/firm/alert-subscriptions",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const body = req.body as { districtId?: unknown; eventType?: unknown };

    const districtId = toInt(body.districtId);
    if (districtId == null) {
      res.status(400).json({ error: "districtId is required." });
      return;
    }
    const eventType = parseEventType(body.eventType);
    if (!eventType) {
      res.status(400).json({ error: "Invalid eventType." });
      return;
    }

    try {
      // Enforce CURRENT scope: an out-of-scope (or unknown) district is a 404 —
      // no existence leak and no subscribing to a district the firm can't see.
      const scope = await firmScopeDistrictIds(firm.firmId);
      if (!scope.has(districtId)) {
        res.status(404).json({ error: "District not found in your workspace." });
        return;
      }

      const nameRow = await db.execute(sql`
        SELECT name FROM districts WHERE id = ${districtId} LIMIT 1
      `);
      const districtName = String(
        (nameRow.rows[0] as { name?: unknown } | undefined)?.name ?? "",
      );

      // Idempotent upsert: a duplicate (firm, district, event) returns the
      // existing row rather than erroring. DO UPDATE (a no-op set) lets
      // RETURNING surface the row on conflict; DO NOTHING would return nothing.
      const r = await db.execute(sql`
        INSERT INTO alert_subscriptions (firm_id, district_id, event_type, created_by)
        VALUES (${firm.firmId}, ${districtId}, ${eventType}, ${firm.userId})
        ON CONFLICT (firm_id, district_id, event_type)
          DO UPDATE SET event_type = EXCLUDED.event_type
        RETURNING id, created_at
      `);
      const row = r.rows[0] as { id: unknown; created_at: unknown };
      res.status(201).json({
        id: Number(row.id),
        districtId,
        districtName,
        eventType,
        createdAt: row.created_at == null ? null : String(row.created_at),
      });
    } catch (err) {
      logger.error(
        { err, firmId: firm.firmId },
        "alert-subscription create failed",
      );
      res.status(500).json({ error: "Could not create the subscription." });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /api/firm/alert-subscriptions/:id — unsubscribe. Firm-scoped: another
// firm's subscription id is a 404 (no existence leak).
// ---------------------------------------------------------------------------
router.delete(
  "/firm/alert-subscriptions/:id",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const id = toInt(req.params.id);
    if (id == null) {
      res.status(404).json({ error: "Subscription not found." });
      return;
    }
    try {
      const r = await db.execute(sql`
        DELETE FROM alert_subscriptions
        WHERE id = ${id} AND firm_id = ${firm.firmId}
        RETURNING id
      `);
      if (r.rows.length === 0) {
        res.status(404).json({ error: "Subscription not found." });
        return;
      }
      res.json({ ok: true, id });
    } catch (err) {
      logger.error(
        { err, firmId: firm.firmId, id },
        "alert-subscription delete failed",
      );
      res.status(500).json({ error: "Could not delete the subscription." });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/firm/alerts — the triggered-alert feed. Joins the shared `alerts`
// table to this firm's subscriptions on (district_id, alert_type) and re-filters
// to the firm's current scope. Newest first, capped at FEED_LIMIT.
// ---------------------------------------------------------------------------
router.get(
  "/firm/alerts",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    try {
      const scope = await firmScopeDistrictIds(firm.firmId);
      if (scope.size === 0) {
        res.json({ alerts: [] });
        return;
      }
      const idList = idInList([...scope]);
      const r = await db.execute(sql`
        SELECT a.id, a.district_id, d.name AS district_name, a.alert_type,
               a.doc_name, a.source_url, a.status, a.detected_at
        FROM alerts a
        JOIN alert_subscriptions s
          ON s.firm_id = ${firm.firmId}
         AND s.district_id = a.district_id
         AND s.event_type = a.alert_type
        JOIN districts d ON d.id = a.district_id
        WHERE a.district_id IN (${idList})
        ORDER BY a.detected_at DESC NULLS LAST, a.id DESC
        LIMIT ${FEED_LIMIT}
      `);
      const alerts = (r.rows as Array<Record<string, unknown>>).map((row) => ({
        id: Number(row.id),
        districtId: Number(row.district_id),
        districtName: String(row.district_name ?? ""),
        eventType: String(row.alert_type),
        docName: row.doc_name == null ? null : String(row.doc_name),
        sourceUrl: row.source_url == null ? null : String(row.source_url),
        status: String(row.status ?? ""),
        detectedAt: row.detected_at == null ? null : String(row.detected_at),
      }));
      res.json({ alerts });
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "alert feed failed");
      res.status(500).json({ error: "Could not load alerts." });
    }
  },
);

export default router;
