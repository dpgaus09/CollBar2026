// Resolve a source_documents row to its PDF bytes for extraction.
//
// Object storage first (il_cba/<hash>.pdf) so it works on stateless autoscale
// instances and in production, then dev-local fallbacks: the row's `local:`
// storage_key, then the conventional pipeline/data/il_cba/<hash>.pdf path.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { downloadBuffer, uploadedCbaKey } from "../lib/objectStorage";
import { logger } from "../lib/logger";

export interface SourceDocRow {
  id: string;
  districtId: string | null;
  docType: string | null;
  bargainingUnit: string;
  sourceUrl: string;
  fileHash: string | null;
  storageKey: string | null;
  sourceType: string;
  schoolYear: string | null;
}

export async function loadSourceDoc(
  sourceDocId: number | string,
): Promise<SourceDocRow | null> {
  const res = await db.execute(sql`
    SELECT id::text            AS "id",
           district_id::text   AS "districtId",
           doc_type            AS "docType",
           bargaining_unit     AS "bargainingUnit",
           source_url          AS "sourceUrl",
           file_hash           AS "fileHash",
           storage_key         AS "storageKey",
           source_type         AS "sourceType",
           school_year         AS "schoolYear"
    FROM source_documents
    WHERE id = ${sourceDocId}
  `);
  return (res.rows[0] as unknown as SourceDocRow | undefined) ?? null;
}

// Walk up from the current working directory to the monorepo root (marked by
// pnpm-workspace.yaml). Dev runs from the package dir; prod from the repo root.
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export async function resolvePdfBuffer(
  doc: Pick<SourceDocRow, "id" | "fileHash" | "storageKey">,
): Promise<Buffer | null> {
  const hash = doc.fileHash?.trim();

  // 1. Object storage by content hash (production / autoscale).
  if (hash && /^[0-9a-f]{64}$/i.test(hash)) {
    try {
      const buf = await downloadBuffer(uploadedCbaKey(hash));
      if (buf) return buf;
    } catch (err) {
      logger.warn(
        { err, sourceDocId: doc.id },
        "object storage download failed; trying local",
      );
    }
  }

  const { readFile } = await import("node:fs/promises");

  // 2. Explicit dev-local storage key.
  if (doc.storageKey?.startsWith("local:")) {
    const abs = doc.storageKey.slice("local:".length);
    if (abs.endsWith(".pdf") && existsSync(abs)) {
      try {
        return await readFile(abs);
      } catch (err) {
        logger.warn({ err, abs }, "local PDF read failed");
      }
    }
  }

  // 3. Conventional crawl path on local disk (dev).
  if (hash && /^[0-9a-f]{64}$/i.test(hash)) {
    const abs = join(repoRoot(), "pipeline", "data", "il_cba", `${hash}.pdf`);
    if (existsSync(abs)) {
      try {
        return await readFile(abs);
      } catch (err) {
        logger.warn({ err, abs }, "conventional local PDF read failed");
      }
    }
  }

  return null;
}
