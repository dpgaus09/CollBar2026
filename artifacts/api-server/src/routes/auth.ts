import { Router, type IRouter, type Request, type Response } from "express";
import * as oidc from "openid-client";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import type { Profile as GoogleProfile } from "passport-google-oauth20";
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
    // Temporary storage for Replit OIDC PKCE flow
    _oidcCodeVerifier?: string;
    _oidcNonce?: string;
    _oidcState?: string;
  }
}

const router: IRouter = Router();

// ============================================================================
// Helpers
// ============================================================================

/**
 * Stable origin for OAuth callbacks.
 * Priority: ORIGIN env var → REPLIT_DEV_DOMAIN:8080 → derived from request.
 * Using REPLIT_DEV_DOMAIN:8080 ensures the callback always resolves directly
 * to the API server port, regardless of which frontend port the user came from.
 */
function getApiOrigin(req: Request): string {
  if (process.env.ORIGIN) return process.env.ORIGIN;
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}:8080`;
  }
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    req.headers.host ??
    "localhost";
  return `${proto}://${host}`;
}

// Absolute callback URL — computed once at module load for Google OAuth.
// Passport registers this with Google, so it must match the Google Cloud Console entry.
const GOOGLE_CALLBACK_URL = process.env.ORIGIN
  ? `${process.env.ORIGIN}/api/auth/google/callback`
  : process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}:8080/api/auth/google/callback`
    : "/api/auth/google/callback";

console.info(`[auth] Google callback URL: ${GOOGLE_CALLBACK_URL}`);

// ============================================================================
// Google OAuth — customer (district user) sign-in
// Email must be in approved_customers where active = true.
// ============================================================================

passport.use(
  "google",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID ?? "GOOGLE_CLIENT_ID_NOT_SET",
      clientSecret:
        process.env.GOOGLE_CLIENT_SECRET ?? "GOOGLE_CLIENT_SECRET_NOT_SET",
      callbackURL: GOOGLE_CALLBACK_URL,
      scope: ["email", "profile"],
    },
    (_accessToken, _refreshToken, profile: GoogleProfile, done) => {
      done(null, profile);
    },
  ),
);

// Minimal serialize/deserialize — we do NOT use passport sessions;
// session management is handled directly with express-session.
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) =>
  done(null, user as Express.User),
);

// GET /api/auth/google — initiate Google OAuth
router.get("/auth/google", (req: Request, res: Response, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    res.status(503).json({
      error:
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Replit Secrets.",
    });
    return;
  }
  passport.authenticate("google", {
    scope: ["email", "profile"],
    session: false,
  })(req, res, next);
});

// GET /api/auth/google/callback — Google returns here after consent
router.get(
  "/auth/google/callback",
  (req: Request, res: Response, next) => {
    passport.authenticate("google", {
      session: false,
      failureRedirect: "/login?error=auth_failed",
    })(req, res, next);
  },
  async (req: Request, res: Response) => {
    const profile = req.user as GoogleProfile | undefined;
    const email = profile?.emails?.[0]?.value?.toLowerCase();

    if (!email) {
      res.redirect("/login?error=no_email");
      return;
    }

    try {
      // Check approved customer list
      const rows = await db.execute(
        sql`SELECT id, name, active, district_id FROM approved_customers WHERE email = ${email}`,
      );
      const customer = rows.rows[0] as
        | {
            id: number;
            name: string;
            active: boolean;
            district_id: number | null;
          }
        | undefined;

      if (!customer || !customer.active) {
        res.redirect("/login?error=not_registered");
        return;
      }

      // Update last sign-in timestamp
      await db.execute(
        sql`UPDATE approved_customers SET last_sign_in_at = NOW() WHERE id = ${customer.id}`,
      );

      // Upsert into users table (preserves existing district association)
      const upsertRows = await db.execute(
        sql`INSERT INTO users (email, role, plan, district_id)
            VALUES (${email}, 'district_user', 'free', ${customer.district_id ?? null})
            ON CONFLICT (email) DO UPDATE
              SET district_id = COALESCE(EXCLUDED.district_id, users.district_id)
            RETURNING id, email, role, plan, district_id`,
      );
      const user = upsertRows.rows[0] as {
        id: number;
        email: string;
        role: string;
        plan: string;
        district_id: number | null;
      };

      req.session.regenerate((err) => {
        if (err) {
          res.redirect("/login?error=session_error");
          return;
        }
        req.session.userId = user.id;
        req.session.userRole = "district_user";
        req.session.userDistrictId =
          user.district_id != null ? Number(user.district_id) : null;
        req.session.userEmail = user.email;
        req.session.userPlan = (user.plan ?? "free") as "free" | "pro";

        const dest = user.district_id
          ? `/dashboard/${user.district_id}`
          : "/dashboard";
        res.redirect(dest);
      });
    } catch (err) {
      console.error("Google OAuth callback error:", err);
      res.redirect("/login?error=server_error");
    }
  },
);

// ============================================================================
// Replit OIDC — admin sign-in
// Only the Replit user whose `sub` matches ADMIN_REPLIT_ID is granted access.
// ============================================================================

let _oidcConfig: oidc.Configuration | null = null;

async function getReplitOidcConfig(): Promise<oidc.Configuration> {
  if (!_oidcConfig) {
    _oidcConfig = await oidc.discovery(
      new URL("https://replit.com/oidc"),
      process.env.REPL_ID!,
    );
  }
  return _oidcConfig;
}

// GET /api/auth/replit — initiate Replit OIDC (PKCE)
router.get("/auth/replit", async (req: Request, res: Response) => {
  try {
    const config = await getReplitOidcConfig();
    const callbackUrl = `${getApiOrigin(req)}/api/auth/replit/callback`;

    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

    // Stash PKCE params in the existing express-session (no cookie-parser needed)
    req.session._oidcCodeVerifier = codeVerifier;
    req.session._oidcNonce = nonce;
    req.session._oidcState = state;

    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );

    const redirectTo = oidc.buildAuthorizationUrl(config, {
      redirect_uri: callbackUrl,
      scope: "openid email profile",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });

    res.redirect(redirectTo.href);
  } catch (err) {
    console.error("Replit OIDC init error:", err);
    res.redirect("/admin?error=oidc_init_failed");
  }
});

// GET /api/auth/replit/callback — Replit returns here
router.get("/auth/replit/callback", async (req: Request, res: Response) => {
  const codeVerifier = req.session._oidcCodeVerifier;
  const nonce = req.session._oidcNonce;
  const expectedState = req.session._oidcState;

  // Clear OIDC transient state regardless of outcome
  delete req.session._oidcCodeVerifier;
  delete req.session._oidcNonce;
  delete req.session._oidcState;

  if (!codeVerifier || !expectedState) {
    res.redirect("/admin?error=no_oidc_state");
    return;
  }

  try {
    const config = await getReplitOidcConfig();
    const callbackUrl = `${getApiOrigin(req)}/api/auth/replit/callback`;

    const currentUrl = new URL(
      `${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`,
    );

    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims) {
      res.redirect("/admin?error=no_claims");
      return;
    }

    const replitId = claims.sub;
    const adminReplitId = process.env.ADMIN_REPLIT_ID;

    if (!adminReplitId) {
      // ADMIN_REPLIT_ID not yet configured — log the ID so the admin can set it
      console.warn(
        `ADMIN_REPLIT_ID is not set. ` +
          `Replit user attempted admin login with sub="${replitId}". ` +
          `Set ADMIN_REPLIT_ID=${replitId} in Replit Secrets to grant admin access.`,
      );
      res.redirect("/admin?error=admin_not_configured");
      return;
    }

    if (replitId !== adminReplitId) {
      res.redirect("/admin?error=access_denied");
      return;
    }

    // Granted — set admin session
    req.session.regenerate((err) => {
      if (err) {
        res.redirect("/admin?error=session_error");
        return;
      }
      req.session.adminAuthenticated = true;
      req.session.userRole = "admin";
      req.session.userEmail =
        (claims.email as string | undefined) ?? undefined;
      res.redirect("/admin");
    });
  } catch (err) {
    console.error("Replit OIDC callback error:", err);
    res.redirect("/admin?error=oidc_callback_failed");
  }
});

// ============================================================================
// GET /api/auth/me — return current session state
// ============================================================================
router.get("/auth/me", (req: Request, res: Response) => {
  if (!req.session.userId && !req.session.adminAuthenticated) {
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
