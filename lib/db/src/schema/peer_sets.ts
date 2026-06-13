import {
  pgTable,
  bigserial,
  bigint,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const peerSetsTable = pgTable("peer_sets", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  userId: bigint("user_id", { mode: "bigint" })
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  districtIds: bigint("district_ids", { mode: "bigint" })
    .array()
    .notNull()
    .default(sql`'{}'`),
  filtersJson: jsonb("filters_json").notNull().default(sql`'{}'`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PeerSet = typeof peerSetsTable.$inferSelect;
