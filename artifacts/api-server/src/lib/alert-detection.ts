import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Phase 6 — Settlement alerts detection (firm workspace).
//
// Hooked into the existing on-demand data refresh (settlement promotion + CBA
// upload/bulk-import) — NOT a cron. When a new settlement or contract is
// ingested for a district that some firm subscribes to, write exactly one row
// into the shared global `alerts` table (no parallel store). Idempotency is
// enforced by partial unique indexes on `alerts` (see app.ts runMigrations) +
// ON CONFLICT DO NOTHING, so re-promotion / re-upload never duplicates.
//
// All functions are best-effort: they swallow their own errors so a transient
// alert failure can never break ingestion. A later refresh re-runs detection
// idempotently.
// ---------------------------------------------------------------------------

export interface SettlementAlertInput {
  districtId: string | number;
  bargainingUnit: string;
  fromYear: string;
  toYear: string;
}

function prettyUnit(unit: string): string {
  const s = unit.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Settlement";
}

// Deterministic, immutable machine key for one settlement event. Stored in
// alerts.file_hash (char(64)): the admin acknowledge endpoint rewrites notes
// but never file_hash, and stated settlements are delete+reinserted on
// re-promotion — so a content-derived key (not a row id) is the only stable
// dedup anchor. A sha256 hex digest is exactly 64 chars → fits char(64).
function settlementEventKey(
  districtId: number,
  unit: string,
  fromYear: string,
  toYear: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`settlement:v1:${districtId}:${unit}:${fromYear}:${toYear}`)
    .digest("hex");
}

/**
 * For each settlement ingested for `sourceDocId`, write exactly one
 * 'new_settlement' alert per (district, unit, years) IF some firm subscribes
 * that district to 'new_settlement'. Idempotent via
 * alerts_new_settlement_event_uniq + ON CONFLICT DO NOTHING. Returns the number
 * of alert rows newly written.
 */
export async function recordSettlementAlertsForDoc(
  sourceDocId: number | string,
  settlements: SettlementAlertInput[],
): Promise<number> {
  if (!settlements.length) return 0;
  const docId = Number(sourceDocId);
  if (!Number.isFinite(docId)) return 0;

  let sourceUrl: string | null = null;
  try {
    const r = await db.execute(sql`
      SELECT source_url FROM source_documents WHERE id = ${docId} LIMIT 1
    `);
    sourceUrl = r.rows.length
      ? ((r.rows[0] as { source_url: string | null }).source_url ?? null)
      : null;
  } catch (err) {
    logger.warn({ err, docId }, "alert-detection: source_url lookup failed");
  }

  let inserted = 0;
  for (const s of settlements) {
    const districtId = Number(s.districtId);
    if (!Number.isFinite(districtId)) continue;
    const eventKey = settlementEventKey(
      districtId,
      s.bargainingUnit,
      s.fromYear,
      s.toYear,
    );
    const docName = `${prettyUnit(s.bargainingUnit)} settlement ${s.fromYear}\u2013${s.toYear}`;
    try {
      const res = await db.execute(sql`
        INSERT INTO alerts
          (source_doc_id, district_id, alert_type, doc_name, source_url, file_hash, status, detected_at)
        SELECT ${docId}, ${districtId}, 'new_settlement', ${docName}, ${sourceUrl}, ${eventKey}, 'pending', NOW()
        WHERE EXISTS (
          SELECT 1 FROM alert_subscriptions sub
          WHERE sub.district_id = ${districtId} AND sub.event_type = 'new_settlement'
        )
        ON CONFLICT (file_hash) WHERE alert_type = 'new_settlement' DO NOTHING
        RETURNING id
      `);
      inserted += res.rows.length;
    } catch (err) {
      logger.warn(
        { err, districtId, eventKey },
        "alert-detection: settlement alert insert failed",
      );
    }
  }
  return inserted;
}

export interface NewContractAlertInput {
  sourceDocId: number | string;
  districtId: number | string;
  docName: string;
  sourceUrl: string | null;
  fileHash: string | null;
}

/**
 * Write exactly one 'new_doc' (new contract) alert for a freshly created
 * cba_pdf source document IF some firm subscribes that district to 'new_doc'.
 * Idempotent on source_doc_id via alerts_new_doc_source_uniq + ON CONFLICT.
 * Returns true if an alert row was newly written.
 */
export async function recordNewContractAlert(
  input: NewContractAlertInput,
): Promise<boolean> {
  const docId = Number(input.sourceDocId);
  const districtId = Number(input.districtId);
  if (!Number.isFinite(docId) || !Number.isFinite(districtId)) return false;
  try {
    const res = await db.execute(sql`
      INSERT INTO alerts
        (source_doc_id, district_id, alert_type, doc_name, source_url, file_hash, status, detected_at)
      SELECT ${docId}, ${districtId}, 'new_doc', ${input.docName}, ${input.sourceUrl}, ${input.fileHash}, 'pending', NOW()
      WHERE EXISTS (
        SELECT 1 FROM alert_subscriptions sub
        WHERE sub.district_id = ${districtId} AND sub.event_type = 'new_doc'
      )
      ON CONFLICT (source_doc_id) WHERE alert_type = 'new_doc' AND source_doc_id IS NOT NULL DO NOTHING
      RETURNING id
    `);
    return res.rows.length > 0;
  } catch (err) {
    logger.warn(
      { err, docId, districtId },
      "alert-detection: new-contract alert insert failed",
    );
    return false;
  }
}
