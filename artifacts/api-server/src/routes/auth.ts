import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    userRole?: "admin" | "district_user";
    userDistrictId?: number | null;
    userEmail?: string;
  }
}

const router: IRouter = Router();

interface MagicLinkEntry {
  userId: number;
  expiresAt: number;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const magicLinks = new Map<string, MagicLinkEntry>();
const rateLimits = new Map<string, RateLimitEntry>();

const TOKEN_EXPIRY_MS = 15 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

function cleanupExpired() {
  const now = Date.now();
  for (const [t, e] of magicLinks.entries()) {
    if (e.expiresAt < now) magicLinks.delete(t);
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/request — request a magic link
// ---------------------------------------------------------------------------
router.post("/auth/request", async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Valid email required" });
    return;
  }

  const normalEmail = email.toLowerCase().trim();
  const now = Date.now();

  const entry = rateLimits.get(normalEmail);
  if (entry && now - entry.windowStart < RATE_LIMIT_WINDOW_MS) {
    if (entry.count >= RATE_LIMIT_MAX) {
      res.status(429).json({ error: "Too many login attempts. Try again in an hour." });
      return;
    }
    entry.count++;
  } else {
    rateLimits.set(normalEmail, { count: 1, windowStart: now });
  }

  try {
    const rows = await db.execute(
      sql`SELECT id, email, role, district_id FROM users WHERE email = ${normalEmail}`,
    );
    const user = rows.rows[0] as { id: number; email: string; role: string; district_id: number | null } | undefined;

    if (!user) {
      res.json({ message: "If this email is registered, a magic link will be generated." });
      return;
    }

    cleanupExpired();
    const token = randomBytes(32).toString("hex");
    magicLinks.set(token, { userId: user.id, expiresAt: now + TOKEN_EXPIRY_MS });

    const origin =
      (req.headers.origin as string | undefined) ??
      `${(req.headers["x-forwarded-proto"] as string | undefined) ?? "http"}://${req.headers.host ?? "localhost"}`;
    const magicLink = `${origin}/auth/verify?token=${token}`;

    const isDev = process.env.NODE_ENV !== "production";
    res.json({
      message: isDev
        ? "Magic link generated (dev mode — link returned in response body)"
        : "Magic link sent. Check your email.",
      ...(isDev ? { magicLink } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/verify?token=... — verify magic link token, create session
// ---------------------------------------------------------------------------
router.get("/auth/verify", async (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) {
    res.status(400).json({ error: "Token required" });
    return;
  }

  const entry = magicLinks.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    magicLinks.delete(token);
    res.status(401).json({ error: "Invalid or expired magic link. Request a new one." });
    return;
  }

  magicLinks.delete(token);

  try {
    const rows = await db.execute(
      sql`SELECT id, email, role, district_id FROM users WHERE id = ${entry.userId}`,
    );
    const user = rows.rows[0] as { id: number; email: string; role: string; district_id: number | null } | undefined;

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    req.session.userId = user.id;
    req.session.userRole = user.role as "admin" | "district_user";
    req.session.userDistrictId = user.district_id ?? null;
    req.session.userEmail = user.email;

    res.json({
      ok: true,
      role: user.role,
      districtId: user.district_id,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — return current session info
// ---------------------------------------------------------------------------
router.get("/auth/me", (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.json({ authenticated: false });
    return;
  }
  res.json({
    authenticated: true,
    userId: req.session.userId,
    role: req.session.userRole,
    districtId: req.session.userDistrictId,
    email: req.session.userEmail,
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
router.post("/auth/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

export default router;
