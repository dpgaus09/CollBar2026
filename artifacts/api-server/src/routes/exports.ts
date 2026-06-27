import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireFirmSession } from "../lib/firm-access.js";
import { parseUnit } from "./bargaining-units.js";
import { logger } from "../lib/logger.js";
import {
  uploadBuffer,
  streamObjectTo,
  attachmentDisposition,
} from "../lib/objectStorage.js";
import {
  EXPORT_TYPES,
  EXPORT_FORMATS,
  buildComparisonMemoModel,
  buildBenchmarkExhibitModel,
  buildClauseAppendixModel,
  type ExportType,
  type ExportFormat,
  type ExportModelResult,
} from "./exports/model.js";
import { renderExportPdf } from "./exports/pdf.js";
import { renderExportDocx } from "./exports/docx.js";
import { buildClauseCompare } from "../lib/firm-clauses-model.js";

// ============================================================================
// Phase 5 — Work-product exports (firm workspace billable deliverables).
//
// Generate a comparison memo / benchmark exhibit / clause appendix from a firm
// MATTER, rendered to PDF or DOCX, then persist the bytes to Object Storage and
// index the file in firm_exports so the firm can list + re-download prior work.
//
// HARD INVARIANTS:
//  - No new analysis: the document is rendered ONLY from buildMatrix /
//    buildClauseCompare output (the same queries the UI uses), so every figure
//    and clause matches on-screen provenance EXACTLY.
//  - Object-storage write MUST succeed before the firm_exports row is inserted —
//    a row whose bytes don't exist would 404 on download (the durability bug we
//    refuse to ship). If the upload throws, no row is written.
//  - Entitlement is requireFirmSession (firm membership) — NEVER gate()/isFree().
//    A matter or export id belonging to another firm is a 404 (no existence leak).
// ============================================================================

const router: IRouter = Router();

const MAX_PROVISION_KEYS = 15;
const MAX_TITLE_LEN = 200;

const CONTENT_TYPE: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseType(v: unknown): ExportType | null {
  return EXPORT_TYPES.includes(v as ExportType) ? (v as ExportType) : null;
}
function parseFormat(v: unknown): ExportFormat | null {
  return EXPORT_FORMATS.includes(v as ExportFormat) ? (v as ExportFormat) : null;
}

// A filesystem-safe slug for the download filename, derived from the document
// title. Falls back to the export type when the title has no usable characters.
function slugify(title: string, fallback: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s || fallback;
}

// ---------------------------------------------------------------------------
// POST /api/firm/exports
//   { matterId, type, format, bargainingUnit?, provisionKeys?, columnIds?, title? }
// Builds the document model, renders it, uploads the bytes, then records the row.
// ---------------------------------------------------------------------------
router.post(
  "/firm/exports",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const body = req.body as {
      matterId?: unknown;
      type?: unknown;
      format?: unknown;
      bargainingUnit?: unknown;
      provisionKeys?: unknown;
      columnIds?: unknown;
      title?: unknown;
    };

    const type = parseType(body.type);
    if (!type) {
      res.status(400).json({ error: "Invalid export type." });
      return;
    }
    const format = parseFormat(body.format);
    if (!format) {
      res.status(400).json({ error: "Invalid export format." });
      return;
    }
    const matterId = toInt(body.matterId);
    if (matterId == null) {
      res.status(400).json({ error: "matterId is required." });
      return;
    }
    const unit = parseUnit(body.bargainingUnit);
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, MAX_TITLE_LEN)
        : undefined;
    const columnIds = Array.isArray(body.columnIds)
      ? (body.columnIds as unknown[]).map(String)
      : undefined;

    // Resolve + firm-scope the matter up front. A cross-firm (or missing) matter
    // is a 404 with no existence leak, and gives us the matter_name snapshot.
    const m = await db.execute(sql`
      SELECT name FROM matters
      WHERE id = ${matterId} AND firm_id = ${firm.firmId}
      LIMIT 1
    `);
    const matterRow = m.rows[0] as { name: unknown } | undefined;
    if (!matterRow) {
      res.status(404).json({ error: "Matter not found." });
      return;
    }
    const matterName = String(matterRow.name);

    // The generating user's display name, snapshotted onto the row so a delivered
    // document stays attributable after the user is removed.
    const u = await db.execute(sql`
      SELECT COALESCE(name, email) AS display FROM users WHERE id = ${firm.userId} LIMIT 1
    `);
    const generatedByName =
      (u.rows[0] as { display: unknown } | undefined)?.display != null
        ? String((u.rows[0] as { display: unknown }).display)
        : null;
    const generatedAt = new Date().toISOString();

    // Build the document model (no rendering yet) — this is the only place the
    // data is read, and it enforces the same firm scope as the live views.
    let modelResult: ExportModelResult;
    try {
      if (type === "clause_appendix") {
        const rawKeys = Array.isArray(body.provisionKeys)
          ? (body.provisionKeys as unknown[])
              .filter((k): k is string => typeof k === "string" && k.trim() !== "")
              .map((k) => k.trim())
          : [];
        const provisionKeys = [...new Set(rawKeys)];
        if (provisionKeys.length === 0) {
          res
            .status(400)
            .json({ error: "Select at least one provision for the clause appendix." });
          return;
        }
        if (provisionKeys.length > MAX_PROVISION_KEYS) {
          res.status(400).json({
            error: `Select at most ${MAX_PROVISION_KEYS} provisions.`,
          });
          return;
        }
        // Validate the requested provisions against what is actually available
        // in the matter's scope (same source as the on-screen picker).
        const avail = await buildClauseCompare(firm.firmId, {
          scope: "matter",
          matterId,
          districtIds: null,
          unit,
          provisionKey: null,
        });
        if (!avail.ok) {
          res.status(avail.status).json({ error: avail.error });
          return;
        }
        const availableSet = new Set(
          avail.data.availableTypes.map((t) => t.provisionKey),
        );
        const unknown = provisionKeys.filter((k) => !availableSet.has(k));
        if (unknown.length > 0) {
          res.status(400).json({
            error: `Provision(s) not available in this matter: ${unknown.join(", ")}`,
          });
          return;
        }
        modelResult = await buildClauseAppendixModel(firm.firmId, {
          scope: "matter",
          matterId,
          unit,
          provisionKeys,
          title,
          generatedByName,
          generatedAt,
        });
      } else if (type === "benchmark_exhibit") {
        modelResult = await buildBenchmarkExhibitModel(firm.firmId, {
          matterId,
          unit,
          columnIds,
          title,
          generatedByName,
          generatedAt,
        });
      } else {
        modelResult = await buildComparisonMemoModel(firm.firmId, {
          matterId,
          unit,
          columnIds,
          title,
          generatedByName,
          generatedAt,
        });
      }
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "export model build failed");
      res.status(500).json({ error: "Failed to build the export." });
      return;
    }

    if (!modelResult.ok) {
      res.status(modelResult.status).json({ error: modelResult.error });
      return;
    }
    const model = modelResult.model;

    // Render to the requested format.
    let buf: Buffer;
    try {
      buf =
        format === "pdf"
          ? await renderExportPdf(model)
          : await renderExportDocx(model);
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "export render failed");
      res.status(500).json({ error: "Failed to render the export." });
      return;
    }

    const objectKey = `firm_exports/${firm.firmId}/${randomUUID()}.${format}`;

    // INVARIANT: persist the bytes BEFORE recording the row. If the upload
    // fails, we record nothing — a row without bytes would 404 on download.
    try {
      await uploadBuffer(objectKey, buf, CONTENT_TYPE[format]);
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "export object upload failed");
      res
        .status(502)
        .json({ error: "Could not save the export. Please try again." });
      return;
    }

    let inserted: { id: unknown; created_at: unknown } | undefined;
    try {
      const r = await db.execute(sql`
        INSERT INTO firm_exports
          (firm_id, matter_id, matter_name, type, format, object_key, title,
           bargaining_unit, file_size, generated_by, generated_by_name)
        VALUES
          (${firm.firmId}, ${matterId}, ${matterName}, ${type}, ${format},
           ${objectKey}, ${model.meta.title}, ${unit}, ${buf.length},
           ${firm.userId}, ${generatedByName})
        RETURNING id, created_at
      `);
      inserted = r.rows[0] as { id: unknown; created_at: unknown };
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "export row insert failed");
      res.status(500).json({ error: "Could not record the export." });
      return;
    }

    res.status(201).json({
      id: Number(inserted.id),
      matterId,
      matterName,
      type,
      format,
      title: model.meta.title,
      bargainingUnit: unit,
      fileSize: buf.length,
      generatedByName,
      createdAt:
        inserted.created_at == null ? null : String(inserted.created_at),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /api/firm/exports — list this firm's prior exports, newest first.
// ---------------------------------------------------------------------------
router.get(
  "/firm/exports",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    try {
      const r = await db.execute(sql`
        SELECT id, matter_id, matter_name, type, format, title, bargaining_unit,
               file_size, generated_by_name, created_at
        FROM firm_exports
        WHERE firm_id = ${firm.firmId}
        ORDER BY created_at DESC, id DESC
      `);
      const exports = (r.rows as Array<Record<string, unknown>>).map((row) => ({
        id: Number(row.id),
        matterId: row.matter_id == null ? null : Number(row.matter_id),
        matterName: String(row.matter_name ?? ""),
        type: String(row.type),
        format: String(row.format),
        title: String(row.title ?? ""),
        bargainingUnit: String(row.bargaining_unit ?? ""),
        fileSize: row.file_size == null ? null : Number(row.file_size),
        generatedByName:
          row.generated_by_name == null ? null : String(row.generated_by_name),
        createdAt: row.created_at == null ? null : String(row.created_at),
      }));
      res.json({ exports });
    } catch (err) {
      logger.error({ err, firmId: firm.firmId }, "export list failed");
      res.status(500).json({ error: "Could not load exports." });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/firm/exports/:id/download — stream the stored bytes as an attachment.
// Firm-scoped: another firm's export id is a 404 (no existence leak).
// ---------------------------------------------------------------------------
router.get(
  "/firm/exports/:id/download",
  requireFirmSession(),
  async (req: Request, res: Response) => {
    const firm = req.firmAccess!;
    const id = toInt(req.params.id);
    if (id == null) {
      res.status(404).json({ error: "Export not found." });
      return;
    }
    const r = await db.execute(sql`
      SELECT object_key, format, title
      FROM firm_exports
      WHERE id = ${id} AND firm_id = ${firm.firmId}
      LIMIT 1
    `);
    const row = r.rows[0] as
      | { object_key: unknown; format: unknown; title: unknown }
      | undefined;
    if (!row) {
      res.status(404).json({ error: "Export not found." });
      return;
    }
    const format = String(row.format) as ExportFormat;
    const objectKey = String(row.object_key);
    const filename = `${slugify(String(row.title ?? ""), "export")}.${format}`;
    const contentType = CONTENT_TYPE[format] ?? "application/octet-stream";

    try {
      const ok = await streamObjectTo(
        objectKey,
        res,
        contentType,
        attachmentDisposition(filename),
      );
      if (!ok) {
        res.status(404).json({ error: "Document file missing." });
      }
    } catch (err) {
      logger.error({ err, firmId: firm.firmId, id }, "export download failed");
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not download the export." });
      }
    }
  },
);

export default router;
