import {
  pgTable,
  bigserial,
  bigint,
  text,
  timestamp,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// Firm workspaces (multi-seat attorney / labor-consultant accounts). These run
// PARALLEL to the per-district CFO entitlement system: a firm member is a normal
// `users` row whose workspace access comes from firm_members membership, NOT from
// users.plan / lib/access.ts gate(). The two systems are intentionally separate
// so the existing CFO dashboard gating stays untouched.
//
// Dual-declared: the matching idempotent DDL lives in the API server's
// runMigrations() (artifacts/api-server/src/app.ts). Keep both in sync — the
// drift guardrail (pnpm --filter @workspace/db run check-drift) enforces it.

export const firmsTable = pgTable(
  "firms",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    name: text("name").notNull(),
    // Entitlement tier for the firm's seats: IL-only (state), multi-state
    // (region), or nationwide (national). Defaults to the most limited tier.
    planTier: text("plan_tier").notNull().default("state"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "firms_plan_tier_check",
      sql`${t.planTier} IN ('state','region','national')`,
    ),
  ],
);

export const firmMembersTable = pgTable(
  "firm_members",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    firmId: bigint("firm_id", { mode: "bigint" })
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("firm_members_firm_user_unique").on(t.firmId, t.userId),
    check(
      "firm_members_role_check",
      sql`${t.role} IN ('firm_admin','member')`,
    ),
  ],
);

export const firmInvitesTable = pgTable(
  "firm_invites",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    firmId: bigint("firm_id", { mode: "bigint" })
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    // Only the SHA-256 hash of the random invite token is stored at rest; the
    // raw token lives only in the invite link handed to the new member.
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: bigint("invited_by_user_id", { mode: "bigint" }).references(
      () => usersTable.id,
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("firm_invites_token_hash_unique").on(t.tokenHash),
    check(
      "firm_invites_role_check",
      sql`${t.role} IN ('firm_admin','member')`,
    ),
  ],
);

export type Firm = typeof firmsTable.$inferSelect;
export type FirmMember = typeof firmMembersTable.$inferSelect;
export type FirmInvite = typeof firmInvitesTable.$inferSelect;
