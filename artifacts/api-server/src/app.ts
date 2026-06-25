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

    // One row per successful sign-in. Powers per-customer login counts and the
    // "rank by activity" view in the admin Customers page. last_sign_in_at on
    // users still holds the most-recent timestamp; this table holds the history.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS login_events (
        id          bigserial PRIMARY KEY,
        user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS login_events_user_id_idx ON login_events(user_id)
    `);

    logger.info("Migration OK: login_events table ensured");

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

    // -----------------------------------------------------------------------
    // IL ELRB board-vs-union final offers (Task #112).
    //
    // 1. Allow source_documents.doc_type = 'final_offer' (the scraped offer
    //    PDFs). Adding a value to the IN-list only widens the constraint, so
    //    every existing row stays valid. DROP/ADD keeps it idempotent.
    // 2. Create the three final-offer tables (postings / items / comparisons).
    // -----------------------------------------------------------------------
    await db.execute(sql`
      ALTER TABLE source_documents
        DROP CONSTRAINT IF EXISTS source_documents_doc_type_check
    `);
    await db.execute(sql`
      ALTER TABLE source_documents
        ADD CONSTRAINT source_documents_doc_type_check
        CHECK (doc_type IN (
          'cba_pdf','mou','factfinding_report','wage_settlement_report',
          'cdss_extract','directory','stats','policy_manual','non_cba',
          'final_offer'
        ))
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS final_offer_postings (
        id                     bigserial PRIMARY KEY,
        district_id            bigint REFERENCES districts(id),
        case_number            text NOT NULL,
        year                   integer NOT NULL,
        bargaining_unit        text NOT NULL DEFAULT 'teachers',
        district_name          text,
        union_name             text,
        posted_date            timestamptz,
        district_offer_url     text,
        union_offer_url        text,
        district_source_doc_id bigint REFERENCES source_documents(id),
        union_source_doc_id    bigint REFERENCES source_documents(id),
        page_url               text,
        created_at             timestamptz DEFAULT NOW(),
        updated_at             timestamptz DEFAULT NOW(),
        CONSTRAINT final_offer_postings_case_number_unique UNIQUE (case_number)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS final_offer_postings_district_idx
        ON final_offer_postings (district_id)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS final_offer_items (
        id            bigserial PRIMARY KEY,
        posting_id    bigint NOT NULL REFERENCES final_offer_postings(id) ON DELETE CASCADE,
        side          text NOT NULL,
        topic         text NOT NULL,
        topic_label   text,
        summary       text,
        numeric_value numeric(14,4),
        numeric_unit  text,
        raw_text      text,
        source_doc_id bigint REFERENCES source_documents(id),
        created_at    timestamptz DEFAULT NOW(),
        CONSTRAINT final_offer_items_posting_side_topic_unique UNIQUE (posting_id, side, topic),
        CONSTRAINT final_offer_items_side_check CHECK (side IN ('district','union'))
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS final_offer_items_posting_idx
        ON final_offer_items (posting_id)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS final_offer_comparisons (
        id               bigserial PRIMARY KEY,
        posting_id       bigint NOT NULL REFERENCES final_offer_postings(id) ON DELETE CASCADE,
        topic            text NOT NULL,
        topic_label      text,
        status           text NOT NULL,
        district_item_id bigint REFERENCES final_offer_items(id),
        union_item_id    bigint REFERENCES final_offer_items(id),
        district_summary text,
        union_summary    text,
        numeric_gap      numeric(14,4),
        gap_unit         text,
        created_at       timestamptz DEFAULT NOW(),
        CONSTRAINT final_offer_comparisons_posting_topic_unique UNIQUE (posting_id, topic),
        CONSTRAINT final_offer_comparisons_status_check
          CHECK (status IN ('aligned','diff','district_only','union_only'))
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS final_offer_comparisons_posting_idx
        ON final_offer_comparisons (posting_id)
    `);

    logger.info("Migration OK: final_offer tables ensured");

    // -----------------------------------------------------------------------
    // District self-verification of settlement figures (Task #152).
    // Additive columns — who confirmed a settlement read, which user, and when.
    // 'district' = confirmed by the owning district; 'internal' = CollBar admin.
    // ADD COLUMN IF NOT EXISTS keeps this safe to run on every restart and on
    // a fresh DB built from migrations alone.
    // -----------------------------------------------------------------------
    await db.execute(sql`
      ALTER TABLE settlements
        ADD COLUMN IF NOT EXISTS verified_by         TEXT,
        ADD COLUMN IF NOT EXISTS verified_by_user_id BIGINT,
        ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ
    `);

    logger.info("Migration OK: settlements verification columns ensured");

    // -----------------------------------------------------------------------
    // Admin manual override of a contract's bargaining unit (Task #158).
    // Additive flag, default false. When true, the pipeline's auto-classifier
    // (backfill_contract_units) skips the row so an admin's correction sticks.
    // ADD COLUMN IF NOT EXISTS keeps this safe on every restart and on a fresh
    // DB built from migrations alone.
    // -----------------------------------------------------------------------
    await db.execute(sql`
      ALTER TABLE contracts
        ADD COLUMN IF NOT EXISTS unit_override BOOLEAN NOT NULL DEFAULT false
    `);

    logger.info("Migration OK: contracts.unit_override ensured");

    // -----------------------------------------------------------------------
    // TS-native extraction engine cache (Task #174). Operational cache table
    // (managed here like login_events / sync_run_status, not by Drizzle). One
    // row per (file_hash, request_hash) — the deterministic key for a vision
    // extraction call (domain + model + prompt/render versions + render params).
    // Lets bulk re-runs skip already-paid Claude calls and records token usage
    // and estimated cost per call for the cost estimator. Additive + idempotent.
    // -----------------------------------------------------------------------
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS vision_extraction_cache (
        id                 bigserial PRIMARY KEY,
        file_hash          text NOT NULL,
        request_hash       text NOT NULL,
        domain             text NOT NULL,
        model              text NOT NULL,
        model_version      text NOT NULL,
        prompt_version     text NOT NULL,
        render_version     text NOT NULL,
        page_set           text NOT NULL DEFAULT '*',
        status             text NOT NULL DEFAULT 'success',
        error              text,
        raw_response       text,
        normalized         jsonb,
        input_tokens       integer NOT NULL DEFAULT 0,
        output_tokens      integer NOT NULL DEFAULT 0,
        estimated_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
        finish_reason      text,
        created_at         timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT vision_extraction_cache_key_unique UNIQUE (file_hash, request_hash),
        CONSTRAINT vision_extraction_cache_status_check CHECK (status IN ('success','failure'))
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS vision_extraction_cache_file_domain_idx
        ON vision_extraction_cache (file_hash, domain)
    `);

    logger.info("Migration OK: vision_extraction_cache ensured");

    // -----------------------------------------------------------------------
    // In-process extraction job queue + immutable versions + promotion pointer
    // (Task #175). Operational tables (managed here like vision_extraction_cache,
    // not by Drizzle). The worker (src/extraction/jobs/worker.ts) runs Claude
    // Vision extraction IN PROCESS — no Python shell-out, no detached process —
    // and records every run as an immutable extraction_versions row. Live domain
    // tables hold only the PROMOTED projection (written by the existing store
    // functions on promote), so customer reads are unchanged. Additive +
    // idempotent.
    // -----------------------------------------------------------------------
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS extraction_jobs (
        id             bigserial PRIMARY KEY,
        source_doc_id  bigint NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
        domain         text NOT NULL,
        status         text NOT NULL DEFAULT 'queued',
        priority       integer NOT NULL DEFAULT 100,
        attempts       integer NOT NULL DEFAULT 0,
        max_attempts   integer NOT NULL DEFAULT 1,
        model          text,
        requested_by   text,
        request_reason text,
        error          text,
        result         jsonb,
        leased_at      timestamptz,
        started_at     timestamptz,
        finished_at    timestamptz,
        created_at     timestamptz NOT NULL DEFAULT NOW(),
        updated_at     timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT extraction_jobs_domain_check CHECK (domain IN ('salary','provisions','cba','settlement','final_offer','contract_meta')),
        CONSTRAINT extraction_jobs_status_check CHECK (status IN ('queued','running','done','failed','canceled'))
      )
    `);
    // At most one ACTIVE (queued|running) job per source document — enforces the
    // "one job per doc" enqueue dedupe at the DB level (a 'cba' job covers both
    // domains, so we never run overlapping work for the same document).
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS extraction_jobs_active_doc_uniq
        ON extraction_jobs (source_doc_id)
        WHERE status IN ('queued','running')
    `);
    // Claim ordering: lowest priority value first, then oldest.
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS extraction_jobs_claim_idx
        ON extraction_jobs (priority, id)
        WHERE status = 'queued'
    `);

    // Immutable per-(doc,domain) extraction results. One row per successful job
    // (audit trail). normalized = the domain payload ({schedules:[...]} or
    // {contracts:[...]}); summary = counts/confidence/cost. duplicate_of_version_id
    // links a re-run that produced byte-identical output to its predecessor.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS extraction_versions (
        id                      bigserial PRIMARY KEY,
        source_doc_id           bigint NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
        domain                  text NOT NULL,
        job_id                  bigint REFERENCES extraction_jobs(id) ON DELETE SET NULL,
        file_hash               text,
        model                   text,
        model_version           text,
        prompt_version          text,
        render_version          text,
        result_hash             text NOT NULL,
        normalized              jsonb NOT NULL,
        summary                 jsonb NOT NULL,
        status                  text NOT NULL DEFAULT 'success',
        duplicate_of_version_id bigint REFERENCES extraction_versions(id) ON DELETE SET NULL,
        created_by              text,
        created_at              timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT extraction_versions_domain_check CHECK (domain IN ('salary','provisions','settlement','final_offer','contract_meta'))
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS extraction_versions_doc_idx
        ON extraction_versions (source_doc_id, domain, created_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS extraction_versions_hash_idx
        ON extraction_versions (source_doc_id, domain, result_hash)
    `);

    // The currently-promoted version per (doc, domain). The live domain tables
    // mirror exactly these versions; promoting flips the pointer and re-projects
    // via the existing store functions.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS extraction_promotions (
        source_doc_id       bigint NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
        domain              text NOT NULL,
        version_id          bigint NOT NULL REFERENCES extraction_versions(id),
        previous_version_id bigint REFERENCES extraction_versions(id),
        promoted_by         text,
        promoted_at         timestamptz NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source_doc_id, domain),
        CONSTRAINT extraction_promotions_domain_check CHECK (domain IN ('salary','provisions','settlement','final_offer','contract_meta'))
      )
    `);

    // Widen the per-(doc,domain) CHECK constraints on EXISTING databases. The
    // CREATE TABLE IF NOT EXISTS above only applies to a fresh DB; on an existing
    // one the original (salary,provisions[,cba]) constraint persists, which would
    // reject settlement / final_offer / contract_meta version & promotion rows.
    // Adding values to an IN-list only widens the constraint, so every existing
    // row stays valid; DROP/ADD keeps it idempotent across restarts.
    await db.execute(sql`
      ALTER TABLE extraction_jobs DROP CONSTRAINT IF EXISTS extraction_jobs_domain_check
    `);
    await db.execute(sql`
      ALTER TABLE extraction_jobs ADD CONSTRAINT extraction_jobs_domain_check
        CHECK (domain IN ('salary','provisions','cba','settlement','final_offer','contract_meta'))
    `);
    await db.execute(sql`
      ALTER TABLE extraction_versions DROP CONSTRAINT IF EXISTS extraction_versions_domain_check
    `);
    await db.execute(sql`
      ALTER TABLE extraction_versions ADD CONSTRAINT extraction_versions_domain_check
        CHECK (domain IN ('salary','provisions','settlement','final_offer','contract_meta'))
    `);
    await db.execute(sql`
      ALTER TABLE extraction_promotions DROP CONSTRAINT IF EXISTS extraction_promotions_domain_check
    `);
    await db.execute(sql`
      ALTER TABLE extraction_promotions ADD CONSTRAINT extraction_promotions_domain_check
        CHECK (domain IN ('salary','provisions','settlement','final_offer','contract_meta'))
    `);

    logger.info("Migration OK: extraction job queue + versions + promotions ensured");
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
