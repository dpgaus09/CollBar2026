import {
  pgTable,
  bigserial,
  bigint,
  text,
  timestamp,
  unique,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { firmsTable } from "./firms";
import { districtsTable } from "./districts";
import { usersTable } from "./users";

// ---------------------------------------------------------------------------
// Phase 2 — Client roster & matters (firm workspace selection sets).
//
// These belong to the firm workspace entitlement system (firm_members /
// requireFirmSession), NOT the per-district CFO gate(). Every row is firm-scoped
// and every read/write must enforce firm ownership server-side.
//
// Dual-declared: the matching idempotent DDL lives in the API server's
// runMigrations() (artifacts/api-server/src/app.ts). Keep both in sync — the
// drift guardrail (pnpm --filter @workspace/db run check-drift) compares the
// column sets of both.
// ---------------------------------------------------------------------------

// The districts a firm is tracking — its "book of clients". One row per
// (firm, district); the label is an optional free-text note for the firm.
export const trackedDistrictsTable = pgTable(
  "tracked_districts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    firmId: bigint("firm_id", { mode: "bigint" })
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    districtId: bigint("district_id", { mode: "bigint" })
      .notNull()
      .references(() => districtsTable.id, { onDelete: "cascade" }),
    label: text("label"),
    createdBy: bigint("created_by", { mode: "bigint" }).references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("tracked_districts_firm_district_unique").on(t.firmId, t.districtId),
  ],
);

// A matter: a piece of work centered on one client district, paired with peer
// districts. The client is stored canonically as primary_district_id (fast for
// lists/display) AND as a matter_districts row with role 'client' (the role
// set); the routes keep the two in sync inside transactions.
export const mattersTable = pgTable(
  "matters",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    firmId: bigint("firm_id", { mode: "bigint" })
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    primaryDistrictId: bigint("primary_district_id", {
      mode: "bigint",
    }).references(() => districtsTable.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    createdBy: bigint("created_by", { mode: "bigint" }).references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("matters_status_check", sql`${t.status} IN ('active','archived')`),
  ],
);

// The districts attached to a matter, each tagged client or peer. Composite PK
// on (matter_id, district_id) means a district appears at most once per matter.
// A partial unique index (in runMigrations) further enforces one 'client' row
// per matter.
export const matterDistrictsTable = pgTable(
  "matter_districts",
  {
    matterId: bigint("matter_id", { mode: "bigint" })
      .notNull()
      .references(() => mattersTable.id, { onDelete: "cascade" }),
    districtId: bigint("district_id", { mode: "bigint" })
      .notNull()
      .references(() => districtsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.matterId, t.districtId] }),
    check("matter_districts_role_check", sql`${t.role} IN ('client','peer')`),
  ],
);

export type TrackedDistrict = typeof trackedDistrictsTable.$inferSelect;
export type Matter = typeof mattersTable.$inferSelect;
export type MatterDistrict = typeof matterDistrictsTable.$inferSelect;
