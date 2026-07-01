// Shared CBA ingest primitives for the HERMES off-platform pipeline (Task #248)
// and the existing in-app manual upload. Two admin endpoints reuse these:
//   - POST /admin/extraction/link-pdf : persist an uploaded PDF + link it to a
//     district WITHOUT queuing extraction.
//   - POST /admin/extraction/import   : import externally-produced normalized
//     JSON through the existing version+promote pipeline.
//
// The app stays the system of record: every uploaded PDF is persisted to Object
// Storage (the only source that exists in production — the local filesystem is
// dev-only and autoscale instances are stateless), and each document/contract is
// deduped so re-submitting the same file/unit is idempotent.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger.js";
import { uploadBuffer, uploadedCbaKey } from "./objectStorage.js";
import { recordNewContractAlert } from "./alert-detection.js";
import { CUSTOMER_STATE } from "./dashboard-query.js";

// Thrown when the required Object Storage write fails. Callers map this to a 502
// and record NO source_documents row — a row whose only copy was local: would
// 404 ("Document file missing") in production.
export class ObjectStorageWriteError extends Error {
  constructor(cause?: unknown) {
    super("Could not persist the PDF to durable storage");
    this.name = "ObjectStorageWriteError";
    (this as { cause?: unknown }).cause = cause;
  }
}

// ---------------------------------------------------------------------------
// District resolution
// ---------------------------------------------------------------------------

export interface DistrictIdentity {
  districtId?: number | string | null;
  rcdts?: string | null;
  name?: string | null;
  state?: string | null;
}

export interface ResolvedDistrict {
  id: number;
  name: string;
  state: string;
}

// Resolve a district by internal id, RCDTS (state_district_id), or name. All
// lookups are pinned to CUSTOMER_STATE (IL); a caller-supplied non-IL state is
// rejected. Returns null when no district matches — callers surface a clear
// per-item error.
export async function resolveDistrictDb(
  idn: DistrictIdentity,
): Promise<ResolvedDistrict | null> {
  // HERMES ingest is customer-state (IL) only. `state` is caller-controlled, so a
  // supplied value other than CUSTOMER_STATE is rejected outright — otherwise an
  // envelope could pair a non-IL district (id / RCDTS / name) with its own state
  // and resolve a district outside the customer's state.
  if (idn.state != null && String(idn.state).trim() !== "") {
    const supplied = String(idn.state).trim().toUpperCase().slice(0, 2);
    if (supplied !== CUSTOMER_STATE) return null;
  }
  const state = CUSTOMER_STATE;

  // 1) Internal id (most precise). Still scoped to state (default CUSTOMER_STATE)
  //    so a caller can never link/import against a non-IL district by id.
  if (idn.districtId != null && String(idn.districtId).trim() !== "") {
    const id = parseInt(String(idn.districtId), 10);
    if (!Number.isNaN(id) && id > 0) {
      const r = await db.execute(sql`
        SELECT id, name, state FROM districts WHERE id = ${id} AND state = ${state}
      `);
      if (r.rows.length) return rowToDistrict(r.rows[0]);
    }
  }

  // 2) RCDTS (state_district_id). Match exact, then digits-only (formatting
  //    varies: dashes / leading zeros).
  if (idn.rcdts != null && String(idn.rcdts).trim() !== "") {
    const raw = String(idn.rcdts).trim();
    const digits = raw.replace(/\D/g, "");
    const r = await db.execute(sql`
      SELECT id, name, state FROM districts
      WHERE state = ${state}
        AND (state_district_id = ${raw}
             OR (${digits} <> '' AND regexp_replace(state_district_id, '\\D', '', 'g') = ${digits}))
      LIMIT 1
    `);
    if (r.rows.length) return rowToDistrict(r.rows[0]);
  }

  // 3) Name + state (case-insensitive exact match).
  if (idn.name != null && String(idn.name).trim() !== "") {
    const name = String(idn.name).trim();
    const r = await db.execute(sql`
      SELECT id, name, state FROM districts
      WHERE state = ${state} AND lower(name) = lower(${name})
      ORDER BY id
      LIMIT 1
    `);
    if (r.rows.length) return rowToDistrict(r.rows[0]);
  }

  return null;
}

function rowToDistrict(row: unknown): ResolvedDistrict {
  const r = row as { id: number | string; name: string; state: string };
  return { id: Number(r.id), name: r.name, state: r.state };
}

// ---------------------------------------------------------------------------
// Contract attach (shared with the manual upload route in admin.ts)
// ---------------------------------------------------------------------------

// Arbitrary namespace for the per-source-doc contract-attach advisory lock. Two
// callers carrying the SAME contract bytes dedup onto ONE source doc and can then
// race this attach concurrently. The contracts unique index is
// (district_id, bargaining_unit, unit_scope, effective_start) and unit_scope is
// NULL for uploads, so Postgres treats the two rows as DISTINCT (NULL != NULL)
// and ON CONFLICT DO NOTHING would NOT collapse them → two contracts for one
// doc. Serialise the SELECT+INSERT per source doc so the second caller sees the
// first's row and reuses it instead of inserting a duplicate.
export const CONTRACT_ATTACH_LOCK_NS = 0x63626161; // "cbaa"

// Ensure a minimal contracts row exists for an uploaded document so a later
// promotion can ATTACH extracted salary/provisions to it (the store functions
// match on contracts.source_doc_id). unit_scope is left NULL so the
// (district, unit, scope, start) unique key never collides with a crawled
// contract — each distinct upload gets its own attachable row. effective_start
// is derived from the school year when available.
export async function ensureContractForUpload(
  sourceDocId: number,
  districtId: number,
  unit: string,
  schoolYear: string | null,
  unitOverride = false,
): Promise<{ contractId: string | null }> {
  let effectiveStart: string | null = null;
  if (schoolYear) {
    const m = /^(\d{4})-\d{2}$/.exec(schoolYear);
    if (m) effectiveStart = `${m[1]}-07-01`;
  }
  return await db.transaction(async (tx) => {
    // Serialise concurrent attaches for THIS source doc; auto-released at commit.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${CONTRACT_ATTACH_LOCK_NS}, ${sourceDocId})`,
    );
    const existing = await tx.execute(sql`
      SELECT id::text AS id FROM contracts WHERE source_doc_id = ${sourceDocId} LIMIT 1
    `);
    if (existing.rows.length) {
      return { contractId: (existing.rows[0] as { id: string }).id };
    }
    const inserted = await tx.execute(sql`
      INSERT INTO contracts (district_id, bargaining_unit, effective_start, source_doc_id, unit_override)
      VALUES (${districtId}, ${unit}, ${effectiveStart}, ${sourceDocId}, ${unitOverride})
      ON CONFLICT (district_id, bargaining_unit, unit_scope, effective_start) DO NOTHING
      RETURNING id::text AS id
    `);
    if (inserted.rows.length) {
      return { contractId: (inserted.rows[0] as { id: string }).id };
    }
    // Conflict: a contract for the same (district, unit, scope, start) already
    // exists pointing at another doc. The version is still recorded for audit, but
    // promotion will find zero targets and surface needs_review.
    logger.warn(
      { sourceDocId, districtId, unit },
      "ensureContractForUpload: could not attach a contract; promotion will report needs_review",
    );
    return { contractId: null };
  });
}

// ---------------------------------------------------------------------------
// Source-document persistence + linking (used by the PDF-link endpoint)
// ---------------------------------------------------------------------------

export interface LinkUploadedCbaParams {
  buf: Buffer;
  district: ResolvedDistrict;
  unit: string;
  schoolYear: string | null;
  filename: string;
  // Absolute dir for the dev-local copy (pipeline/data/il_cba). Object storage is
  // authoritative; the local write is best-effort for the dev pipeline only.
  localDir: string;
}

export interface LinkUploadedCbaResult {
  sourceDocId: number;
  fileHash: string;
  sourceUrl: string;
  storageKey: string;
  created: boolean; // false = matched an existing document (idempotent)
  contractId: string | null;
}

// Persist an uploaded CBA PDF and link it to its district WITHOUT queuing
// extraction. Idempotent on (district, unit, file_hash): re-submitting the same
// file returns the existing document. Object Storage is written on BOTH the new
// and the duplicate path (required) so the source link is always servable in
// production.
export async function linkUploadedCba(
  p: LinkUploadedCbaParams,
): Promise<LinkUploadedCbaResult> {
  const { buf, district, unit, schoolYear, filename, localDir } = p;
  const fileHash = createHash("sha256").update(buf).digest("hex");

  // Object Storage FIRST — required on both paths. If this fails we throw and the
  // caller records nothing.
  try {
    await uploadBuffer(uploadedCbaKey(fileHash), buf);
  } catch (err) {
    logger.error(
      { err, fileHash, districtId: district.id },
      "object storage upload failed for uploaded CBA",
    );
    throw new ObjectStorageWriteError(err);
  }

  // Dev-local copy for the extraction pipeline (resolve_pdf_path reads the
  // absolute local: storage_key first in dev). Best-effort: object storage is the
  // source of truth in production, so a read-only/absent local dir is non-fatal.
  const absPath = join(localDir, `${fileHash}.pdf`);
  try {
    mkdirSync(localDir, { recursive: true });
    writeFileSync(absPath, buf);
  } catch (err) {
    logger.warn({ err, absPath }, "local PDF copy failed (non-fatal)");
  }
  const storageKey = `local:${absPath}`;

  // Dedup on (district, unit, hash) before inserting.
  const existing = await db.execute(sql`
    SELECT id, source_url FROM source_documents
    WHERE district_id = ${district.id}
      AND bargaining_unit = ${unit}
      AND file_hash = ${fileHash}
    LIMIT 1
  `);
  if (existing.rows.length > 0) {
    const row = existing.rows[0] as { id: number | string; source_url: string };
    const existingId = Number(row.id);
    // Backfill storage_key when the pre-existing row has none (e.g. created by a
    // crawl/bulk path). Serving 404s ("Document not found") on a NULL storage_key
    // BEFORE it falls back to object storage, so without this a linked-then-
    // imported doc's source link would break even though bytes were just written.
    await db.execute(sql`
      UPDATE source_documents SET storage_key = ${storageKey}
      WHERE id = ${existingId} AND storage_key IS NULL
    `);
    const { contractId } = await ensureContractForUpload(
      existingId,
      district.id,
      unit,
      schoolYear,
      true,
    );
    return {
      sourceDocId: existingId,
      fileHash,
      sourceUrl: row.source_url,
      storageKey,
      created: false,
      contractId,
    };
  }

  const sourceUrl = `upload://district-${district.id}/${unit}/${filename}`;
  let sourceDocId: number;
  try {
    const inserted = await db.execute(sql`
      INSERT INTO source_documents
        (district_id, doc_type, bargaining_unit, source_url, file_hash, storage_key, school_year)
      VALUES
        (${district.id}, 'cba_pdf', ${unit}, ${sourceUrl}, ${fileHash}, ${storageKey}, ${schoolYear})
      RETURNING id
    `);
    sourceDocId = Number((inserted.rows[0] as { id: number }).id);
  } catch (err) {
    // A concurrent request may have inserted the same (district, unit, hash)
    // between our SELECT and INSERT. Recover the existing row and treat it as a
    // duplicate rather than failing.
    const dup = await db.execute(sql`
      SELECT id, source_url FROM source_documents
      WHERE district_id = ${district.id}
        AND bargaining_unit = ${unit}
        AND file_hash = ${fileHash}
      LIMIT 1
    `);
    if (dup.rows.length > 0) {
      const row = dup.rows[0] as { id: number | string; source_url: string };
      const existingId = Number(row.id);
      // Backfill storage_key when the concurrently-inserted row has none, so the
      // source link is servable (serving 404s on a NULL storage_key).
      await db.execute(sql`
        UPDATE source_documents SET storage_key = ${storageKey}
        WHERE id = ${existingId} AND storage_key IS NULL
      `);
      const { contractId } = await ensureContractForUpload(
        existingId,
        district.id,
        unit,
        schoolYear,
        true,
      );
      return {
        sourceDocId: existingId,
        fileHash,
        sourceUrl: row.source_url,
        storageKey,
        created: false,
        contractId,
      };
    }
    throw err;
  }

  // A genuinely new CBA document fires exactly one 'new_doc' alert for any firm
  // subscribing this district. Best-effort + idempotent on source_doc_id.
  await recordNewContractAlert({
    sourceDocId,
    districtId: district.id,
    docName: filename,
    sourceUrl,
    fileHash,
  });

  const { contractId } = await ensureContractForUpload(
    sourceDocId,
    district.id,
    unit,
    schoolYear,
    true,
  );

  return { sourceDocId, fileHash, sourceUrl, storageKey, created: true, contractId };
}

// ---------------------------------------------------------------------------
// Source-document lookup (used by the import endpoint)
// ---------------------------------------------------------------------------

export interface FoundSourceDoc {
  id: number;
  districtId: number;
  unit: string;
  fileHash: string | null;
  storageKey: string | null;
}

function rowToSourceDoc(row: unknown): FoundSourceDoc {
  const r = row as {
    id: number | string;
    district_id: number | string;
    bargaining_unit: string;
    file_hash: string | null;
    storage_key: string | null;
  };
  return {
    id: Number(r.id),
    districtId: Number(r.district_id),
    unit: r.bargaining_unit,
    fileHash: r.file_hash,
    storageKey: r.storage_key,
  };
}

// Find a source document by (district, unit, file hash), scoped to customer-state
// (IL) districts. The district join is defensive: callers already resolve the
// district through resolveDistrictDb (IL-only), but keeping the scope here mirrors
// getSourceDocById so neither lookup path can reach a non-IL document.
export async function findSourceDoc(p: {
  districtId: number;
  unit: string;
  fileHash: string;
}): Promise<FoundSourceDoc | null> {
  const r = await db.execute(sql`
    SELECT sd.id, sd.district_id, sd.bargaining_unit, sd.file_hash, sd.storage_key
    FROM source_documents sd
    JOIN districts d ON d.id = sd.district_id
    WHERE sd.district_id = ${p.districtId}
      AND sd.bargaining_unit = ${p.unit}
      AND sd.file_hash = ${p.fileHash}
      AND d.state = ${CUSTOMER_STATE}
    LIMIT 1
  `);
  return r.rows.length ? rowToSourceDoc(r.rows[0]) : null;
}

// Look up a source document by id, scoped to customer-state (IL) districts. A
// non-IL document resolves to null so an importer can never promote data for a
// district outside the customer's state, matching the customer-facing scoping.
export async function getSourceDocById(
  id: number,
): Promise<FoundSourceDoc | null> {
  const r = await db.execute(sql`
    SELECT sd.id, sd.district_id, sd.bargaining_unit, sd.file_hash, sd.storage_key
    FROM source_documents sd
    JOIN districts d ON d.id = sd.district_id
    WHERE sd.id = ${id} AND d.state = ${CUSTOMER_STATE}
    LIMIT 1
  `);
  return r.rows.length ? rowToSourceDoc(r.rows[0]) : null;
}
