// Persist extracted provisions into contract_provisions, and orchestrate the full
// per-document provisions domain (resolve PDF -> vision extract -> Option B verify
// -> route to unit contracts -> store). Mirrors salary-store.ts.
//
// Each target contract is rewritten as one delete-then-insert TRANSACTION — even
// when it gets ZERO provisions — so stale/leaked rows clear. One bad contract is
// recorded and skipped, never poisoning the rest of the document's batch.
//
// NOTE: delete-then-insert replaces ALL of a contract's provision rows (mirroring
// the salary domain). Live runs would therefore overwrite human_verified rows;
// re-run/merge UX is Task #175. Validation in this task uses dryRun.

import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import type { ExtractedContract, ProvisionItem } from "../types";
import {
  extractProvisions,
  dedupeProvisions,
  type ProvisionsExtractionResult,
} from "./provisions";
import { verifyProvisionsAgainstText } from "./provisions-verify";
import { loadSourceDoc, resolvePdfBuffer } from "../source-docs";
import { openPdf } from "../pdf/renderer";

interface ProvisionTarget {
  contractId: string;
  bargainingUnit: string;
}

export interface ContractProvisionResult {
  contractId: string;
  bargainingUnit: string;
  status: "ok" | "store_error";
  provisions: number;
  flagged: number; // confidence < 0.8 -> human review queue
}

async function fetchProvisionTargets(
  sourceDocId: number | string,
): Promise<ProvisionTarget[]> {
  const res = await db.execute(sql`
    SELECT c.id::text                            AS "contractId",
           COALESCE(c.bargaining_unit, 'teachers') AS "bargainingUnit"
    FROM contracts c
    WHERE c.source_doc_id = ${sourceDocId}
    ORDER BY c.id
  `);
  return res.rows.map((r) => r as unknown as ProvisionTarget);
}

export interface MappedProvisions {
  byContract: Map<string, ProvisionItem[]>; // contractId -> provisions (incl empty)
  unattributed: number; // provisions with no matching unit contract
}

// Map the model's per-unit contract objects to the DB's existing contracts.
//   - exactly one DB contract on the doc: attach ALL provisions to it;
//   - otherwise: match each extracted unit to a DB contract by exact canonical
//     bargaining_unit. Unmatched provisions are counted, never guessed.
// Every target appears in the result (with [] when it gets nothing) so the store
// can delete-then-insert and clear stale rows.
export function mapProvisionsToTargets(
  contracts: ExtractedContract[],
  targets: ProvisionTarget[],
): MappedProvisions {
  const byContract = new Map<string, ProvisionItem[]>();
  for (const t of targets) byContract.set(t.contractId, []);
  let unattributed = 0;

  const allProvisions = contracts.flatMap((c) => c.provisions);

  if (targets.length === 1) {
    byContract.set(targets[0].contractId, dedupeProvisions(allProvisions));
    return { byContract, unattributed: 0 };
  }

  const byUnit = new Map<string, ProvisionTarget>();
  for (const t of targets) byUnit.set(t.bargainingUnit.toLowerCase(), t);

  for (const c of contracts) {
    const unit = c.bargainingUnit?.toLowerCase() ?? null;
    const target = unit ? byUnit.get(unit) : undefined;
    if (!target) {
      unattributed += c.provisions.length;
      continue;
    }
    const acc = byContract.get(target.contractId) ?? [];
    acc.push(...c.provisions);
    byContract.set(target.contractId, acc);
  }

  // Dedupe each target's merged provisions.
  for (const [cid, items] of byContract) {
    byContract.set(cid, dedupeProvisions(items));
  }
  return { byContract, unattributed };
}

async function storeProvisionsForContract(
  contractId: string,
  provisions: ProvisionItem[],
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return provisions.length;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM contract_provisions WHERE contract_id = ${contractId}`,
    );
    if (!provisions.length) return 0;
    const values = sql.join(
      provisions.map(
        (p) =>
          sql`(${contractId}, ${p.category}, ${p.provisionKey}, ${p.valueNumeric}, ${p.valueText}, ${p.unit}, ${p.clauseExcerpt}, ${p.pageRef}, ${p.confidence})`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      INSERT INTO contract_provisions
        (contract_id, category, provision_key, value_numeric, value_text,
         unit, clause_excerpt, page_ref, confidence)
      VALUES ${values}
    `);
    return provisions.length;
  });
}

export interface StoreProvisionsResult {
  results: ContractProvisionResult[];
  unattributed: number;
}

export async function storeProvisionsForDoc(
  sourceDocId: number | string,
  contracts: ExtractedContract[],
  opts?: { dryRun?: boolean },
): Promise<StoreProvisionsResult> {
  const dryRun = opts?.dryRun ?? false;
  const targets = await fetchProvisionTargets(sourceDocId);
  if (!targets.length) return { results: [], unattributed: 0 };

  const { byContract, unattributed } = mapProvisionsToTargets(contracts, targets);
  if (unattributed) {
    logger.info(
      { sourceDocId, unattributed },
      "provisions: provision(s) unattributed — no matching unit contract; not stored",
    );
  }

  const results: ContractProvisionResult[] = [];
  for (const t of targets) {
    const items = byContract.get(t.contractId) ?? [];
    const flagged = items.filter((p) => p.confidence < 0.8).length;
    try {
      const n = await storeProvisionsForContract(t.contractId, items, dryRun);
      results.push({
        contractId: t.contractId,
        bargainingUnit: t.bargainingUnit,
        status: "ok",
        provisions: n,
        flagged,
      });
    } catch (err) {
      logger.error(
        { err, contractId: t.contractId },
        "provisions store failed for contract",
      );
      results.push({
        contractId: t.contractId,
        bargainingUnit: t.bargainingUnit,
        status: "store_error",
        provisions: 0,
        flagged: 0,
      });
    }
  }
  return { results, unattributed };
}

export interface RunProvisionsResult {
  status: "ok" | "no_doc" | "no_pdf" | "extract_failed";
  sourceDocId: string;
  fileHash?: string;
  extraction?: ProvisionsExtractionResult;
  verify?: { checked: number; mismatched: number; capped: number };
  store?: StoreProvisionsResult;
  dryRun?: boolean;
}

// Full provisions domain for one source document: load row -> resolve PDF bytes
// -> vision extract -> Option B text verify (digital pages) -> route + store.
export async function runProvisionsForDoc(
  sourceDocId: number | string,
  opts?: {
    dryRun?: boolean;
    useCache?: boolean;
    model?: string;
    maxPages?: number;
    verify?: boolean;
  },
): Promise<RunProvisionsResult> {
  const dryRun = opts?.dryRun ?? false;
  const doVerify = opts?.verify ?? true;
  const doc = await loadSourceDoc(sourceDocId);
  if (!doc) return { status: "no_doc", sourceDocId: String(sourceDocId) };

  const buf = await resolvePdfBuffer(doc);
  if (!buf) {
    return {
      status: "no_pdf",
      sourceDocId: String(doc.id),
      fileHash: doc.fileHash ?? undefined,
    };
  }

  const fileHash =
    doc.fileHash && /^[0-9a-f]{64}$/i.test(doc.fileHash)
      ? doc.fileHash.toLowerCase()
      : crypto.createHash("sha256").update(buf).digest("hex");

  const extraction = await extractProvisions(buf, fileHash, {
    model: opts?.model,
    maxPages: opts?.maxPages,
    useCache: opts?.useCache,
  });

  // Fail-closed: a truncated/unparseable extraction must NOT reach the store. The
  // per-contract delete-then-insert (incl. zero rows) would wipe every existing
  // provision for this doc's contracts and replace them with nothing. Skip the
  // store entirely and leave existing rows intact.
  if (!extraction.ok) {
    logger.warn(
      { sourceDocId: doc.id, status: extraction.status },
      "provisions: extraction not ok; preserving existing rows (no store)",
    );
    return {
      status: "extract_failed",
      sourceDocId: String(doc.id),
      fileHash,
      extraction,
      dryRun,
    };
  }

  // Option B: corroborate $/% values against the digital text layer. Re-open the
  // PDF here (extractProvisions destroys its own handle) only when there is work.
  let verify: { checked: number; mismatched: number; capped: number } | undefined;
  if (doVerify && extraction.contracts.some((c) => c.provisions.length)) {
    const vdoc = await openPdf(buf);
    try {
      verify = verifyProvisionsAgainstText(extraction.contracts, vdoc);
    } finally {
      vdoc.destroy();
    }
  }

  const store = await storeProvisionsForDoc(doc.id, extraction.contracts, { dryRun });

  return {
    status: "ok",
    sourceDocId: String(doc.id),
    fileHash,
    extraction,
    verify,
    store,
    dryRun,
  };
}
