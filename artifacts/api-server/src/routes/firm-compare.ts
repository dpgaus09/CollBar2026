import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { db, BARGAINING_UNITS } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireFirmSession } from "../lib/firm-access.js";
import { verifyDocumentAccessToken } from "../lib/documentToken.js";
import { streamObjectTo, uploadedCbaKey } from "../lib/objectStorage.js";

// ============================================================================
// Phase 3 — Cross-District Comparison Matrix (firm attorney workspace).
//
// Districts (rows) × a CURATED set of provision/settlement metrics (columns).
// Every value is computed from STORED structured data — there is no LLM call on
// this path. Every cell carries full provenance (provision/settlement id,
// source_url, page_ref, retrieved_at, confidence, human_verified) and a value
// is only ever shown when it can be cited (non-null value AND a source_url);
// otherwise the cell is absent and the UI renders an empty indicator. Nothing
// is fabricated.
//
// ENTITLEMENT: this surface lives in the firm workspace and is guarded by
// requireFirmSession (firm_members membership). It deliberately does NOT reuse
// the per-district CFO gate()/isFree() rules — firm members are users.plan
// 'free', so reusing isFree() would mask the verbatim clause text and block
// peer-district PDFs, defeating the feature. Firm membership IS the entitlement
// here; the two systems share no enforcement code.
// ============================================================================

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Column catalog — the only metrics that can be requested. Column ids are
// validated against this server-side constant; arbitrary/free-form provision
// keys are NOT accepted (keeps the matrix bounded and the SQL predictable).
//
//  - source 'settlement'  -> a column on the latest `settlements` row. These
//    are the curated, often human-verified salary-settlement figures. They have
//    no verbatim clause text (clauseExcerpt is always null — we never synthesize
//    one), but they still carry full provenance + the source PDF.
//  - source 'provision'   -> a contract_provisions row keyed by provision_key on
//    the district's latest contract. These carry the verbatim clause_excerpt.
// ---------------------------------------------------------------------------
type ColumnSource = "settlement" | "provision";
type ColumnKind = "pct" | "money" | "count" | "years" | "bool" | "text";

interface ColumnDef {
  id: string;
  label: string;
  source: ColumnSource;
  kind: ColumnKind;
  unit: string | null;
  // settlement: the snake_case DB column; provision: the provision_key.
  field: string;
  group: string;
}

const COLUMN_CATALOG: ColumnDef[] = [
  {
    id: "settlement.base_increase_pct",
    label: "Base increase — yr 1",
    source: "settlement",
    kind: "pct",
    unit: "%",
    field: "base_increase_pct",
    group: "Salary settlement",
  },
  {
    id: "settlement.year2_pct",
    label: "Base increase — yr 2",
    source: "settlement",
    kind: "pct",
    unit: "%",
    field: "year2_pct",
    group: "Salary settlement",
  },
  {
    id: "settlement.year3_pct",
    label: "Base increase — yr 3",
    source: "settlement",
    kind: "pct",
    unit: "%",
    field: "year3_pct",
    group: "Salary settlement",
  },
  {
    id: "settlement.off_schedule_payment",
    label: "Off-schedule / lump sum",
    source: "settlement",
    kind: "money",
    unit: "$",
    field: "off_schedule_payment",
    group: "Salary settlement",
  },
  {
    id: "settlement.term_years",
    label: "Contract term",
    source: "settlement",
    kind: "years",
    unit: "yr",
    field: "term_years",
    group: "Salary settlement",
  },
  {
    id: "settlement.insurance_changed",
    label: "Insurance changed",
    source: "settlement",
    kind: "bool",
    unit: null,
    field: "insurance_changed",
    group: "Salary settlement",
  },
  {
    id: "settlement.method",
    label: "Settlement method",
    source: "settlement",
    kind: "text",
    unit: null,
    field: "method",
    group: "Salary settlement",
  },
  {
    id: "provision.ba_min_salary",
    label: "BA min salary",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "ba_min_salary",
    group: "Salary schedule",
  },
  {
    id: "provision.ba_max_salary",
    label: "BA max salary",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "ba_max_salary",
    group: "Salary schedule",
  },
  {
    id: "provision.ma_min_salary",
    label: "MA min salary",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "ma_min_salary",
    group: "Salary schedule",
  },
  {
    id: "provision.ma_max_salary",
    label: "MA max salary",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "ma_max_salary",
    group: "Salary schedule",
  },
  {
    id: "provision.salary_steps_count",
    label: "Salary steps",
    source: "provision",
    kind: "count",
    unit: null,
    field: "salary_steps_count",
    group: "Salary schedule",
  },
  {
    id: "provision.salary_lanes_count",
    label: "Salary lanes",
    source: "provision",
    kind: "count",
    unit: null,
    field: "salary_lanes_count",
    group: "Salary schedule",
  },
  {
    id: "provision.off_schedule_bonus_yr1",
    label: "Off-schedule bonus — yr 1",
    source: "provision",
    kind: "money",
    unit: "$",
    field: "off_schedule_bonus_yr1",
    group: "Salary schedule",
  },
];

const CATALOG_BY_ID = new Map(COLUMN_CATALOG.map((c) => [c.id, c]));

const DEFAULT_COLUMN_IDS = [
  "settlement.base_increase_pct",
  "settlement.year2_pct",
  "settlement.year3_pct",
  "settlement.off_schedule_payment",
  "settlement.term_years",
  "provision.ba_min_salary",
  "provision.ma_min_salary",
  "provision.salary_steps_count",
];

// Bound the matrix so one request can't fan out into an unbounded scan.
const MAX_DISTRICTS = 60;

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function publicColumn(c: ColumnDef) {
  return {
    id: c.id,
    label: c.label,
    source: c.source,
    kind: c.kind,
    unit: c.unit,
    group: c.group,
  };
}

// The full set of districts a firm may compare: everything on its roster plus
// every district attached to one of its matters. Used to authorize an explicit
// districtIds request (the matterId path is authorized by firm ownership of the
// matter itself).
async function firmScopeDistrictIds(firmId: number): Promise<Set<number>> {
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

interface Cell {
  value: number | string | boolean;
  kind: ColumnKind;
  unit: string | null;
  confidence: number | null;
  humanVerified: boolean;
  verifiedBy: string | null;
  provisionId: number | null;
  settlementId: number | null;
  clauseExcerpt: string | null;
  pageRef: number | null;
  sourceUrl: string | null;
  retrievedAt: string | null;
}

// ---------------------------------------------------------------------------
// POST /api/firm/compare
//   { matterId?, districtIds?, bargainingUnit?='teachers', columns?:string[] }
// Returns { bargainingUnit, matterId, matterName, districts[], columns[],
//           catalog[], cells: { [districtId]: { [columnId]: Cell } } }.
// A POST (not GET) because the district id set and column list are sent in the
// body; it is a pure read with no side effects.
// ---------------------------------------------------------------------------
router.post(
  "/firm/compare",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const body = req.body as {
      matterId?: unknown;
      districtIds?: unknown;
      bargainingUnit?: unknown;
      columns?: unknown;
    };

    // Bargaining unit — whitelist-validated, default teachers. Benchmarks never
    // mix units (the SQL filters contracts/settlements by this unit).
    const unit =
      typeof body.bargainingUnit === "string" &&
      (BARGAINING_UNITS as readonly string[]).includes(body.bargainingUnit)
        ? body.bargainingUnit
        : "teachers";

    // Columns — the request must be a SUBSET of the catalog. An empty array, a
    // non-string id, or any unknown id is rejected; we do NOT silently drop
    // unknown ids (that would hide a client bug and return a matrix the caller
    // never asked for). Omitting `columns` falls back to the default set.
    let columnIds: string[];
    if (Array.isArray(body.columns)) {
      const requested = body.columns as unknown[];
      const allValid = requested.every(
        (c) => typeof c === "string" && CATALOG_BY_ID.has(c),
      );
      if (requested.length === 0 || !allValid) {
        res
          .status(400)
          .json({ error: "Invalid or unknown column id(s) requested." });
        return;
      }
      columnIds = requested as string[];
    } else {
      columnIds = DEFAULT_COLUMN_IDS;
    }
    // De-dupe while preserving order.
    columnIds = [...new Set(columnIds)];
    const columns = columnIds.map((id) => CATALOG_BY_ID.get(id)!);

    // matterId XOR districtIds — providing both is ambiguous, so reject rather
    // than silently letting one path win.
    if (body.matterId != null && Array.isArray(body.districtIds)) {
      res
        .status(400)
        .json({ error: "Provide either matterId or districtIds, not both." });
      return;
    }

    // Resolve the district set + authorize it against the firm.
    const districtRoles = new Map<number, string | null>();
    let matterId: number | null = null;
    let matterName: string | null = null;

    const mid = toInt(body.matterId);
    if (mid != null) {
      // Matter path — the matter must belong to the caller's firm (no existence
      // leak: a cross-firm id is a 404). Its districts are inherently in scope.
      const m = await db.execute(sql`
        SELECT id, name FROM matters
        WHERE id = ${mid} AND firm_id = ${firm.firmId}
        LIMIT 1
      `);
      if (m.rows.length === 0) {
        res.status(404).json({ error: "Matter not found" });
        return;
      }
      matterId = mid;
      matterName = String((m.rows[0] as { name: unknown }).name);
      const r = await db.execute(sql`
        SELECT district_id, role FROM matter_districts WHERE matter_id = ${mid}
      `);
      for (const row of r.rows as Array<{
        district_id: unknown;
        role: unknown;
      }>) {
        districtRoles.set(Number(row.district_id), String(row.role));
      }
    } else if (Array.isArray(body.districtIds)) {
      // Explicit ids — every one MUST be inside the firm's scope, else 403. We
      // reject the whole request rather than silently dropping ids (silent drop
      // would hide an authorization mistake and mislead the user).
      const ids = (body.districtIds as unknown[])
        .map(toInt)
        .filter((n): n is number => n != null);
      const scope = await firmScopeDistrictIds(firm.firmId);
      for (const id of ids) {
        if (!scope.has(id)) {
          res.status(403).json({
            error: "FORBIDDEN_DISTRICT",
            message: "One or more districts are outside your workspace.",
          });
          return;
        }
        districtRoles.set(id, null);
      }
    } else {
      res.status(400).json({ error: "Provide a matterId or districtIds." });
      return;
    }

    const districtIds = [...districtRoles.keys()];
    if (districtIds.length === 0) {
      res.json({
        bargainingUnit: unit,
        matterId,
        matterName,
        districts: [],
        columns: columns.map(publicColumn),
        catalog: COLUMN_CATALOG.map(publicColumn),
        cells: {},
      });
      return;
    }
    if (districtIds.length > MAX_DISTRICTS) {
      res
        .status(400)
        .json({ error: `Too many districts (max ${MAX_DISTRICTS}).` });
      return;
    }

    try {
      const idList = sql.join(
        districtIds.map((id) => sql`${id}`),
        sql`, `,
      );

      // District metadata for the rows. Ordered client → peer → alpha so the
      // matter's client district leads the matrix.
      const dmeta = await db.execute(sql`
        SELECT id, name, county, district_type, enrollment, state
        FROM districts WHERE id IN (${idList})
      `);
      const districts = (
        dmeta.rows as Array<{
          id: unknown;
          name: unknown;
          county: unknown;
          district_type: unknown;
          enrollment: unknown;
          state: unknown;
        }>
      )
        .map((row) => ({
          districtId: Number(row.id),
          name: String(row.name),
          county: row.county == null ? null : String(row.county),
          districtType:
            row.district_type == null ? null : String(row.district_type),
          enrollment: row.enrollment == null ? null : Number(row.enrollment),
          state: String(row.state ?? ""),
          role: districtRoles.get(Number(row.id)) ?? null,
        }))
        .sort((a, b) => {
          const rank = (r: string | null) =>
            r === "client" ? 0 : r === "peer" ? 1 : 2;
          const rr = rank(a.role) - rank(b.role);
          return rr !== 0 ? rr : a.name.localeCompare(b.name);
        });

      const cells: Record<string, Record<string, Cell>> = {};

      // --- Provision cells -------------------------------------------------
      // The latest contract per district (effective_end, then effective_start,
      // then id) anchors which contract_provisions we read, so we never surface
      // a stale prior contract's value. For each (district, provision_key) we
      // pick the single best row: human-verified first, then highest
      // confidence, then newest. The contract's source_doc supplies the
      // citation; a row with no value or no citable source_url is excluded.
      const provColumns = columns.filter((c) => c.source === "provision");
      if (provColumns.length > 0) {
        const keyList = sql.join(
          provColumns.map((c) => sql`${c.field}`),
          sql`, `,
        );
        const r = await db.execute(sql`
          WITH latest_contract AS (
            SELECT DISTINCT ON (c.district_id)
              c.id, c.district_id, c.source_doc_id
            FROM contracts c
            WHERE c.district_id IN (${idList})
              AND c.bargaining_unit = ${unit}
            ORDER BY c.district_id,
                     c.effective_end DESC NULLS LAST,
                     c.effective_start DESC NULLS LAST,
                     c.id DESC
          )
          SELECT DISTINCT ON (lc.district_id, cp.provision_key)
            lc.district_id,
            cp.id AS provision_id,
            cp.provision_key,
            cp.value_numeric,
            cp.value_text,
            cp.unit,
            cp.clause_excerpt,
            cp.page_ref,
            cp.confidence,
            cp.human_verified,
            sd.source_url,
            sd.retrieved_at
          FROM latest_contract lc
          JOIN contract_provisions cp ON cp.contract_id = lc.id
          JOIN source_documents sd ON sd.id = lc.source_doc_id
          WHERE cp.provision_key IN (${keyList})
            AND (
              cp.value_numeric IS NOT NULL
              OR (cp.value_text IS NOT NULL AND btrim(cp.value_text) <> '')
            )
            AND sd.source_url IS NOT NULL
            -- Provision cells must carry a verbatim clause excerpt (the value is
            -- derived from that clause). A cited value with no excerpt cannot be
            -- verified against source language, so it is excluded; the best
            -- EXCERPT-BEARING provision per key is then chosen by DISTINCT ON.
            AND cp.clause_excerpt IS NOT NULL
            AND btrim(cp.clause_excerpt) <> ''
          ORDER BY lc.district_id, cp.provision_key,
                   cp.human_verified DESC NULLS LAST,
                   cp.confidence DESC NULLS LAST,
                   cp.id DESC
        `);
        const provByField = new Map(provColumns.map((c) => [c.field, c]));
        for (const row of r.rows as Array<Record<string, unknown>>) {
          const col = provByField.get(String(row.provision_key));
          if (!col) continue;
          const did = Number(row.district_id);
          const valueNumeric =
            row.value_numeric == null ? null : Number(row.value_numeric);
          const value =
            valueNumeric != null ? valueNumeric : String(row.value_text);
          const cell: Cell = {
            value,
            kind: col.kind,
            unit: col.unit,
            confidence: row.confidence == null ? null : Number(row.confidence),
            humanVerified: row.human_verified === true,
            verifiedBy: null,
            provisionId: Number(row.provision_id),
            settlementId: null,
            clauseExcerpt:
              row.clause_excerpt == null ? null : String(row.clause_excerpt),
            pageRef: row.page_ref == null ? null : Number(row.page_ref),
            sourceUrl: row.source_url == null ? null : String(row.source_url),
            retrievedAt:
              row.retrieved_at == null ? null : String(row.retrieved_at),
          };
          (cells[did] ??= {})[col.id] = cell;
        }
      }

      // --- Settlement cells ------------------------------------------------
      // Pick the LATEST settlement per district FIRST (CTE), then LEFT JOIN its
      // citation. Anchoring the latest row before the citation check means we can
      // never fall back to an older, cited settlement when the newest one is
      // uncited: an uncited latest settlement yields a null source_url and is
      // skipped below, leaving the district with no settlement cells (empty,
      // never stale). Each requested metric is unpivoted from that single row; a
      // null metric is skipped.
      const setColumns = columns.filter((c) => c.source === "settlement");
      if (setColumns.length > 0) {
        const r = await db.execute(sql`
          WITH latest_settlement AS (
            SELECT DISTINCT ON (s.district_id)
              s.id, s.district_id,
              s.base_increase_pct, s.year2_pct, s.year3_pct,
              s.off_schedule_payment, s.term_years, s.insurance_changed, s.method,
              s.confidence, s.human_verified, s.verified_by, s.page_ref,
              s.source_doc_id
            FROM settlements s
            WHERE s.district_id IN (${idList})
              AND s.bargaining_unit = ${unit}
            ORDER BY s.district_id,
                     COALESCE(s.to_year, s.from_year) DESC NULLS LAST,
                     s.id DESC
          )
          SELECT
            ls.id, ls.district_id,
            ls.base_increase_pct, ls.year2_pct, ls.year3_pct,
            ls.off_schedule_payment, ls.term_years, ls.insurance_changed, ls.method,
            ls.confidence, ls.human_verified, ls.verified_by, ls.page_ref,
            sd.source_url, sd.retrieved_at
          FROM latest_settlement ls
          LEFT JOIN source_documents sd ON sd.id = ls.source_doc_id
        `);
        for (const row of r.rows as Array<Record<string, unknown>>) {
          const did = Number(row.district_id);
          const sourceUrl =
            row.source_url == null ? null : String(row.source_url);
          if (!sourceUrl) continue; // citation mandatory
          for (const col of setColumns) {
            const raw = row[col.field];
            if (raw == null) continue;
            let value: number | string | boolean;
            if (col.kind === "bool") {
              value = raw === true;
            } else if (col.kind === "text") {
              const s = String(raw).trim();
              if (!s) continue;
              value = s;
            } else {
              value = Number(raw);
            }
            const cell: Cell = {
              value,
              kind: col.kind,
              unit: col.unit,
              confidence:
                row.confidence == null ? null : Number(row.confidence),
              humanVerified: row.human_verified === true,
              verifiedBy:
                row.verified_by == null ? null : String(row.verified_by),
              provisionId: null,
              settlementId: Number(row.id),
              clauseExcerpt: null,
              pageRef: row.page_ref == null ? null : Number(row.page_ref),
              sourceUrl,
              retrievedAt:
                row.retrieved_at == null ? null : String(row.retrieved_at),
            };
            (cells[did] ??= {})[col.id] = cell;
          }
        }
      }

      res.json({
        bargainingUnit: unit,
        matterId,
        matterName,
        districts,
        columns: columns.map(publicColumn),
        catalog: COLUMN_CATALOG.map(publicColumn),
        cells,
      });
    } catch (err) {
      console.error("firm compare error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/firm/document?src=upload://...&token=...
// Streams an uploaded CBA PDF for the firm workspace. Mirrors the dashboard
// document route's streaming/error behavior but authorizes by FIRM SCOPE rather
// than gate()/isFree(): the document's district must be tracked by — or in a
// matter of — a firm the caller belongs to. This keeps the firm workspace's
// peer-district PDFs reachable without weakening the per-district dashboard
// route (which stays free/pro gated and IL-only).
// ---------------------------------------------------------------------------
function sendFirmDocError(
  req: Request,
  res: Response,
  status: number,
  error: string,
  message?: string,
): void {
  // "View source PDF" links open in a new top-level tab; on failure show a
  // small readable HTML page for genuine navigations, JSON for XHR/tests.
  if (req.headers["sec-fetch-dest"] === "document") {
    const heading =
      status === 401
        ? "Sign-in required"
        : status === 403
          ? "Access restricted"
          : "Document unavailable";
    const detail =
      message ??
      (status === 404
        ? "This source document could not be found. It may not have been saved to storage yet."
        : status === 401
          ? "Your session has expired. Return to CollBar and sign in again to view this document."
          : "We couldn't open this document.");
    res
      .status(status)
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<title>${heading}</title>` +
          `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
          `background:#020617;color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}` +
          `.card{max-width:28rem;padding:2rem;text-align:center}` +
          `h1{font-size:1.1rem;margin:0 0 .5rem;color:#f1f5f9}` +
          `p{font-size:.85rem;line-height:1.5;color:#94a3b8;margin:0}</style></head>` +
          `<body><div class="card"><h1>${heading}</h1><p>${detail}</p></div></body></html>`,
      );
    return;
  }
  res.status(status).json(message ? { error, message } : { error });
}

router.get("/firm/document", async (req: Request, res: Response) => {
  // Resolve the caller from the session cookie OR a self-contained signed
  // token (new-tab links don't carry the SameSite=Lax cookie in the cross-site
  // Replit preview). The token only proves identity; firm-scope authorization
  // is re-applied below.
  let userId: number | null = null;
  if (req.session?.userId) {
    userId = Number(req.session.userId);
  } else {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    userId = token ? verifyDocumentAccessToken(token) : null;
  }
  if (userId == null) {
    sendFirmDocError(req, res, 401, "Authentication required");
    return;
  }

  const src = typeof req.query.src === "string" ? req.query.src : "";
  if (!src.startsWith("upload://")) {
    sendFirmDocError(req, res, 400, "Unsupported document source");
    return;
  }

  try {
    const result = await db.execute(sql`
      SELECT storage_key, district_id, file_hash
      FROM source_documents
      WHERE source_url = ${src}
      LIMIT 1
    `);
    const row = result.rows[0] as
      | {
          storage_key: string | null;
          district_id: number | null;
          file_hash: string | null;
        }
      | undefined;
    if (!row || !row.storage_key) {
      sendFirmDocError(req, res, 404, "Document not found");
      return;
    }
    const docDistrictId =
      row.district_id == null ? null : Number(row.district_id);
    if (docDistrictId == null) {
      sendFirmDocError(req, res, 404, "Document not found");
      return;
    }

    // Firm-scope authorization: the doc's district must be tracked by — or in a
    // matter of — a firm this user belongs to. Firm membership is the
    // entitlement (independent of users.plan / gate()).
    const authed = await db.execute(sql`
      SELECT 1
      FROM firm_members fm
      WHERE fm.user_id = ${userId}
        AND (
          EXISTS (
            SELECT 1 FROM tracked_districts td
            WHERE td.firm_id = fm.firm_id AND td.district_id = ${docDistrictId}
          )
          OR EXISTS (
            SELECT 1 FROM matters m
            JOIN matter_districts md ON md.matter_id = m.id
            WHERE m.firm_id = fm.firm_id AND md.district_id = ${docDistrictId}
          )
        )
      LIMIT 1
    `);
    if (authed.rows.length === 0) {
      sendFirmDocError(
        req,
        res,
        403,
        "FORBIDDEN_DISTRICT",
        "This document is outside your workspace.",
      );
      return;
    }

    // Primary path: stream from object storage (the only copy that exists in
    // production). Falls back to a local dev file when present.
    if (row.file_hash) {
      const streamed = await streamObjectTo(uploadedCbaKey(row.file_hash), res);
      if (streamed) return;
    }
    if (row.storage_key.startsWith("local:")) {
      const absPath = row.storage_key.slice("local:".length);
      if (absPath.endsWith(".pdf")) {
        const { existsSync, createReadStream } = await import("fs");
        if (existsSync(absPath)) {
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", "inline");
          createReadStream(absPath).pipe(res);
          return;
        }
      }
    }
    sendFirmDocError(req, res, 404, "Document file missing");
  } catch (err) {
    console.error("firm document error:", err);
    sendFirmDocError(req, res, 500, "Internal server error");
  }
});

export default router;
