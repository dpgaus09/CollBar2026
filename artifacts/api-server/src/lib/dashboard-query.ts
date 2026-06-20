import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Shared dashboard query helpers.
//
// These helpers are used by both the dashboard routes and the AI "ask"
// tool executors so that natural-language search obeys exactly the same
// scoping/banding rules as the rest of the customer-facing dashboard.
// ---------------------------------------------------------------------------

// CollBar's customer-facing dashboard is Illinois-only. Out-of-state districts
// (e.g. Ohio) are retained in the database for back-office use but must never
// surface in the customer view — lists, medians, comparables, the county /
// district-type filter dropdowns, or a directly-requested district detail.
// Every customer-facing state filter routes through this single constant.
export const CUSTOMER_STATE = "IL";

export function enrollmentBand(enrollment: number | null): string {
  if (!enrollment || enrollment <= 0) return "unknown";
  if (enrollment < 500) return "tiny";
  if (enrollment < 1000) return "small";
  if (enrollment < 2500) return "medium";
  if (enrollment < 5000) return "large";
  return "xlarge";
}

export function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86_400_000);
}

export function bandSql(band: string): SQL | null {
  const map: Record<string, SQL> = {
    tiny: sql`d.enrollment < 500`,
    small: sql`d.enrollment BETWEEN 500 AND 999`,
    medium: sql`d.enrollment BETWEEN 1000 AND 2499`,
    large: sql`d.enrollment BETWEEN 2500 AND 4999`,
    xlarge: sql`d.enrollment >= 5000`,
  };
  return map[band] ?? null;
}

export function buildWhere(conditions: Array<SQL | null | undefined>): SQL {
  const parts = conditions.filter(Boolean) as SQL[];
  if (parts.length === 0) return sql`1=1`;
  return sql.join(parts, sql` AND `);
}

// Guard for per-district child endpoints. Returns true only when the district
// exists AND belongs to the customer-facing state, so an authenticated user
// cannot read another state's data by passing its district id directly.
export async function isCustomerDistrict(districtId: number): Promise<boolean> {
  const r = await db.execute(
    sql`SELECT 1 FROM districts WHERE id = ${districtId} AND state = ${CUSTOMER_STATE} LIMIT 1`,
  );
  return r.rows.length > 0;
}
