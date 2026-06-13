import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import router from "./routes";
import publicHtmlRouter from "./routes/public-html";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const isProd = process.env.NODE_ENV === "production";

// Fail closed in production — never use a predictable fallback secret
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
  res.setHeader("X-Frame-Options", "DENY");
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
      "frame-ancestors 'none'",
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

// Seed admin user on startup (idempotent)
async function seedAdminUser(): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO users (email, role)
      VALUES ('david@collbar.io', 'admin')
      ON CONFLICT (email) DO NOTHING
    `);
    logger.info("Admin user seed: david@collbar.io ensured");
  } catch (err) {
    logger.warn({ err }, "Failed to seed admin user (will retry on next restart)");
  }
}

seedAdminUser().catch(() => {});

export default app;
