import express, { type Express } from "express";
import cors from "cors";
import session from "express-session";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const app: Express = express();

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
    secret: process.env.SESSION_SECRET || "collbar-dev-session-fallback",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    },
  }),
);

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
