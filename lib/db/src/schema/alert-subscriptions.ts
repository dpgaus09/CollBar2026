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
import { firmsTable } from "./firms";
import { districtsTable } from "./districts";
import { usersTable } from "./users";

// ---------------------------------------------------------------------------
// Phase 6 — Settlement alerts on tracked districts (firm workspace).
//
// One row per (firm, district, event_type) subscription. When the existing
// on-demand data refresh ingests a new settlement or a new contract (cba_pdf)
// for a subscribed district, the detection service writes exactly one row into
// the shared global `alerts` table (NOT a parallel store). event_type mirrors
// alerts.alert_type ('new_settlement' = a new settlement; 'new_doc' = a new
// contract) so the firm feed is a simple join on (district_id, event_type).
//
// Firm-scoped: belongs to the firm_members / requireFirmSession entitlement
// system, NEVER the per-district CFO gate(). district_id CASCADE so removing a
// district cleans up its subscriptions; created_by SET NULL so a subscription
// survives the creating user's removal.
//
// Dual-declared: the matching idempotent DDL lives in the API server's
// runMigrations() (artifacts/api-server/src/app.ts). Keep both in sync — the
// drift guardrail (pnpm --filter @workspace/db run check-drift) compares the
// column sets of both.
// ---------------------------------------------------------------------------
export const alertSubscriptionsTable = pgTable(
  "alert_subscriptions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    firmId: bigint("firm_id", { mode: "bigint" })
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    districtId: bigint("district_id", { mode: "bigint" })
      .notNull()
      .references(() => districtsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    createdBy: bigint("created_by", { mode: "bigint" }).references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("alert_subscriptions_firm_district_event_unique").on(
      t.firmId,
      t.districtId,
      t.eventType,
    ),
    check(
      "alert_subscriptions_event_type_check",
      sql`${t.eventType} IN ('new_settlement','new_doc')`,
    ),
  ],
);

export type AlertSubscription = typeof alertSubscriptionsTable.$inferSelect;
