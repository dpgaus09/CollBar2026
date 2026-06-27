import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Firm workspace district scope.
//
// The full set of districts a firm may work with: everything on its roster
// (tracked_districts) plus every district attached to one of its matters. Shared
// by the cross-district comparison matrix (firm-compare) and clause search /
// compare (firm-clauses) to authorize an explicit districtIds request and to
// define the "entire workspace" scope. The matterId path is authorized
// separately by firm ownership of the matter itself.
//
// Keeping clause search inside this scope guarantees every returned clause's
// source PDF is reachable through GET /api/firm/document (which authorizes by
// this same roster ∪ matters scope).
// ---------------------------------------------------------------------------
export async function firmScopeDistrictIds(
  firmId: number,
): Promise<Set<number>> {
  const r = await db.execute(sql`
    SELECT district_id FROM tracked_districts WHERE firm_id = ${firmId}
    UNION
    SELECT md.district_id
    FROM matter_districts md
    JOIN matters m ON m.id = md.matter_id
    WHERE m.firm_id = ${firmId}
  `);
  return new Set(
    (r.rows as Array<{ district_id: unknown }>).map((row) =>
      Number(row.district_id),
    ),
  );
}
