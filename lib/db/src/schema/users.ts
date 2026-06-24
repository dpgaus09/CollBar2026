import {
  pgTable,
  bigserial,
  bigint,
  text,
  boolean,
  integer,
  timestamp,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { districtsTable } from "./districts";

export const usersTable = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    email: text("email").notNull(),
    role: text("role").default("district_user"),
    plan: text("plan").default("free").notNull(),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // Auth columns. Created idempotently by the API server's runMigrations()
    // (artifacts/api-server/src/app.ts); declared here so the Drizzle schema
    // stays in sync with the live database (enforced by the schema-drift
    // guardrail: pnpm --filter @workspace/db run check-drift).
    name: text("name"),
    passwordHash: text("password_hash"),
    active: boolean("active").notNull().default(true),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockoutUntil: timestamp("lockout_until", { withTimezone: true }),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  },
  (t) => [
    unique().on(t.email),
    check(
      "users_role_check",
      sql`${t.role} IN ('admin','district_user')`,
    ),
    check(
      "users_plan_check",
      sql`${t.plan} IN ('free','pro')`,
    ),
  ],
);

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
