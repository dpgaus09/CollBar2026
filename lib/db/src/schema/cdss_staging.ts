import {
  pgTable,
  bigserial,
  bigint,
  text,
  jsonb,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { districtsTable } from "./districts";

export const cdssStagingTable = pgTable(
  "cdss_staging",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    rawJson: jsonb("raw_json"),
    sourceUrl: text("source_url"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).defaultNow(),
    districtNameRaw: text("district_name_raw"),
    districtId: bigint("district_id", { mode: "bigint" }).references(
      () => districtsTable.id,
    ),
    loadedAt: timestamp("loaded_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    notes: text("notes"),
  },
  (t) => [
    check(
      "cdss_staging_status_check",
      sql`${t.status} IN ('pending', 'matched', 'loaded', 'error')`,
    ),
  ],
);

export type CdssStaging = typeof cdssStagingTable.$inferSelect;
