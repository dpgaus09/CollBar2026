import {
  pgTable,
  bigserial,
  bigint,
  text,
  boolean,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { districtsTable } from "./districts";

export const approvedCustomersTable = pgTable(
  "approved_customers",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    active: boolean("active").default(true).notNull(),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  },
  (t) => [unique().on(t.email)],
);

export type ApprovedCustomer = typeof approvedCustomersTable.$inferSelect;
