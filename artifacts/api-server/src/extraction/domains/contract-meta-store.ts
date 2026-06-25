// Contract-metadata projection (Task #175 follow-up): write a document's extracted
// title/affiliation/term onto its contracts row(s) on promote.
//
// Scoped to ONE source document: UPDATE every contracts row WHERE source_doc_id =
// the doc. Unlike the delete-then-insert domains, this is a COALESCE update — a
// null extracted value NEVER wipes existing data (we only ever fill in or correct
// a field the model actually found). This makes the store idempotent: re-promoting
// the same version is a no-op.
//
// effective_start is part of UNIQUE(district_id, bargaining_unit, unit_scope,
// effective_start) and starts life as a school-year placeholder (YYYY-07-01).
// Overwriting it with the true contract start gives a correct term display. For
// uploaded docs unit_scope is NULL, so the unique key never matches (NULLs are
// distinct) and the overwrite is collision-free; for the rare crawled contract
// where another row already holds the target key we attempt the full update inside
// a SAVEPOINT and, on unique violation, retry WITHOUT effective_start (keep the
// existing start; still apply title/expiration/term).

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import type { ContractMeta } from "./contract-meta";

interface MetaTarget {
  id: string;
  districtId: string | null;
  bargainingUnit: string;
  unitScope: string | null;
}

export interface ContractMetaStoreResult {
  matched: number; // contract rows for this doc
  updated: number; // rows actually written (promote "targets")
  startApplied: number; // rows where effective_start was overwritten
  startSkipped: number; // rows where the effective_start overwrite hit a unique conflict
}

async function fetchMetaTargets(
  sourceDocId: number | string,
): Promise<MetaTarget[]> {
  const res = await db.execute(sql`
    SELECT id::text                              AS "id",
           district_id::text                     AS "districtId",
           COALESCE(bargaining_unit, 'teachers') AS "bargainingUnit",
           unit_scope                            AS "unitScope"
    FROM contracts
    WHERE source_doc_id = ${sourceDocId}
    ORDER BY id
  `);
  return res.rows.map((r) => r as unknown as MetaTarget);
}

function hasAnyValue(meta: ContractMeta): boolean {
  return (
    meta.unionName != null ||
    meta.affiliation != null ||
    meta.effectiveStart != null ||
    meta.effectiveEnd != null ||
    meta.termYears != null
  );
}

export async function storeContractMetaForDoc(
  sourceDocId: number | string,
  meta: ContractMeta,
  opts?: { dryRun?: boolean },
): Promise<ContractMetaStoreResult> {
  const dryRun = opts?.dryRun ?? false;
  const targets = await fetchMetaTargets(sourceDocId);
  const empty: ContractMetaStoreResult = {
    matched: targets.length,
    updated: 0,
    startApplied: 0,
    startSkipped: 0,
  };
  if (!targets.length) return { ...empty, matched: 0 };
  // An all-null extraction has nothing to write — leave existing data untouched
  // and report zero targets so the caller surfaces it for review.
  if (!hasAnyValue(meta)) return empty;

  if (dryRun) {
    let startApplied = 0;
    let startSkipped = 0;
    if (meta.effectiveStart != null) {
      for (const t of targets) {
        // unit_scope NULL => the unique key never matches (NULLs distinct) => safe.
        if (t.unitScope == null) {
          startApplied++;
          continue;
        }
        const conflict = await db.execute(sql`
          SELECT 1 FROM contracts x
          WHERE x.district_id = ${t.districtId}
            AND x.bargaining_unit = ${t.bargainingUnit}
            AND x.unit_scope = ${t.unitScope}
            AND x.effective_start = ${meta.effectiveStart}::date
            AND x.id <> ${t.id}
          LIMIT 1
        `);
        if (conflict.rows.length) startSkipped++;
        else startApplied++;
      }
    }
    return {
      matched: targets.length,
      updated: targets.length,
      startApplied,
      startSkipped,
    };
  }

  return db.transaction(async (tx) => {
    let updated = 0;
    let startApplied = 0;
    let startSkipped = 0;

    for (const t of targets) {
      let applied = false;
      try {
        // Nested transaction => SAVEPOINT: a unique-constraint violation from
        // changing effective_start must not abort the whole projection.
        await tx.transaction(async (tx2) => {
          await tx2.execute(sql`
            UPDATE contracts SET
              union_name      = COALESCE(${meta.unionName}::text, union_name),
              affiliation     = COALESCE(${meta.affiliation}::text, affiliation),
              effective_start = COALESCE(${meta.effectiveStart}::date, effective_start),
              effective_end   = COALESCE(${meta.effectiveEnd}::date, effective_end),
              term_years      = COALESCE(${meta.termYears}::numeric, term_years)
            WHERE id = ${t.id}
          `);
        });
        updated++;
        if (meta.effectiveStart != null) startApplied++;
        applied = true;
      } catch (err) {
        logger.warn(
          { err, contractId: t.id, sourceDocId },
          "contract_meta: full update failed (likely effective_start unique conflict); retrying without effective_start",
        );
      }

      if (!applied) {
        // Retry on the OUTER tx (savepoint already rolled back) without touching
        // effective_start — keep the existing start, still apply the rest.
        try {
          const r = await tx.execute(sql`
            UPDATE contracts SET
              union_name    = COALESCE(${meta.unionName}::text, union_name),
              affiliation   = COALESCE(${meta.affiliation}::text, affiliation),
              effective_end = COALESCE(${meta.effectiveEnd}::date, effective_end),
              term_years    = COALESCE(${meta.termYears}::numeric, term_years)
            WHERE id = ${t.id}
          `);
          if ((r.rowCount ?? 0) > 0) {
            updated++;
            if (meta.effectiveStart != null) startSkipped++;
          }
        } catch (err) {
          logger.error(
            { err, contractId: t.id, sourceDocId },
            "contract_meta: store failed for contract",
          );
        }
      }
    }

    if (startSkipped) {
      logger.info(
        { sourceDocId, startSkipped },
        "contract_meta: kept existing effective_start on row(s) where the extracted start collided with the unique key",
      );
    }
    return { matched: targets.length, updated, startApplied, startSkipped };
  });
}
