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
import { CUSTOMER_STATE } from "../lib/dashboard-query.js";
import { streamObjectTo, uploadedCbaKey } from "../lib/objectStorage.js";
import {
  CATALOG_BY_ID,
  DEFAULT_COLUMN_IDS,
  buildMatrix,
} from "../lib/firm-compare-model.js";

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

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
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

    // matterId XOR districtIds — providing both is ambiguous, so reject rather
    // than silently letting one path win.
    if (body.matterId != null && Array.isArray(body.districtIds)) {
      res
        .status(400)
        .json({ error: "Provide either matterId or districtIds, not both." });
      return;
    }

    const matterId = toInt(body.matterId);
    const districtIds = Array.isArray(body.districtIds)
      ? (body.districtIds as unknown[])
          .map(toInt)
          .filter((n): n is number => n != null)
      : null;

    try {
      // Single source of truth: the export builders call the same buildMatrix(),
      // so a generated memo/exhibit cites byte-for-byte what the matrix shows.
      const result = await buildMatrix(firm.firmId, {
        matterId,
        districtIds,
        unit,
        columnIds,
      });
      if (!result.ok) {
        res
          .status(result.status)
          .json(
            result.message
              ? { error: result.error, message: result.message }
              : { error: result.error },
          );
        return;
      }
      res.json(result.data);
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

    // Firm-scope authorization. The caller must be a firm member, and the doc's
    // district must be either (a) inside that firm's workspace — tracked or in a
    // matter — or (b) any district in CUSTOMER_STATE. (b) backs the "Entire
    // database" clause scope, whose results span the whole IL corpus; without it
    // the ~9% of IL clauses sourced from upload:// PDFs would 403 when opened.
    // The CUSTOMER_STATE bound keeps the deliberately-hidden non-IL docs 403,
    // and firm membership remains required (this never widens access for
    // non-firm users; the per-district dashboard route stays gate()-governed).
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
          OR EXISTS (
            SELECT 1 FROM districts d
            WHERE d.id = ${docDistrictId} AND d.state = ${CUSTOMER_STATE}
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
