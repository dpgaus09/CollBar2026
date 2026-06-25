// Settlement projection (Task #176): write a document's derived 'stated'
// settlement rows into the live `settlements` table on promote.
//
// Scoped to ONE source document: delete this doc's existing method='stated' rows,
// then insert the freshly derived ones. ON CONFLICT DO NOTHING protects rows
// owned by other methods/docs that already occupy the
// (district_id, bargaining_unit, from_year, to_year) unique key — chiefly
// 'tss_diff' settlements, which the Python pipeline owns and we must never clobber.
//
// Each insert runs in its own SAVEPOINT (nested transaction) so a single bad row
// cannot abort the whole projection.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import type { DerivedSettlement } from "../types";

export interface SettlementStoreResult {
  inserted: number; // rows written
  conflicts: number; // skipped — key already held by another method/doc
  errors: number; // rows that threw (rolled back via savepoint)
}

export async function storeSettlementsForDoc(
  sourceDocId: number | string,
  settlements: DerivedSettlement[],
  opts?: { dryRun?: boolean },
): Promise<SettlementStoreResult> {
  const dryRun = opts?.dryRun ?? false;
  if (dryRun) {
    return { inserted: settlements.length, conflicts: 0, errors: 0 };
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM settlements
      WHERE source_doc_id = ${sourceDocId} AND method = 'stated'
    `);

    let inserted = 0;
    let conflicts = 0;
    let errors = 0;

    for (const s of settlements) {
      try {
        // Nested transaction → SAVEPOINT: one overflowing/odd row must not roll
        // back every other settlement for the doc.
        await tx.transaction(async (tx2) => {
          const r = await tx2.execute(sql`
            INSERT INTO settlements
              (district_id, bargaining_unit, from_year, to_year, base_increase_pct,
               year2_pct, year3_pct, off_schedule_payment, term_years, method,
               confidence, contract_id, source_doc_id)
            VALUES (${s.districtId}, ${s.bargainingUnit}, ${s.fromYear}, ${s.toYear},
               ${s.baseIncreasePct}, ${s.year2Pct}, ${s.year3Pct},
               ${s.offSchedulePayment}, ${s.termYears}, 'stated', ${s.confidence},
               ${s.contractId}, ${sourceDocId})
            ON CONFLICT (district_id, bargaining_unit, from_year, to_year)
              DO NOTHING
          `);
          if ((r.rowCount ?? 0) > 0) inserted++;
          else conflicts++;
        });
      } catch (err) {
        errors++;
        logger.warn(
          { err, contractId: s.contractId, sourceDocId },
          "settlement store: row failed (rolled back via savepoint)",
        );
      }
    }

    return { inserted, conflicts, errors };
  });
}
