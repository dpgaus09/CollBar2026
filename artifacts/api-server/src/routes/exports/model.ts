import {
  buildMatrix,
  COLUMN_CATALOG,
  DEFAULT_COLUMN_IDS,
  type Cell,
  type MatrixPayload,
} from "../../lib/firm-compare-model.js";
import {
  buildClauseCompare,
  prettyKey,
  type ClauseScope,
  type ClauseRow,
} from "../../lib/firm-clauses-model.js";

// ============================================================================
// Phase 5 — Work-product export document model.
//
// A single, presentational, source-agnostic intermediate representation (IR)
// that BOTH renderers (pdf.tsx and docx.ts) consume, so a memo and an exhibit
// of the same data are byte-for-byte identical in substance regardless of file
// format. The IR is produced ONLY from buildMatrix() / buildClauseCompare() —
// the exact same queries the on-screen comparison matrix and clause comparison
// use — so every figure and clause in an exported deliverable matches what the
// attorney saw on screen. There is NO new analysis here: we format stored,
// already-cited values; we never compute or infer.
//
// CITATIONS ARE MANDATORY. Every figure (table cell) and every clause carries a
// numbered citation (district, source url, page, retrieved date) collected into
// a document-wide "Sources" list. The citation fields are copied verbatim from
// buildMatrix/buildClauseCompare so they match on-screen provenance EXACTLY.
// ============================================================================

export type ExportType =
  | "comparison_memo"
  | "benchmark_exhibit"
  | "clause_appendix";
export type ExportFormat = "pdf" | "docx";

export const EXPORT_TYPES: ExportType[] = [
  "comparison_memo",
  "benchmark_exhibit",
  "clause_appendix",
];
export const EXPORT_FORMATS: ExportFormat[] = ["pdf", "docx"];

export const EXPORT_TYPE_LABEL: Record<ExportType, string> = {
  comparison_memo: "Comparison Memo",
  benchmark_exhibit: "Benchmark Exhibit",
  clause_appendix: "Clause Appendix",
};

// The canonical citation. These four fields are exactly the provenance shown on
// screen for every cited figure/clause; they are copied straight from
// buildMatrix/buildClauseCompare so an export can never disagree with the UI.
export interface Citation {
  district: string;
  sourceUrl: string | null;
  pageRef: number | null;
  retrievedAt: string | null;
}

export function citationKey(c: Citation): string {
  return [
    c.district,
    c.sourceUrl ?? "",
    c.pageRef ?? "",
    c.retrievedAt ?? "",
  ].join("|");
}

// Accumulates citations in first-appearance order with dedup by exact tuple, so
// repeated references to the same source share one footnote number.
export class CitationRegistry {
  private readonly byKey = new Map<string, number>();
  readonly list: Citation[] = [];

  add(c: Citation): number {
    const key = citationKey(c);
    const existing = this.byKey.get(key);
    if (existing != null) return existing;
    const num = this.list.length + 1;
    this.byKey.set(key, num);
    this.list.push(c);
    return num;
  }
}

export interface ExportMeta {
  type: ExportType;
  title: string;
  matterName: string | null;
  bargainingUnit: string | null;
  generatedByName: string | null;
  generatedAt: string; // ISO
}

export interface TableColumnModel {
  header: string;
  align: "left" | "right";
}
export interface TableCellModel {
  text: string;
  citationNumber: number | null;
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; columns: TableColumnModel[]; rows: TableCellModel[][] }
  | {
      kind: "clause";
      districtName: string;
      meta: string;
      excerpt: string;
      citationNumber: number;
    };

export interface ExportDocumentModel {
  meta: ExportMeta;
  blocks: Block[];
  citations: Citation[];
}

export type ExportModelResult =
  | { ok: true; model: ExportDocumentModel }
  | { ok: false; status: number; error: string };

// --------------------------------------------------------------------------
// Value formatting — replicated EXACTLY from the on-screen formatters so the
// figures in an export match the matrix character-for-character.
//   web: artifacts/collbar-web/src/pages/app/compare.tsx formatCellValue/prettifyText
//   web: artifacts/collbar-web/src/components/clause.tsx meta line
// toLocaleString is pinned to "en-US" (the browser's locale in practice) so the
// server render is deterministic. Keep these in lockstep with the web formatters.
// --------------------------------------------------------------------------
function prettifyText(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatCellValue(cell: Pick<Cell, "value" | "kind">): string {
  const v = cell.value;
  switch (cell.kind) {
    case "pct":
      return `${Number(v)}%`;
    case "money":
      return `$${Number(v).toLocaleString("en-US")}`;
    case "count":
      return Math.round(Number(v)).toLocaleString("en-US");
    case "years":
      return `${Number(v)} yr`;
    case "bool":
      return v ? "Yes" : "No";
    case "text":
      return prettifyText(String(v));
    default:
      return String(v);
  }
}

export function formatRetrieved(retrievedAt: string | null): string | null {
  if (!retrievedAt) return null;
  const d = new Date(retrievedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// The link target for a citation, matching firmSourceHref for web URLs (append
// #page=N). Uploaded documents (upload:// scheme) have no public URL in a
// standalone file, so they get a label instead of a broken link.
export function citationHref(c: Citation): string | null {
  const u = c.sourceUrl;
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) {
    return c.pageRef != null ? `${u}#page=${c.pageRef}` : u;
  }
  return null;
}

export function citationLabel(c: Citation): string {
  const u = c.sourceUrl;
  if (!u) return "Source unavailable";
  if (/^https?:\/\//i.test(u)) return u;
  if (/^upload:\/\//i.test(u)) return "Uploaded document";
  return u;
}

// The trailing "· p.12 · retrieved Jan 1, 2024" suffix for a citation line.
export function citationSuffix(c: Citation): string {
  const parts: string[] = [];
  if (c.pageRef != null) parts.push(`p.${c.pageRef}`);
  const r = formatRetrieved(c.retrievedAt);
  if (r) parts.push(`retrieved ${r}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function unitLabel(unit: string | null): string | null {
  return unit ? prettifyText(unit) : null;
}

function metaBlocks(meta: ExportMeta): Block[] {
  const lines: Block[] = [{ kind: "heading", level: 1, text: meta.title }];
  if (meta.matterName) {
    lines.push({ kind: "paragraph", text: `Matter: ${meta.matterName}` });
  }
  const u = unitLabel(meta.bargainingUnit);
  if (u) lines.push({ kind: "paragraph", text: `Bargaining unit: ${u}` });
  if (meta.generatedByName) {
    lines.push({ kind: "paragraph", text: `Prepared by: ${meta.generatedByName}` });
  }
  const gen = formatRetrieved(meta.generatedAt);
  if (gen) lines.push({ kind: "paragraph", text: `Generated: ${gen}` });
  return lines;
}

// --------------------------------------------------------------------------
// Matrix → table (shared by comparison memo and benchmark exhibit). The two
// types differ ONLY presentationally: the memo carries a short factual lead-in
// and the default column set; the exhibit is bare and may carry the full
// catalog. Neither adds analysis.
// --------------------------------------------------------------------------
function matrixTableBlocks(
  payload: MatrixPayload,
  registry: CitationRegistry,
): Block[] {
  const columns: TableColumnModel[] = [
    { header: "District", align: "left" },
    ...payload.columns.map((c) => ({
      header: c.label,
      align:
        c.kind === "text" || c.kind === "bool"
          ? ("left" as const)
          : ("right" as const),
    })),
  ];

  const rows: TableCellModel[][] = payload.districts.map((d) => {
    const row: TableCellModel[] = [
      { text: d.name, citationNumber: null },
    ];
    const cellsForDistrict = payload.cells[d.districtId] ?? {};
    for (const col of payload.columns) {
      const cell = cellsForDistrict[col.id];
      if (!cell) {
        row.push({ text: "—", citationNumber: null });
        continue;
      }
      const num = registry.add({
        district: d.name,
        sourceUrl: cell.sourceUrl,
        pageRef: cell.pageRef,
        retrievedAt: cell.retrievedAt,
      });
      row.push({ text: formatCellValue(cell), citationNumber: num });
    }
    return row;
  });

  return [{ kind: "table", columns, rows }];
}

export interface BuildMatrixModelOpts {
  matterId?: number | null;
  districtIds?: number[] | null;
  unit: string;
  columnIds?: string[];
  title?: string;
  generatedByName?: string | null;
  generatedAt?: string;
}

async function buildMatrixModel(
  firmId: number,
  type: "comparison_memo" | "benchmark_exhibit",
  opts: BuildMatrixModelOpts,
): Promise<ExportModelResult> {
  const columnIds =
    opts.columnIds && opts.columnIds.length > 0
      ? opts.columnIds.filter((id) =>
          COLUMN_CATALOG.some((c) => c.id === id),
        )
      : type === "benchmark_exhibit"
        ? COLUMN_CATALOG.map((c) => c.id)
        : DEFAULT_COLUMN_IDS;

  const result = await buildMatrix(firmId, {
    matterId: opts.matterId ?? null,
    districtIds: opts.districtIds ?? null,
    unit: opts.unit,
    columnIds,
  });
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error };
  }
  const payload = result.data;

  const defaultTitle =
    type === "comparison_memo" ? "Comparison Memo" : "Benchmark Exhibit";
  const meta: ExportMeta = {
    type,
    title:
      opts.title && opts.title.trim()
        ? opts.title.trim()
        : payload.matterName
          ? `${defaultTitle} — ${payload.matterName}`
          : defaultTitle,
    matterName: payload.matterName,
    bargainingUnit: payload.bargainingUnit,
    generatedByName: opts.generatedByName ?? null,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
  };

  const registry = new CitationRegistry();
  const blocks: Block[] = [...metaBlocks(meta)];

  if (type === "comparison_memo") {
    const n = payload.districts.length;
    const u = unitLabel(payload.bargainingUnit) ?? "the bargaining unit";
    blocks.push({
      kind: "paragraph",
      text:
        `This memorandum compares ${n} district${n === 1 ? "" : "s"} on the ` +
        `metrics below for ${u}. Every figure is drawn from the cited source ` +
        `document and matches the figure shown in the workspace comparison ` +
        `view. Figures without a citable source are omitted.`,
    });
  }

  if (payload.districts.length === 0) {
    blocks.push({
      kind: "paragraph",
      text: "No districts are in scope for this export.",
    });
  } else {
    blocks.push(...matrixTableBlocks(payload, registry));
  }

  return {
    ok: true,
    model: { meta, blocks, citations: registry.list },
  };
}

export function buildComparisonMemoModel(
  firmId: number,
  opts: BuildMatrixModelOpts,
): Promise<ExportModelResult> {
  return buildMatrixModel(firmId, "comparison_memo", opts);
}

export function buildBenchmarkExhibitModel(
  firmId: number,
  opts: BuildMatrixModelOpts,
): Promise<ExportModelResult> {
  return buildMatrixModel(firmId, "benchmark_exhibit", opts);
}

// --------------------------------------------------------------------------
// Clause appendix — verbatim clauses per selected provision type, each with its
// own citation. Built over buildClauseCompare (one call per provisionKey) so
// the clause language and provenance match the on-screen clause comparison.
// --------------------------------------------------------------------------
export interface BuildClauseAppendixOpts {
  scope: ClauseScope;
  matterId?: number | null;
  districtIds?: number[] | null;
  unit: string;
  provisionKeys: string[];
  title?: string;
  generatedByName?: string | null;
  generatedAt?: string;
}

function clauseMeta(clause: ClauseRow): string {
  return clause.county ? `${clause.county}, ${clause.state}` : clause.state;
}

export async function buildClauseAppendixModel(
  firmId: number,
  opts: BuildClauseAppendixOpts,
): Promise<ExportModelResult> {
  const registry = new CitationRegistry();
  const contentBlocks: Block[] = [];
  let matterName: string | null = null;

  for (const key of opts.provisionKeys) {
    const result = await buildClauseCompare(firmId, {
      scope: opts.scope,
      matterId: opts.matterId ?? null,
      districtIds: opts.districtIds ?? null,
      unit: opts.unit,
      provisionKey: key,
    });
    if (!result.ok) {
      return { ok: false, status: result.status, error: result.error };
    }
    if (result.data.matterName) matterName = result.data.matterName;

    contentBlocks.push({ kind: "heading", level: 2, text: prettyKey(key) });
    const clauses = result.data.clauses;
    if (clauses.length === 0) {
      contentBlocks.push({
        kind: "paragraph",
        text: "No cited clauses are available for this provision in scope.",
      });
      continue;
    }
    for (const clause of clauses) {
      const num = registry.add({
        district: clause.districtName,
        sourceUrl: clause.sourceUrl,
        pageRef: clause.pageRef,
        retrievedAt: clause.retrievedAt,
      });
      contentBlocks.push({
        kind: "clause",
        districtName: clause.districtName,
        meta: clauseMeta(clause),
        excerpt: clause.clauseExcerpt,
        citationNumber: num,
      });
    }
  }

  const meta: ExportMeta = {
    type: "clause_appendix",
    title:
      opts.title && opts.title.trim()
        ? opts.title.trim()
        : matterName
          ? `Clause Appendix — ${matterName}`
          : "Clause Appendix",
    matterName,
    bargainingUnit: opts.unit,
    generatedByName: opts.generatedByName ?? null,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
  };

  const blocks: Block[] = [...metaBlocks(meta), ...contentBlocks];

  return {
    ok: true,
    model: { meta, blocks, citations: registry.list },
  };
}
