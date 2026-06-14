import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import bcrypt from "bcrypt";
import router from "./routes";
import publicHtmlRouter from "./routes/public-html";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const isProd = process.env.NODE_ENV === "production";

const sessionSecret = process.env.SESSION_SECRET;
if (isProd && !sessionSecret) {
  throw new Error(
    "SESSION_SECRET environment variable is required in production. " +
      "Set it to a long random string (e.g. openssl rand -hex 32).",
  );
}

const app: Express = express();

// Trust the first proxy (Replit's TLS terminator) so that secure session
// cookies are issued correctly over HTTPS in production.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: sessionSecret ?? "collbar-dev-only-not-for-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    },
  }),
);

// ---------------------------------------------------------------------------
// Security headers — applied to every response
// ---------------------------------------------------------------------------
app.use((_req, res, next) => {
  // DENY in production; allow same-origin frames in dev (Replit preview pane)
  res.setHeader("X-Frame-Options", isProd ? "DENY" : "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      isProd ? "frame-ancestors 'none'" : "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  if (isProd) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  next();
});

// Public server-rendered HTML pages (no /api prefix, before auth middleware)
app.use(publicHtmlRouter);

app.use("/api", router);

// ---------------------------------------------------------------------------
// Startup migrations — idempotent DDL changes applied on every restart.
// ---------------------------------------------------------------------------
async function runMigrations(): Promise<void> {
  try {
    // Extend users table with auth columns
    await db.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS name             TEXT,
        ADD COLUMN IF NOT EXISTS password_hash    TEXT,
        ADD COLUMN IF NOT EXISTS active           BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS failed_login_count INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS lockout_until    TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_sign_in_at  TIMESTAMPTZ
    `);

    logger.info("Migration OK: users auth columns ensured");
  } catch (err) {
    logger.warn({ err }, "Migration failed — will retry on next restart");
    return;
  }

  // Seed admin user after migrations succeed
  await seedAdmin();
}

// ---------------------------------------------------------------------------
// Admin seeding — creates/updates the admin user from env vars on every boot.
// Set ADMIN_EMAIL (default dpgaus@outlook.com) and ADMIN_PASSWORD in secrets.
// ---------------------------------------------------------------------------
async function seedAdmin(): Promise<void> {
  const adminEmail = (process.env.ADMIN_EMAIL ?? "dpgaus@outlook.com").toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    logger.warn(
      "ADMIN_PASSWORD is not set — admin account cannot be created or updated. " +
      "Set ADMIN_PASSWORD in Replit Secrets to enable admin login.",
    );
    return;
  }

  try {
    const existing = await db.execute(sql`
      SELECT id, password_hash FROM users WHERE email = ${adminEmail}
    `);

    const row = existing.rows[0] as { id: number; password_hash: string | null } | undefined;

    if (!row) {
      // Create admin user
      const hash = await bcrypt.hash(adminPassword, 12);
      await db.execute(sql`
        INSERT INTO users (email, role, plan, active, name, password_hash)
        VALUES (${adminEmail}, 'admin', 'free', true, 'Admin', ${hash})
        ON CONFLICT (email) DO NOTHING
      `);
      logger.info({ email: adminEmail }, "Admin user created");
    } else if (!row.password_hash) {
      // User exists but has no password — set it
      const hash = await bcrypt.hash(adminPassword, 12);
      await db.execute(sql`
        UPDATE users SET password_hash = ${hash}, role = 'admin', active = true
        WHERE id = ${row.id}
      `);
      logger.info({ email: adminEmail }, "Admin password initialised");
    } else {
      // User exists with a password — re-hash only if ADMIN_PASSWORD changed.
      // We compare against the stored hash to avoid unnecessary bcrypt work.
      const matches = await bcrypt.compare(adminPassword, row.password_hash);
      if (!matches) {
        const hash = await bcrypt.hash(adminPassword, 12);
        await db.execute(sql`
          UPDATE users SET password_hash = ${hash}, role = 'admin', active = true
          WHERE id = ${row.id}
        `);
        logger.info({ email: adminEmail }, "Admin password updated");
      } else {
        logger.info({ email: adminEmail }, "Admin user OK");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Admin seeding failed");
  }
}

// Run after event loop yields so server is fully initialised first
setImmediate(() => { runMigrations().catch(() => {}); });

export default app;
