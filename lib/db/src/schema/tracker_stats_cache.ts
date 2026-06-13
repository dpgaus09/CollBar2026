import { pgTable, bigserial, timestamp, jsonb } from "drizzle-orm/pg-core";

export const trackerStatsCacheTable = pgTable("tracker_stats_cache", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  statsJson: jsonb("stats_json").notNull(),
});

export type TrackerStatsCache = typeof trackerStatsCacheTable.$inferSelect;
