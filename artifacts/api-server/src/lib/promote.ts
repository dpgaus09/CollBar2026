// ---------------------------------------------------------------------------
// CBA data promotion engine (dev -> production).
//
// Copies vetted pipeline/reference tables from a bundle (produced by
// pipeline/20_export_promotion_bundle.py) into THIS database. Designed to run
// inside the deployed app against its own production DATABASE_URL.
//
// Safety properties:
//   - Strict table allowlist (never touches users / customers / conversations
//     / peer_sets). The bundle simply has no other tables.
//   - All primary keys are treated as independent. Foreign keys are remapped by
//     NATURAL KEY against the target DB — dev ids are never written to prod.
//   - Null-safe matching (IS NOT DISTINCT FROM) for natural keys that contain
//     nullable columns.
//   - Idempotent: rows are inserted only when absent, updated only when they
//     actually differ. Re-running a bundle is a no-op.
//   - Everything runs in ONE transaction under an advisory lock. dryRun rolls
//     back at the end and reports the exact counts it would have applied.
//   - Pre-images of every row that would be UPDATED or DELETED are snapshotted
//     into `promotion_backups` (keyed by run id) before mutation.
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";

// Minimal structural types for the node-postgres pool/client we use, so this
// module does not need a direct dependency on "pg" (it comes via @workspace/db).
interface QueryResult {
  rows: any[];
  rowCount: number | null;
}
interface PoolClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}
interface PgPool {
  connect(): Promise<PoolClient>;
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

type Fk = { col: string; parent: string; key: string; required?: boolean };
type Spec = {
  table: string;
  own: string[]; // non-id, non-fk columns
  fks: Fk[]; // fk columns (remapped to target ids by natural key)
  naturalKey: string[] | null; // db columns (own + fk) forming the unique key; null => parent-scoped replace
  isParent: boolean; // whether other tables reference it (=> needs a target lookup map)
};

// Promotion order honours FK dependencies (parents first).
export const PROMOTION_SPEC: Spec[] = [
  {
    table: "districts",
    own: ["state", "state_district_id", "name", "county", "district_type", "enrollment", "valuation", "avg_teacher_salary", "website_url", "updated_at", "slug"],
    fks: [],
    naturalKey: ["state", "state_district_id"],
    isParent: true,
  },
  {
    table: "il_min_teacher_salary",
    own: ["school_year", "prior_year", "prior_year_rate", "percentage_increase", "new_year_rate", "certified_date", "source_url", "file_hash", "created_at", "updated_at"],
    fks: [],
    naturalKey: ["school_year"],
    isParent: false,
  },
  {
    table: "source_documents",
    own: ["doc_type", "source_url", "file_hash", "storage_key", "school_year", "retrieved_at", "bargaining_unit", "source_type"],
    fks: [{ col: "district_id", parent: "districts", key: "_district_key" }],
    naturalKey: ["source_url", "file_hash"],
    isParent: true,
  },
  {
    table: "contracts",
    own: ["union_name", "affiliation", "unit_scope", "effective_start", "effective_end", "term_years", "has_reopener", "reopener_terms", "bargaining_unit"],
    fks: [
      { col: "district_id", parent: "districts", key: "_district_key" },
      { col: "source_doc_id", parent: "source_documents", key: "_source_doc_key" },
    ],
    // The DB unique index is (district_id, bargaining_unit, unit_scope,
    // effective_start), but Postgres treats NULLs as distinct there while our
    // matching uses IS NOT DISTINCT FROM (NULLs equal). effective_start is NULL
    // for ~100 rows, so the 4-col key collides under NULL-equality (multiple
    // rows per key) and would scramble data on UPDATE...FROM. effective_end +
    // union_name make the key collision-free (verified 0 dup groups).
    naturalKey: [
      "district_id",
      "bargaining_unit",
      "unit_scope",
      "effective_start",
      "effective_end",
      "union_name",
    ],
    isParent: true,
  },
  {
    table: "contract_provisions",
    own: ["category", "provision_key", "value_numeric", "value_text", "unit", "clause_excerpt", "page_ref", "confidence", "human_verified", "is_audit_sample", "audit_verdict"],
    fks: [{ col: "contract_id", parent: "contracts", key: "_contract_key", required: true }],
    naturalKey: null, // no natural key -> replace provisions of each promoted contract
    isParent: false,
  },
  {
    table: "settlements",
    own: ["from_year", "to_year", "base_increase_pct", "year2_pct", "year3_pct", "off_schedule_payment", "insurance_changed", "term_years", "method", "confidence", "human_verified", "notes", "page_ref", "bargaining_unit"],
    fks: [
      { col: "district_id", parent: "districts", key: "_district_key" },
      { col: "contract_id", parent: "contracts", key: "_contract_key" },
      { col: "source_doc_id", parent: "source_documents", key: "_source_doc_key" },
    ],
    naturalKey: ["district_id", "bargaining_unit", "from_year", "to_year"],
    isParent: false,
  },
  {
    table: "contract_salary_schedules",
    own: [
      "bargaining_unit",
      "schedule_name",
      "school_year",
      "start_year",
      "schedule_type",
      "lane_labels",
      "step_count",
      "lane_count",
      "page_start",
      "page_end",
      "min_salary",
      "max_salary",
      "confidence",
      "needs_review",
      "review_reason",
      "extraction_method",
      "created_at",
    ],
    fks: [
      { col: "district_id", parent: "districts", key: "_district_key" },
      { col: "contract_id", parent: "contracts", key: "_contract_key", required: true },
      { col: "source_doc_id", parent: "source_documents", key: "_source_doc_key" },
    ],
    // DB unique index is (contract_id, schedule_name, school_year) — all three
    // are NOT NULL, so no NULL-equality collision under IS NOT DISTINCT FROM.
    // raw_json is intentionally NOT promoted: it's the internal extraction blob,
    // unused by the customer dashboard, and would bloat the bundle.
    naturalKey: ["contract_id", "schedule_name", "school_year"],
    isParent: true,
  },
  {
    table: "contract_salary_schedule_cells",
    own: ["step_label", "step_order", "lane_label", "lane_order", "salary_amount", "page_ref"],
    fks: [
      { col: "schedule_id", parent: "contract_salary_schedules", key: "_schedule_key", required: true },
    ],
    // No natural key: a grid is atomic, so replace ALL cells of each promoted
    // schedule (delete-then-insert), mirroring contract_provisions.
    naturalKey: null,
    isParent: false,
  },
  {
    table: "final_offer_postings",
    own: ["case_number", "year", "bargaining_unit", "district_name", "union_name", "posted_date", "district_offer_url", "union_offer_url", "page_url", "created_at", "updated_at"],
    fks: [
      { col: "district_id", parent: "districts", key: "_district_key" },
      { col: "district_source_doc_id", parent: "source_documents", key: "_district_source_doc_key" },
      { col: "union_source_doc_id", parent: "source_documents", key: "_union_source_doc_key" },
    ],
    naturalKey: ["case_number"],
    isParent: true,
  },
  {
    table: "final_offer_items",
    own: ["side", "topic", "topic_label", "summary", "numeric_value", "numeric_unit", "raw_text", "created_at"],
    fks: [
      { col: "posting_id", parent: "final_offer_postings", key: "_posting_key", required: true },
      { col: "source_doc_id", parent: "source_documents", key: "_source_doc_key" },
    ],
    naturalKey: ["posting_id", "side", "topic"],
    isParent: true,
  },
  {
    table: "final_offer_comparisons",
    own: ["topic", "topic_label", "status", "district_summary", "union_summary", "numeric_gap", "gap_unit", "created_at"],
    fks: [
      { col: "posting_id", parent: "final_offer_postings", key: "_posting_key", required: true },
      { col: "district_item_id", parent: "final_offer_items", key: "_district_item_key" },
      { col: "union_item_id", parent: "final_offer_items", key: "_union_item_key" },
    ],
    naturalKey: ["posting_id", "topic"],
    isParent: false,
  },
];

const SPEC_BY_TABLE: Record<string, Spec> = Object.fromEntries(
  PROMOTION_SPEC.map((s) => [s.table, s]),
);

const ALLOWED_TABLES = new Set(PROMOTION_SPEC.map((s) => s.table));
const ADVISORY_LOCK_KEY = 918273645; // arbitrary constant; serialises promotions

const NULL_SENTINEL = "\u0000NULL";

function allCols(spec: Spec): string[] {
  return [...spec.own, ...spec.fks.map((f) => f.col)];
}

function canon(parts: unknown[]): string {
  return parts
    .map((p) => (p === null || p === undefined ? NULL_SENTINEL : String(p)))
    .join("\u0001");
}

export type TableResult = {
  inputRows: number;
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
  warnings: string[];
};
export type PromotionSummary = {
  runId: string;
  dryRun: boolean;
  tables: Record<string, TableResult>;
  totals: { inserted: number; updated: number; deleted: number; skipped: number };
};

type Maps = Record<string, Map<string, number>>;

function resolveKey(table: string, keyObj: any, maps: Maps): number | null {
  if (keyObj == null) return null;
  const spec = SPEC_BY_TABLE[table];
  if (!spec || !spec.naturalKey) return null;
  const parts: unknown[] = [];
  for (const col of spec.naturalKey) {
    const fk = spec.fks.find((f) => f.col === col);
    if (fk) {
      const child = keyObj[fk.key];
      parts.push(child == null ? null : resolveKey(fk.parent, child, maps));
    } else {
      parts.push(keyObj[col] ?? null);
    }
  }
  const m = maps[table];
  if (!m) return null;
  const id = m.get(canon(parts));
  return id == null ? null : id;
}

export async function runPromotion(
  pool: PgPool,
  bundle: { tables?: Record<string, any[]> },
  opts: { dryRun: boolean },
): Promise<PromotionSummary> {
  const tables = bundle?.tables ?? {};
  // Reject any table not on the allowlist (defence in depth).
  for (const t of Object.keys(tables)) {
    if (!ALLOWED_TABLES.has(t)) {
      throw new Error(`Bundle contains non-allowlisted table: ${t}`);
    }
  }

  const runId = randomUUID();
  const dryRun = opts.dryRun;
  const result: PromotionSummary = {
    runId,
    dryRun,
    tables: {},
    totals: { inserted: 0, updated: 0, deleted: 0, skipped: 0 },
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS promotion_runs (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        dry_run boolean NOT NULL,
        summary jsonb
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS promotion_backups (
        run_id uuid NOT NULL,
        table_name text NOT NULL,
        op text NOT NULL,
        row_data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    const maps: Maps = {};
    const buildMap = async (spec: Spec) => {
      if (!spec.naturalKey) return;
      const selectCols = spec.naturalKey
        .map((c, i) => `(${c})::text AS k${i}`)
        .join(", ");
      const { rows } = await client.query(
        `SELECT ${selectCols}, id FROM ${spec.table}`,
      );
      const m = new Map<string, number>();
      for (const r of rows) {
        const parts = spec.naturalKey.map((_, i) => r[`k${i}`]);
        m.set(canon(parts), Number(r.id));
      }
      maps[spec.table] = m;
    };

    // Pre-build maps for parent tables that already exist in the target so that
    // child rows referencing pre-existing parents resolve correctly.
    for (const spec of PROMOTION_SPEC) {
      if (spec.isParent) await buildMap(spec);
    }

    for (const spec of PROMOTION_SPEC) {
      const rows = tables[spec.table];
      const tr: TableResult = {
        inputRows: Array.isArray(rows) ? rows.length : 0,
        inserted: 0,
        updated: 0,
        deleted: 0,
        skipped: 0,
        warnings: [],
      };
      result.tables[spec.table] = tr;
      if (!Array.isArray(rows) || rows.length === 0) {
        if (spec.isParent) await buildMap(spec);
        continue;
      }

      const cols = allCols(spec);
      // Resolve each row's FK columns to target ids by natural key.
      const resolved: Record<string, unknown>[] = [];
      for (const row of rows) {
        const out: Record<string, unknown> = {};
        for (const c of spec.own) out[c] = row[c] ?? null;
        let drop = false;
        for (const fk of spec.fks) {
          const keyObj = row[fk.key];
          const id = keyObj == null ? null : resolveKey(fk.parent, keyObj, maps);
          if (id == null && (fk.required || keyObj != null)) {
            // Required FK missing, or a parent that existed in dev couldn't be
            // matched in the target.
            if (fk.required) {
              drop = true;
              break;
            } else {
              tr.warnings.push(
                `Unresolved ${fk.col} -> ${fk.parent} (left NULL)`,
              );
            }
          }
          out[fk.col] = id;
        }
        if (drop) {
          tr.skipped++;
          continue;
        }
        resolved.push(out);
      }

      // Stage the resolved rows in a temp table with the real column types.
      await client.query(`DROP TABLE IF EXISTS _promo_stage`);
      await client.query(
        `CREATE TEMP TABLE _promo_stage AS SELECT ${cols.join(", ")} FROM ${spec.table} WITH NO DATA`,
      );
      await client.query(
        `INSERT INTO _promo_stage SELECT * FROM json_populate_recordset(NULL::_promo_stage, $1::json)`,
        [JSON.stringify(resolved)],
      );

      if (spec.naturalKey) {
        const nk = spec.naturalKey;
        const match = nk
          .map((c) => `t.${c} IS NOT DISTINCT FROM s.${c}`)
          .join(" AND ");
        const setCols = cols.filter((c) => !nk.includes(c));
        const diff = setCols
          .map((c) => `t.${c} IS DISTINCT FROM s.${c}`)
          .join(" OR ");

        // SAFETY: UPDATE ... FROM with a null-safe key only behaves correctly
        // when the key is 1:1 in BOTH the staged bundle and the target. GROUP BY
        // collapses NULLs (matching IS NOT DISTINCT FROM), so any group with >1
        // row means the key collides and a multi-match update could scramble
        // rows. Abort the whole transaction rather than corrupt data.
        for (const [label, tbl] of [
          ["staged bundle", "_promo_stage"],
          ["target table", spec.table],
        ] as const) {
          const dup = await client.query(
            `SELECT count(*)::int AS n FROM (
               SELECT 1 FROM ${tbl} GROUP BY ${nk.join(", ")} HAVING count(*) > 1
             ) d`,
          );
          const n = dup.rows[0]?.n ?? 0;
          if (n > 0) {
            throw new Error(
              `${spec.table}: natural key (${nk.join(", ")}) is not unique in ` +
                `the ${label} (${n} colliding group(s)); aborting promotion to ` +
                `avoid corrupting rows. Resolve the duplicates or extend the key.`,
            );
          }
        }

        // Backup pre-images of rows that will actually change.
        if (setCols.length > 0) {
          await client.query(
            `INSERT INTO promotion_backups (run_id, table_name, op, row_data)
             SELECT $1, $2, 'update', to_jsonb(t)
             FROM ${spec.table} t JOIN _promo_stage s ON ${match}
             WHERE ${diff}`,
            [runId, spec.table],
          );
          const upd = await client.query(
            `UPDATE ${spec.table} t SET ${setCols.map((c) => `${c} = s.${c}`).join(", ")}
             FROM _promo_stage s WHERE ${match} AND (${diff})`,
          );
          tr.updated = upd.rowCount ?? 0;
        }
        const ins = await client.query(
          `INSERT INTO ${spec.table} (${cols.join(", ")})
           SELECT ${cols.join(", ")} FROM _promo_stage s
           WHERE NOT EXISTS (SELECT 1 FROM ${spec.table} t WHERE ${match})`,
        );
        tr.inserted = ins.rowCount ?? 0;
      } else {
        // contract_provisions: replace provisions of each promoted contract.
        const parentFk = spec.fks[0].col; // contract_id
        const affected = `(SELECT DISTINCT ${parentFk} FROM _promo_stage WHERE ${parentFk} IS NOT NULL)`;
        await client.query(
          `INSERT INTO promotion_backups (run_id, table_name, op, row_data)
           SELECT $1, $2, 'delete', to_jsonb(t)
           FROM ${spec.table} t WHERE t.${parentFk} IN ${affected}`,
          [runId, spec.table],
        );
        const del = await client.query(
          `DELETE FROM ${spec.table} WHERE ${parentFk} IN ${affected}`,
        );
        tr.deleted = del.rowCount ?? 0;
        const ins = await client.query(
          `INSERT INTO ${spec.table} (${cols.join(", ")})
           SELECT ${cols.join(", ")} FROM _promo_stage WHERE ${parentFk} IS NOT NULL`,
        );
        tr.inserted = ins.rowCount ?? 0;
      }

      // Refresh this table's map so children resolve against post-apply state
      // (works inside the txn even for dryRun).
      if (spec.isParent) await buildMap(spec);
    }

    for (const t of Object.values(result.tables)) {
      result.totals.inserted += t.inserted;
      result.totals.updated += t.updated;
      result.totals.deleted += t.deleted;
      result.totals.skipped += t.skipped;
    }

    if (!dryRun) {
      await client.query(
        `INSERT INTO promotion_runs (id, dry_run, summary) VALUES ($1, $2, $3)`,
        [runId, false, JSON.stringify(result)],
      );
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
