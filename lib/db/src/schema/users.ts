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
