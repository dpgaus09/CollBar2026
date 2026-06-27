import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Firm workspace access control.
//
// This is the SECOND, parallel entitlement system. lib/access.ts gate()
// governs the per-district CFO dashboard (free/pro on users.plan). This module
// governs the multi-seat attorney/consultant workspace (/api/firm/*, /app):
// access derives purely from firm_members membership, never from users.plan.
// The two never share enforcement code.
// ---------------------------------------------------------------------------

export type FirmRole = "firm_admin" | "member";
export type FirmPlanTier = "state" | "region" | "national";

export interface FirmAccess {
  userId: number;
  firmId: number;
  firmName: string;
  planTier: FirmPlanTier;
  firmRole: FirmRole;
}

export interface FirmSummary {
  id: number;
  name: string;
  planTier: FirmPlanTier;
  role: FirmRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      firmAccess?: FirmAccess;
    }
  }
}

function coerceTier(v: unknown): FirmPlanTier {
  return v === "region" || v === "national" ? v : "state";
}

function coerceRole(v: unknown): FirmRole {
  return v === "firm_admin" ? "firm_admin" : "member";
}

type FirmAccessRow = {
  firm_id: unknown;
  name: unknown;
  plan_tier: unknown;
  role: unknown;
};

// The caller's first (oldest) firm membership — used as the default "active"
// firm for the session and as the firm summary returned by /auth/me and login.
export async function loadFirmSummaryForUser(
  userId: number,
): Promise<FirmSummary | null> {
  const rows = await db.execute(sql`
    SELECT f.id, f.name, f.plan_tier, fm.role
    FROM firm_members fm
    JOIN firms f ON f.id = fm.firm_id
    WHERE fm.user_id = ${userId}
    ORDER BY fm.created_at ASC, fm.id ASC
    LIMIT 1
  `);
  const r = rows.rows[0] as
    | { id: unknown; name: unknown; plan_tier: unknown; role: unknown }
    | undefined;
  if (!r) return null;
  return {
    id: Number(r.id),
    name: String(r.name),
    planTier: coerceTier(r.plan_tier),
    role: coerceRole(r.role),
  };
}

// Resolve the caller's CURRENT firm access from the database (not the cached
// session) so membership/role changes take effect immediately. Honors
// session.activeFirmId when it is still a valid membership, otherwise falls
// back to the user's first membership. The resolved firm id/role are written
// back onto the session.
export async function loadFirmAccess(req: Request): Promise<FirmAccess | null> {
  const userId = req.session.userId;
  if (!userId) return null;

  const activeFirmId = req.session.activeFirmId;
  let r: FirmAccessRow | undefined;

  if (activeFirmId != null) {
    const rows = await db.execute(sql`
      SELECT f.id AS firm_id, f.name, f.plan_tier, fm.role
      FROM firm_members fm
      JOIN firms f ON f.id = fm.firm_id
      WHERE fm.user_id = ${userId} AND fm.firm_id = ${activeFirmId}
      LIMIT 1
    `);
    r = rows.rows[0] as FirmAccessRow | undefined;
  }

  if (!r) {
    const rows = await db.execute(sql`
      SELECT f.id AS firm_id, f.name, f.plan_tier, fm.role
      FROM firm_members fm
      JOIN firms f ON f.id = fm.firm_id
      WHERE fm.user_id = ${userId}
      ORDER BY fm.created_at ASC, fm.id ASC
      LIMIT 1
    `);
    r = rows.rows[0] as FirmAccessRow | undefined;
  }

  if (!r) return null;

  const access: FirmAccess = {
    userId: Number(userId),
    firmId: Number(r.firm_id),
    firmName: String(r.name),
    planTier: coerceTier(r.plan_tier),
    firmRole: coerceRole(r.role),
  };
  req.session.activeFirmId = access.firmId;
  req.session.firmRole = access.firmRole;
  return access;
}

// Middleware factory: require an authenticated user who is a member of a firm.
// Pass { firmAdmin: true } for firm-admin-only routes. Attaches req.firmAccess.
export function requireFirmSession(options: { firmAdmin?: boolean } = {}) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.session.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    let access: FirmAccess | null;
    try {
      access = await loadFirmAccess(req);
    } catch (err) {
      console.error("loadFirmAccess failed:", err);
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    if (!access) {
      res
        .status(403)
        .json({ error: "FIRM_REQUIRED", message: "You are not a member of a workspace." });
      return;
    }
    req.firmAccess = access;
    if (options.firmAdmin && access.firmRole !== "firm_admin") {
      res
        .status(403)
        .json({ error: "FIRM_ADMIN_REQUIRED", message: "Only workspace admins can do this." });
      return;
    }
    next();
  };
}
