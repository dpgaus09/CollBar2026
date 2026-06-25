// Immutable extraction versions + promotion (Task #175).
//
// Every successful extraction is persisted as an immutable extraction_versions
// row — a full audit trail that is NEVER overwritten. The LIVE domain tables
// (contract_salary_schedules / contract_provisions) hold only the PROMOTED
// projection: promoting a version re-projects it into those tables via the
// EXISTING store functions (delete-then-insert), and flips the per-(doc,domain)
// pointer in extraction_promotions. Customer reads are therefore unchanged — a
// new extraction is invisible until an admin (or the auto-promote-on-first rule)
// promotes it.
//
// Version identity: result_hash = sha256(canonicalJson(normalized)). A re-run
// that produces byte-identical output links to its predecessor via
// duplicate_of_version_id (so the UI can say "no change").

import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { storeSalaryForDoc } from "../domains/salary-store";
import { storeProvisionsForDoc } from "../domains/provisions-store";
import { storeSettlementsForDoc } from "../domains/settlements-store";
import {
  storeOfferItems,
  computeComparisons,
} from "../domains/final-offers-store";
import { storeContractMetaForDoc } from "../domains/contract-meta-store";
import { EMPTY_CONTRACT_META, type ContractMeta } from "../domains/contract-meta";
import type {
  SalarySchedule,
  ExtractedContract,
  DerivedSettlement,
  OfferItem,
  OfferSide,
} from "../types";

export type VersionDomain =
  | "salary"
  | "provisions"
  | "settlement"
  | "final_offer"
  | "contract_meta";

// Deterministic JSON: recursively sort object keys so result_hash is stable
// regardless of property insertion order.
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return v;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function resultHash(normalized: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export interface VersionRow {
  id: string;
  sourceDocId: string;
  domain: VersionDomain;
  jobId: string | null;
  fileHash: string | null;
  model: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  renderVersion: string | null;
  resultHash: string;
  normalized: unknown;
  summary: unknown;
  status: string;
  duplicateOfVersionId: string | null;
  createdBy: string | null;
  createdAt: string;
}

const VERSION_COLUMNS = sql`
  id::text                       AS "id",
  source_doc_id::text            AS "sourceDocId",
  domain                         AS "domain",
  job_id::text                   AS "jobId",
  file_hash                      AS "fileHash",
  model                          AS "model",
  model_version                  AS "modelVersion",
  prompt_version                 AS "promptVersion",
  render_version                 AS "renderVersion",
  result_hash                    AS "resultHash",
  normalized                     AS "normalized",
  summary                        AS "summary",
  status                         AS "status",
  duplicate_of_version_id::text  AS "duplicateOfVersionId",
  created_by                     AS "createdBy",
  created_at                     AS "createdAt"
`;

export interface CreateVersionParams {
  sourceDocId: number | string;
  domain: VersionDomain;
  jobId?: number | string | null;
  fileHash?: string | null;
  model?: string | null;
  modelVersion?: string | null;
  promptVersion?: string | null;
  renderVersion?: string | null;
  normalized: unknown;
  summary: unknown;
  createdBy?: string | null;
}

// Persist a new immutable version. Links to a prior identical version (same
// doc/domain/result_hash) via duplicate_of_version_id so re-runs that change
// nothing are visible as such.
export async function createVersion(
  p: CreateVersionParams,
): Promise<{ version: VersionRow; duplicate: boolean }> {
  const rhash = resultHash(p.normalized);
  const prior = await db.execute(sql`
    SELECT id::text AS id FROM extraction_versions
    WHERE source_doc_id = ${p.sourceDocId} AND domain = ${p.domain}
      AND result_hash = ${rhash}
    ORDER BY id LIMIT 1
  `);
  const dupId = prior.rows.length ? (prior.rows[0] as { id: string }).id : null;
  const res = await db.execute(sql`
    INSERT INTO extraction_versions
      (source_doc_id, domain, job_id, file_hash, model, model_version,
       prompt_version, render_version, result_hash, normalized, summary,
       status, duplicate_of_version_id, created_by)
    VALUES (${p.sourceDocId}, ${p.domain}, ${p.jobId ?? null}, ${p.fileHash ?? null},
       ${p.model ?? null}, ${p.modelVersion ?? null}, ${p.promptVersion ?? null},
       ${p.renderVersion ?? null}, ${rhash},
       ${JSON.stringify(p.normalized)}::jsonb, ${JSON.stringify(p.summary)}::jsonb,
       'success', ${dupId}, ${p.createdBy ?? null})
    RETURNING ${VERSION_COLUMNS}
  `);
  return {
    version: res.rows[0] as unknown as VersionRow,
    duplicate: dupId !== null,
  };
}

export async function getVersion(id: number | string): Promise<VersionRow | null> {
  const res = await db.execute(sql`
    SELECT ${VERSION_COLUMNS} FROM extraction_versions WHERE id = ${id}
  `);
  return res.rows.length ? (res.rows[0] as unknown as VersionRow) : null;
}

export async function getVersionsForDoc(
  sourceDocId: number | string,
  domain?: VersionDomain,
): Promise<VersionRow[]> {
  const res = domain
    ? await db.execute(sql`
        SELECT ${VERSION_COLUMNS} FROM extraction_versions
        WHERE source_doc_id = ${sourceDocId} AND domain = ${domain}
        ORDER BY id DESC
      `)
    : await db.execute(sql`
        SELECT ${VERSION_COLUMNS} FROM extraction_versions
        WHERE source_doc_id = ${sourceDocId}
        ORDER BY id DESC
      `);
  return res.rows as unknown as VersionRow[];
}

export interface PromotionRow {
  sourceDocId: string;
  domain: VersionDomain;
  versionId: string;
  previousVersionId: string | null;
  promotedBy: string | null;
  promotedAt: string;
}

export async function getPromotions(
  sourceDocId: number | string,
): Promise<PromotionRow[]> {
  const res = await db.execute(sql`
    SELECT source_doc_id::text       AS "sourceDocId",
           domain                    AS "domain",
           version_id::text          AS "versionId",
           previous_version_id::text AS "previousVersionId",
           promoted_by               AS "promotedBy",
           promoted_at               AS "promotedAt"
    FROM extraction_promotions
    WHERE source_doc_id = ${sourceDocId}
  `);
  return res.rows as unknown as PromotionRow[];
}

export async function getPromotedVersionId(
  sourceDocId: number | string,
  domain: VersionDomain,
): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT version_id::text AS id FROM extraction_promotions
    WHERE source_doc_id = ${sourceDocId} AND domain = ${domain}
  `);
  return res.rows.length ? (res.rows[0] as { id: string }).id : null;
}

export interface PromoteResult {
  ok: boolean;
  versionId: string;
  domain: VersionDomain;
  previousVersionId: string | null;
  targets: number;
  // provisions only: human_verified rows kept (not overwritten) by this promote.
  preservedVerified?: number;
  store?: unknown;
  reason?: string;
}

// Promote a version into the live tables. Serializes concurrent promotes of the
// same (doc, domain) via a transaction-scoped advisory lock, projects through the
// existing store functions (delete-then-insert per contract), then flips the
// promotion pointer. The store functions attach to existing contracts rows
// (WHERE source_doc_id = ...) — if none exist, targets = 0 and nothing is
// written (the version still stands as an audit record; caller surfaces it).
export async function promoteVersion(
  versionId: number | string,
  opts?: { promotedBy?: string | null },
): Promise<PromoteResult> {
  const v = await getVersion(versionId);
  if (!v) {
    return {
      ok: false,
      versionId: String(versionId),
      domain: "salary",
      previousVersionId: null,
      targets: 0,
      reason: "version_not_found",
    };
  }
  const domain = v.domain;
  // Advisory lock keyed by (sourceDocId, domain). Two-int form: doc id (mod
  // int4 range) + a small per-domain salt.
  const lockA = Number(BigInt(v.sourceDocId) % 2147483647n);
  const lockB =
    domain === "salary"
      ? 1
      : domain === "provisions"
        ? 2
        : domain === "settlement"
          ? 3
          : domain === "final_offer"
            ? 4
            : 5;

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockA}, ${lockB})`);

    const prev = await tx.execute(sql`
      SELECT version_id::text AS id FROM extraction_promotions
      WHERE source_doc_id = ${v.sourceDocId} AND domain = ${domain}
    `);
    const previousVersionId = prev.rows.length
      ? (prev.rows[0] as { id: string }).id
      : null;

    let store: unknown;
    let targets = 0;
    let preservedVerified: number | undefined;
    if (domain === "salary") {
      const schedules =
        ((v.normalized as { schedules?: SalarySchedule[] })?.schedules) ?? [];
      const r = await storeSalaryForDoc(v.sourceDocId, schedules);
      store = r;
      targets = r.results.length;
    } else if (domain === "provisions") {
      const contracts =
        ((v.normalized as { contracts?: ExtractedContract[] })?.contracts) ?? [];
      const r = await storeProvisionsForDoc(v.sourceDocId, contracts);
      store = r;
      targets = r.results.length;
      // human_verified rows are kept (not overwritten) by the store — surface the
      // total so the admin sees that prior manual review survived the promote.
      preservedVerified = r.results.reduce((s, x) => s + x.preserved, 0);
    } else if (domain === "settlement") {
      const settlements =
        ((v.normalized as { settlements?: DerivedSettlement[] })?.settlements) ??
        [];
      const r = await storeSettlementsForDoc(v.sourceDocId, settlements);
      store = r;
      targets = r.inserted;
    } else if (domain === "contract_meta") {
      const meta =
        ((v.normalized as { meta?: ContractMeta })?.meta) ?? EMPTY_CONTRACT_META;
      const r = await storeContractMetaForDoc(v.sourceDocId, meta);
      store = r;
      targets = r.updated;
    } else {
      // final_offer: project this doc's side into final_offer_items, then rebuild
      // the posting's board-vs-union comparison from both stored sides.
      const n = v.normalized as {
        postingId?: string;
        side?: OfferSide;
        items?: OfferItem[];
      };
      const items = n.items ?? [];
      if (n.postingId && (n.side === "district" || n.side === "union")) {
        const stored = await storeOfferItems(
          n.postingId,
          n.side,
          v.sourceDocId,
          items,
          false,
        );
        const comparisons = await computeComparisons(n.postingId, false);
        store = {
          postingId: n.postingId,
          side: n.side,
          items: stored,
          comparisons,
        };
        targets = stored;
      } else {
        store = { reason: "no_posting_in_version" };
        targets = 0;
      }
    }

    await tx.execute(sql`
      INSERT INTO extraction_promotions
        (source_doc_id, domain, version_id, previous_version_id, promoted_by, promoted_at)
      VALUES (${v.sourceDocId}, ${domain}, ${v.id}, ${previousVersionId},
              ${opts?.promotedBy ?? null}, NOW())
      ON CONFLICT (source_doc_id, domain) DO UPDATE
        SET version_id = EXCLUDED.version_id,
            previous_version_id = ${previousVersionId},
            promoted_by = EXCLUDED.promoted_by,
            promoted_at = NOW()
    `);

    logger.info(
      { sourceDocId: v.sourceDocId, domain, versionId: v.id, previousVersionId, targets },
      "extraction: promoted version into live tables",
    );

    return {
      ok: true,
      versionId: String(v.id),
      domain,
      previousVersionId,
      targets,
      preservedVerified,
      store,
      reason: targets === 0 ? "no_contract_targets" : undefined,
    };
  });
}

export interface VersionDiff {
  versionId: string;
  comparedToVersionId: string | null;
  identical: boolean;
  domain: VersionDomain;
  candidateSummary: unknown;
  promotedSummary: unknown;
  candidateResultHash: string;
  promotedResultHash: string | null;
}

// Diff a candidate version against the currently-promoted version for its
// (doc, domain). Summary-level diff (counts/cost) plus an identical flag from the
// result hashes — enough for the admin to decide whether to promote.
export async function diffAgainstPromoted(
  versionId: number | string,
): Promise<VersionDiff | null> {
  const candidate = await getVersion(versionId);
  if (!candidate) return null;
  const promotedId = await getPromotedVersionId(candidate.sourceDocId, candidate.domain);
  const promoted = promotedId ? await getVersion(promotedId) : null;
  return {
    versionId: candidate.id,
    comparedToVersionId: promoted?.id ?? null,
    identical: promoted != null && promoted.resultHash === candidate.resultHash,
    domain: candidate.domain,
    candidateSummary: candidate.summary,
    promotedSummary: promoted?.summary ?? null,
    candidateResultHash: candidate.resultHash,
    promotedResultHash: promoted?.resultHash ?? null,
  };
}
