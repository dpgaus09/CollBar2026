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

// CORS — restrict credentialed cross-origin requests to known frontend
// origins. In dev the frontend reaches the API same-origin through the Vite
// proxy, so no Origin header is sent; non-browser requests (curl, server-to-
// server) also omit it and are allowed. Unknown browser origins simply receive
// no CORS headers (the browser then blocks the response) rather than a 500.
const allowedOrigins = new Set(
  [
    ...(process.env.FRONTEND_URL ?? "http://localhost:5173")
      .split(",")
      .map((o) => o.trim()),
    process.env.APP_URL,
  ].filter((o): o is string => !!o),
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  }),
);
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

    // Persisted "Ask CollBar" conversations (threads survive refresh/re-login).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS conversations (
        id          bigserial PRIMARY KEY,
        user_id     bigint NOT NULL REFERENCES users(id),
        title       text NOT NULL,
        created_at  timestamptz DEFAULT NOW(),
        updated_at  timestamptz DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
        ON conversations (user_id, updated_at)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS messages (
        id              bigserial PRIMARY KEY,
        conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            text NOT NULL,
        content         text NOT NULL,
        results         jsonb,
        created_at      timestamptz DEFAULT NOW(),
        CONSTRAINT messages_role_check CHECK (role IN ('user','assistant'))
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
        ON messages (conversation_id, created_at)
    `);

    logger.info("Migration OK: conversations + messages ensured");

    // IL statutory minimum full-time teacher salary (CGFA, PA 103-515).
    // State-level reference data; one row per certification keyed by school year.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS il_min_teacher_salary (
        id                   bigserial PRIMARY KEY,
        school_year          text NOT NULL UNIQUE,
        prior_year           text,
        prior_year_rate      integer,
        percentage_increase  numeric(6,3),
        new_year_rate        integer NOT NULL,
        certified_date       date,
        source_url           text,
        file_hash            text,
        created_at           timestamptz DEFAULT NOW(),
        updated_at           timestamptz DEFAULT NOW()
      )
    `);

    logger.info("Migration OK: il_min_teacher_salary ensured");

    // Durable last-run status for background syncs (e.g. the annual IL minimum
    // teacher salary ingest). One row per sync keyed by name; survives API
    // server restarts so a failed once-a-year run still flags months later.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sync_run_status (
        sync_name   text PRIMARY KEY,
        status      text NOT NULL,
        run_at      timestamptz NOT NULL DEFAULT NOW(),
        log_ref     text,
        detail      text,
        updated_at  timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    logger.info("Migration OK: sync_run_status ensured");
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
