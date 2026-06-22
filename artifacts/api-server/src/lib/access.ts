import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { CUSTOMER_STATE, enrollmentBand } from "./dashboard-query.js";

// Shown to free customers whenever they hit a paid-only feature, both in the UI
// and in the body of server 403 responses. Keep this in lockstep with the
// client copy in collbar-web (components/upgrade.tsx).
export const UPGRADE_MESSAGE =
  "This is for paid customers. To gain access, please email hello@collbar.com or call 312-768-8009.";

export interface Access {
  userId: number;
  role: "admin" | "district_user";
  plan: "free" | "pro";
  districtId: number | null;
  active: boolean;
}

// gate() attaches the freshly-resolved access onto the request so downstream
// handlers can shape their response by plan (e.g. strip paid-only fields for
// free customers) without re-reading the database.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      access?: Access;
    }
  }
}

// Resolve the caller's CURRENT access from the database rather than the cached
// session. Enforcement must reflect admin changes (downgrade Pro->Free, change
// of assigned district, or deactivation) immediately, not only after the
// customer next logs in. The freshly-read plan/district are also written back
// onto the session so /auth/me and the client stay consistent.
export async function loadAccess(req: Request): Promise<Access | null> {
  const userId = req.session.userId;
  if (!userId) return null;
  const rows = await db.execute(sql`
    SELECT id, role, plan, district_id, active
    FROM users
    WHERE id = ${userId}
    LIMIT 1
  `);
  const row = rows.rows[0] as
    | { id: unknown; role: unknown; plan: unknown; district_id: unknown; active: unknown }
    | undefined;
  if (!row) return null;
  const access: Access = {
    userId,
    role: row.role === "admin" ? "admin" : "district_user",
    plan: row.plan === "pro" ? "pro" : "free",
    districtId: row.district_id == null ? null : Number(row.district_id),
    active: row.active !== false,
  };
  req.session.userRole = access.role;
  req.session.userPlan = access.plan;
  req.session.userDistrictId = access.districtId;
  return access;
}

// A free customer is a non-admin on the free plan. Admins and Pro customers are
// never gated.
export function isFree(access: Access): boolean {
  return access.role !== "admin" && access.plan !== "pro";
}

interface GateOptions {
  // Block free customers entirely (paid-only feature).
  paid?: boolean;
  // Restrict free customers to their own assigned district (route has an :id param).
  ownDistrict?: boolean;
  // For the shared aggregate median endpoints the Overview needs: restrict free
  // customers' county/band query filters to their OWN district's county and
  // enrollment band. Without this, a free user could slice the statewide
  // benchmark by any county/band via direct API calls and reconstruct the paid
  // Comparables dataset. Filters that match (or are absent) pass; mismatches 403.
  ownFilters?: boolean;
}

// Access-control middleware factory. Always requires authentication and an
// active account. Optionally enforces paid-only access and/or own-district
// scoping for free customers. Admins and Pro customers pass through.
export function gate(options: GateOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    let access: Access | null;
    try {
      access = await loadAccess(req);
    } catch {
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    if (!access || !access.active) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.access = access;
    if (isFree(access)) {
      if (options.paid) {
        res.status(403).json({ error: "PAID_FEATURE", message: UPGRADE_MESSAGE });
        return;
      }
      if (options.ownDistrict) {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          res.status(400).json({ error: "Invalid district id" });
          return;
        }
        if (access.districtId == null || id !== access.districtId) {
          res.status(403).json({ error: "FORBIDDEN_DISTRICT", message: UPGRADE_MESSAGE });
          return;
        }
      }
      if (options.ownFilters) {
        const county = req.query.county ? String(req.query.county) : null;
        const band = req.query.band ? String(req.query.band) : null;
        // Only a county/band filter can leak cross-district benchmarks; a bare
        // (statewide) request returns the broadest aggregate and is harmless.
        if (county || band) {
          if (access.districtId == null) {
            res.status(403).json({ error: "FORBIDDEN_DISTRICT", message: UPGRADE_MESSAGE });
            return;
          }
          let own: { county: string | null; enrollment: unknown } | undefined;
          try {
            const r = await db.execute(sql`
              SELECT county, enrollment
              FROM districts
              WHERE id = ${access.districtId} AND state = ${CUSTOMER_STATE}
              LIMIT 1
            `);
            own = r.rows[0] as { county: string | null; enrollment: unknown } | undefined;
          } catch {
            res.status(500).json({ error: "Internal server error" });
            return;
          }
          if (!own) {
            res.status(403).json({ error: "FORBIDDEN_DISTRICT", message: UPGRADE_MESSAGE });
            return;
          }
          const ownBand = enrollmentBand(own.enrollment == null ? null : Number(own.enrollment));
          if ((county && county !== own.county) || (band && band !== ownBand)) {
            res.status(403).json({ error: "FORBIDDEN_DISTRICT", message: UPGRADE_MESSAGE });
            return;
          }
        }
      }
    }
    next();
  };
}
