import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcrypt";
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

// ============================================================================
// IP-based failure tracking
// Lock an IP for 15 minutes after 5 consecutive failed login attempts.
// Resets on a successful login from that IP.
// ============================================================================
interface IpRecord {
  count: number;
  until?: Date;
}
const ipFailures = new Map<string, IpRecord>();

function getIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

function isIpLocked(ip: string): boolean {
  const rec = ipFailures.get(ip);
  if (!rec) return false;
  if (rec.until && rec.until > new Date()) return true;
  return false;
}

function recordIpFailure(ip: string): void {
  const rec = ipFailures.get(ip) ?? { count: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.until = new Date(Date.now() + 15 * 60 * 1000);
  }
  ipFailures.set(ip, rec);
}

function clearIpFailures(ip: string): void {
  ipFailures.delete(ip);
}

const router: IRouter = Router();

// Generic failure — never reveal whether the email exists, whether the account
// is locked, or whether the account is deactivated. Log the real reason only
// server-side.
function genericFail(res: Response, reason?: string): void {
  if (reason) console.info(`[auth] login rejected: ${reason}`);
  res.status(401).json({ error: "Invalid email or password." });
}

// ============================================================================
// POST /api/auth/login — email + password sign-in
// Same endpoint for both admins and customers. Role determines redirect.
// ============================================================================
router.post("/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const ip = getIp(req);

  // --- IP lockout check (before credential verification) ---
  if (isIpLocked(ip)) {
    genericFail(res, `IP ${ip} is locked out`);
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
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

    // No account or no password set
    if (!user || !user.password_hash) {
      recordIpFailure(ip);
      genericFail(res, `no account/hash for ${normalizedEmail}`);
      return;
    }

    // Deactivated account (admins are always allowed)
    if (user.role !== "admin" && user.active === false) {
      recordIpFailure(ip);
      genericFail(res, `account deactivated: ${normalizedEmail}`);
      return;
    }

    // Per-account lockout (belt-and-suspenders on top of IP lockout)
    if (user.lockout_until && new Date(user.lockout_until) > new Date()) {
      recordIpFailure(ip);
      genericFail(res, `account locked: ${normalizedEmail}`);
      return;
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      // Increment both IP and per-account failure counters
      recordIpFailure(ip);
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
      genericFail(res, `wrong password for ${normalizedEmail} (attempt ${newCount})`);
      return;
    }

    // Successful login — clear all failure state
    clearIpFailures(ip);
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
