import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ============================================================================
// Session type augmentation
// ============================================================================
declare module "express-session" {
  interface SessionData {
    userId?: number;
    userRole?: "admin" | "district_user";
    userDistrictId?: number | null;
    userEmail?: string;
    userPlan?: "free" | "pro";
    adminAuthenticated?: boolean;
  }
}

const router: IRouter = Router();

// ============================================================================
// Rate limiting — 10 login attempts per 15 minutes per IP
// ============================================================================
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait 15 minutes and try again." },
  skipSuccessfulRequests: true,
});

// ============================================================================
// POST /api/auth/login — email + password sign-in
// Same endpoint for both admins and customers. Role determines redirect.
// ============================================================================
router.post("/auth/login", loginRateLimit, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // Look up user (both admins and customers live in the users table)
    const rows = await db.execute(sql`
      SELECT id, email, role, plan, district_id, password_hash, active,
             failed_login_count, lockout_until
      FROM users
      WHERE email = ${normalizedEmail}
    `);

    const user = rows.rows[0] as {
      id: number;
      email: string;
      role: string;
      plan: string;
      district_id: number | null;
      password_hash: string | null;
      active: boolean;
      failed_login_count: number;
      lockout_until: string | null;
    } | undefined;

    // Generic failure message — never reveal whether email exists
    const fail = () => res.status(401).json({ error: "Invalid email or password." });

    if (!user || !user.password_hash) {
      fail();
      return;
    }

    // Check account lockout
    if (user.lockout_until && new Date(user.lockout_until) > new Date()) {
      res.status(429).json({
        error: "Account temporarily locked due to too many failed attempts. Please try again in 15 minutes.",
      });
      return;
    }

    // Check active flag (not applicable to admins — always allow admin logins)
    if (user.role !== "admin" && user.active === false) {
      res.status(403).json({ error: "Your account has been deactivated. Contact your administrator." });
      return;
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      // Increment failed attempt counter; lock after 5 consecutive failures
      const newCount = (user.failed_login_count ?? 0) + 1;
      if (newCount >= 5) {
        await db.execute(sql`
          UPDATE users
          SET failed_login_count = ${newCount},
              lockout_until = NOW() + INTERVAL '15 minutes'
          WHERE id = ${user.id}
        `);
      } else {
        await db.execute(sql`
          UPDATE users SET failed_login_count = ${newCount} WHERE id = ${user.id}
        `);
      }
      fail();
      return;
    }

    // Successful — clear lockout state
    await db.execute(sql`
      UPDATE users
      SET failed_login_count = 0, lockout_until = NULL, last_sign_in_at = NOW()
      WHERE id = ${user.id}
    `);

    // Regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ error: "Session error. Please try again." });
        return;
      }

      req.session.userId = user.id;
      req.session.userRole = user.role as "admin" | "district_user";
      req.session.userEmail = user.email;
      req.session.userPlan = (user.plan ?? "free") as "free" | "pro";
      req.session.userDistrictId =
        user.district_id != null ? Number(user.district_id) : null;

      if (user.role === "admin") {
        req.session.adminAuthenticated = true;
      }

      // Determine redirect destination
      const dest =
        user.role === "admin"
          ? "/admin"
          : user.district_id
          ? `/dashboard/${user.district_id}`
          : "/dashboard";

      res.json({ ok: true, redirect: dest });
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "A server error occurred. Please try again." });
  }
});

// ============================================================================
// GET /api/auth/me — return current session state
// ============================================================================
router.get("/auth/me", (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.json({ authenticated: false });
    return;
  }
  res.json({
    authenticated: true,
    userId: req.session.userId,
    role: req.session.userRole,
    plan: req.session.userPlan ?? "free",
    districtId: req.session.userDistrictId,
    email: req.session.userEmail,
  });
});

// ============================================================================
// POST /api/auth/logout
// ============================================================================
router.post("/auth/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

export default router;
