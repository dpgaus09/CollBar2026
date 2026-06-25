// Hash + model-version cache for vision extraction calls (Task #174 locked
// decision #5). One row per (file_hash, request_hash) in vision_extraction_cache
// (created idempotently in app.ts runMigrations). A bulk re-run can skip a doc
// whose deterministic request hash already has a successful result, so we never
// pay twice for the same model+prompt+render against the same bytes.
//
// The lookup key is (file_hash, request_hash). request_hash is computed BEFORE
// the call from everything that determines the request EXCEPT the resolved model
// version (which is only known from the response) — model_version is stored as
// metadata. The requested model alias IS part of request_hash, so switching
// models still misses the cache as intended.

import crypto from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

// Build the deterministic request hash from the request-defining parameters.
export function requestHash(parts: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(stableStringify(parts)).digest("hex");
}

export interface CacheHit {
  normalized: unknown;
  rawResponse: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  modelVersion: string;
  createdAt: Date;
}

export async function getCached(
  fileHash: string,
  reqHash: string,
): Promise<CacheHit | null> {
  const res = await db.execute(sql`
    SELECT normalized,
           raw_response        AS "rawResponse",
           input_tokens        AS "inputTokens",
           output_tokens       AS "outputTokens",
           estimated_cost_usd::float AS "estimatedCostUsd",
           model_version       AS "modelVersion",
           created_at          AS "createdAt"
    FROM vision_extraction_cache
    WHERE file_hash = ${fileHash}
      AND request_hash = ${reqHash}
      AND status = 'success'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = res.rows[0] as
    | {
        normalized: unknown;
        rawResponse: string | null;
        inputTokens: number | string;
        outputTokens: number | string;
        estimatedCostUsd: number;
        modelVersion: string;
        createdAt: Date;
      }
    | undefined;
  if (!row) return null;
  return {
    normalized: row.normalized,
    rawResponse: row.rawResponse,
    inputTokens: Number(row.inputTokens) || 0,
    outputTokens: Number(row.outputTokens) || 0,
    estimatedCostUsd: Number(row.estimatedCostUsd) || 0,
    modelVersion: row.modelVersion,
    createdAt: row.createdAt,
  };
}

export interface CachePut {
  fileHash: string;
  requestHash: string;
  domain: string;
  model: string;
  modelVersion: string;
  promptVersion: string;
  renderVersion: string;
  pageSet?: string;
  status: "success" | "failure";
  error?: string | null;
  rawResponse?: string | null;
  normalized?: unknown;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  finishReason?: string | null;
}

export async function putCached(p: CachePut): Promise<void> {
  const normalizedJson =
    p.normalized === undefined || p.normalized === null
      ? null
      : JSON.stringify(p.normalized);
  await db.execute(sql`
    INSERT INTO vision_extraction_cache
      (file_hash, request_hash, domain, model, model_version, prompt_version,
       render_version, page_set, status, error, raw_response, normalized,
       input_tokens, output_tokens, estimated_cost_usd, finish_reason)
    VALUES
      (${p.fileHash}, ${p.requestHash}, ${p.domain}, ${p.model},
       ${p.modelVersion}, ${p.promptVersion}, ${p.renderVersion},
       ${p.pageSet ?? "*"}, ${p.status}, ${p.error ?? null},
       ${p.rawResponse ?? null}, ${normalizedJson}::jsonb,
       ${p.inputTokens}, ${p.outputTokens}, ${p.estimatedCostUsd},
       ${p.finishReason ?? null})
    ON CONFLICT (file_hash, request_hash) DO UPDATE SET
      domain             = EXCLUDED.domain,
      model              = EXCLUDED.model,
      model_version      = EXCLUDED.model_version,
      prompt_version     = EXCLUDED.prompt_version,
      render_version     = EXCLUDED.render_version,
      page_set           = EXCLUDED.page_set,
      status             = EXCLUDED.status,
      error              = EXCLUDED.error,
      raw_response       = EXCLUDED.raw_response,
      normalized         = EXCLUDED.normalized,
      input_tokens       = EXCLUDED.input_tokens,
      output_tokens      = EXCLUDED.output_tokens,
      estimated_cost_usd = EXCLUDED.estimated_cost_usd,
      finish_reason      = EXCLUDED.finish_reason,
      created_at         = NOW()
  `);
}
