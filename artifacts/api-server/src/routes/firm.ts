import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { loginLimiter } from "../lib/rateLimit.js";
import { requireFirmSession } from "../lib/firm-access.js";

// ============================================================================
// Firm workspace auth & membership (Phase 1 — multi-seat accounts).
//
// Identity reuses the existing `users` table (bcrypt + express-session). A firm
// member is a users row (role 'district_user', plan 'free', no district) whose
// workspace access comes from firm_members — see lib/firm-access.ts. None of
// this touches the per-district CFO gate() entitlement.
// ============================================================================

const BCRYPT_COST = 12;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_PASSWORD = 8;

function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

function isEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const router: IRouter = Router();

// Public firm self-signup was removed: firms are now provisioned by the platform
// admin (POST /api/admin/firms in routes/admin.ts), which reuses the same
// users + firms + firm_members creation logic and bcrypt cost. Firm members
// continue to sign in at /login and accept invites via the routes below.

// ----------------------------------------------------------------------------
// GET /api/firm/me
// Firm summary + members (+ pending invites for firm admins) for the shell.
// ----------------------------------------------------------------------------
router.get("/firm/me", requireFirmSession(), async (req: Request, res: Response) => {
  const firm = req.firmAccess!;
  try {
    const members = await db.execute(sql`
      SELECT u.id, u.email, u.name, fm.role
      FROM firm_members fm
      JOIN users u ON u.id = fm.user_id
      WHERE fm.firm_id = ${firm.firmId}
      ORDER BY fm.created_at ASC, fm.id ASC
    `);
    let pendingInvites: Array<{ id: number; email: string; role: string }> = [];
    if (firm.firmRole === "firm_admin") {
      const pending = await db.execute(sql`
        SELECT id, email, role
        FROM firm_invites
        WHERE firm_id = ${firm.firmId}
          AND accepted_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
      `);
      pendingInvites = (pending.rows as Array<{ id: unknown; email: unknown; role: unknown }>).map(
        (p) => ({ id: Number(p.id), email: String(p.email), role: String(p.role) }),
      );
    }
    res.json({
      firm: { id: firm.firmId, name: firm.firmName, planTier: firm.planTier },
      role: firm.firmRole,
      members: (members.rows as Array<{ id: unknown; email: unknown; name: unknown; role: unknown }>).map(
        (m) => ({
          id: Number(m.id),
          email: String(m.email),
          name: m.name == null ? null : String(m.name),
          role: String(m.role),
        }),
      ),
      pendingInvites,
    });
  } catch (err) {
    console.error("firm/me error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ----------------------------------------------------------------------------
// POST /api/firm/invite  (firm admins only)
// Create a single-use, expiring invite. body: { email, role? }
// Email delivery is a separate/future task; the invite link is returned to the
// authorized admin who created it, for them to share until email is wired.
// ----------------------------------------------------------------------------
router.post(
  "/firm/invite",
  requireFirmSession({ firmAdmin: true }),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const { email, role } = req.body as { email?: string; role?: string };
    if (!email) {
      res.status(400).json({ error: "Email is required." });
      return;
    }
    const normalized = normEmail(email);
    if (!isEmail(normalized)) {
      res.status(400).json({ error: "Please enter a valid email address." });
      return;
    }
    const inviteRole = role === "firm_admin" ? "firm_admin" : "member";

    try {
      // If this email is already a member of THIS firm, there's nothing to do.
      const existingUser = await db.execute(
        sql`SELECT id FROM users WHERE email = ${normalized} LIMIT 1`,
      );
      if (existingUser.rows.length) {
        const uid = Number((existingUser.rows[0] as { id: unknown }).id);
        const mem = await db.execute(sql`
          SELECT 1 FROM firm_members WHERE firm_id = ${firm.firmId} AND user_id = ${uid} LIMIT 1
        `);
        if (mem.rows.length) {
          res.status(409).json({ error: "That person is already a member of this workspace." });
          return;
        }
      }

      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
      await db.execute(sql`
        INSERT INTO firm_invites (firm_id, email, role, token_hash, invited_by_user_id, expires_at)
        VALUES (${firm.firmId}, ${normalized}, ${inviteRole}, ${tokenHash}, ${firm.userId}, ${expiresAt})
      `);

      res.json({
        ok: true,
        email: normalized,
        role: inviteRole,
        // Client prefixes the app base path. Recipient sets a password here.
        inviteLink: `/invite/accept?token=${token}`,
      });
    } catch (err) {
      console.error("Firm invite error:", err);
      res.status(500).json({ error: "A server error occurred. Please try again." });
    }
  },
);

// ----------------------------------------------------------------------------
// POST /api/firm/invite/accept
// Accept an invite: create-or-attach the user, join the firm, sign them in.
// body: { token, name?, password }
// ----------------------------------------------------------------------------
router.post("/firm/invite/accept", loginLimiter, async (req: Request, res: Response) => {
  const { token, name, password } = req.body as {
    token?: string;
    name?: string;
    password?: string;
  };
  if (!token) {
    res.status(400).json({ error: "Invalid or missing invite token." });
    return;
  }
  const tokenHash = hashToken(token);
  const sessionUserId = req.session.userId != null ? Number(req.session.userId) : null;

  try {
    const inv = await db.execute(sql`
      SELECT id, firm_id, email, role, expires_at, accepted_at
      FROM firm_invites WHERE token_hash = ${tokenHash} LIMIT 1
    `);
    const invite = inv.rows[0] as
      | {
          id: unknown;
          firm_id: unknown;
          email: string;
          role: string;
          expires_at: string | null;
          accepted_at: string | null;
        }
      | undefined;
    if (!invite || invite.accepted_at) {
      res.status(400).json({ error: "This invite link is invalid or has already been used." });
      return;
    }
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      res.status(400).json({ error: "This invite link has expired. Ask your workspace admin for a new one." });
      return;
    }

    const inviteId = Number(invite.id);
    const firmId = Number(invite.firm_id);
    const inviteEmail = normEmail(invite.email);
    const inviteRole = invite.role === "firm_admin" ? "firm_admin" : "member";

    // Does an account already exist for the invited email?
    const existingPre = await db.execute(
      sql`SELECT id FROM users WHERE email = ${inviteEmail} LIMIT 1`,
    );
    const existingUserId = existingPre.rows.length
      ? Number((existingPre.rows[0] as { id: unknown }).id)
      : null;

    // SECURITY: an invite link is a bearer token held by whoever created or
    // forwarded it. If the invited email already has an account, the ONLY safe
    // way to attach it to the firm is when the request is already authenticated
    // as that exact user — otherwise the inviter could keep the link and sign in
    // as someone else (account takeover). Brand-new accounts are created with a
    // password supplied here.
    if (existingUserId !== null) {
      if (sessionUserId !== existingUserId) {
        res.status(403).json({
          error: `This invitation is for ${inviteEmail}, which already has a CollBar account. Please sign in to that account first, then open this invite link again.`,
          requiresLogin: true,
          email: inviteEmail,
        });
        return;
      }
    } else if (!password || password.length < MIN_PASSWORD) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
      return;
    }

    const passwordHash =
      existingUserId === null ? await bcrypt.hash(password as string, BCRYPT_COST) : null;

    const result = await db.transaction(async (tx) => {
      // Lock the invite row and re-check it is unused & unexpired.
      const lock = await tx.execute(sql`
        SELECT accepted_at, expires_at FROM firm_invites WHERE id = ${inviteId} FOR UPDATE
      `);
      const cur = lock.rows[0] as
        | { accepted_at: string | null; expires_at: string | null }
        | undefined;
      if (!cur || cur.accepted_at) throw new Error("INVITE_USED");
      if (cur.expires_at && new Date(cur.expires_at) < new Date()) throw new Error("INVITE_EXPIRED");

      // Re-resolve the user under the lock (guards a concurrent account create).
      const existing = await tx.execute(
        sql`SELECT id FROM users WHERE email = ${inviteEmail} LIMIT 1`,
      );
      let uid: number;
      let isNew: boolean;
      if (existing.rows.length) {
        uid = Number((existing.rows[0] as { id: unknown }).id);
        // Must be authenticated as this exact user (re-asserted under the lock).
        // Never read or modify an existing user's credentials here.
        if (sessionUserId !== uid) throw new Error("INVITE_NEEDS_LOGIN");
        isNew = false;
      } else {
        if (!passwordHash) throw new Error("INVITE_NEEDS_PASSWORD");
        const u = await tx.execute(sql`
          INSERT INTO users (email, name, password_hash, role, plan, active)
          VALUES (${inviteEmail}, ${name?.trim() || null}, ${passwordHash}, 'district_user', 'free', true)
          RETURNING id
        `);
        uid = Number((u.rows[0] as { id: unknown }).id);
        isNew = true;
      }

      await tx.execute(sql`
        INSERT INTO firm_members (firm_id, user_id, role)
        VALUES (${firmId}, ${uid}, ${inviteRole})
        ON CONFLICT (firm_id, user_id) DO NOTHING
      `);
      await tx.execute(sql`UPDATE firm_invites SET accepted_at = NOW() WHERE id = ${inviteId}`);
      return { uid, isNew };
    });

    const { uid: userId, isNew } = result;

    if (isNew) {
      // Brand-new account: record the sign-in and establish a fresh session
      // (regenerate guards against session fixation for the new identity).
      try {
        await db.execute(sql`INSERT INTO login_events (user_id) VALUES (${userId})`);
      } catch (e) {
        console.error("Failed to record login_event:", e);
      }
      await db.execute(sql`UPDATE users SET last_sign_in_at = NOW() WHERE id = ${userId}`);

      req.session.regenerate((err) => {
        if (err) {
          res.status(500).json({ error: "Session error. Please try again." });
          return;
        }
        req.session.userId = userId;
        req.session.userRole = "district_user";
        req.session.userEmail = inviteEmail;
        req.session.userPlan = "free";
        req.session.userDistrictId = null;
        req.session.activeFirmId = firmId;
        req.session.firmRole = inviteRole;
        res.json({ ok: true, redirect: "/app" });
      });
    } else {
      // Existing user, already authenticated as themselves: attach the firm to
      // their current session without touching their identity, role, plan, or
      // district. (No regenerate — the authenticated identity is unchanged.)
      req.session.activeFirmId = firmId;
      req.session.firmRole = inviteRole;
      res.json({ ok: true, redirect: "/app" });
    }
  } catch (err) {
    const msg = String(err);
    if (msg.includes("INVITE_USED")) {
      res.status(400).json({ error: "This invite link has already been used." });
      return;
    }
    if (msg.includes("INVITE_EXPIRED")) {
      res.status(400).json({ error: "This invite link has expired. Ask your workspace admin for a new one." });
      return;
    }
    if (msg.includes("INVITE_NEEDS_LOGIN")) {
      res.status(403).json({
        error: "Please sign in to the invited account first, then open this invite link again.",
        requiresLogin: true,
      });
      return;
    }
    if (msg.includes("INVITE_NEEDS_PASSWORD")) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
      return;
    }
    console.error("Firm invite accept error:", err);
    res.status(500).json({ error: "A server error occurred. Please try again." });
  }
});

export default router;
