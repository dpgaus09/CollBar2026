// ---------------------------------------------------------------------------
// Bulk CBA import (Task #199): PURE manifest parsing + file matching.
//
// This module has NO side effects — it parses a mapping spreadsheet (already
// read to a CSV string) and matches each row to a file discovered in a Google
// Drive folder tree. The admin route layer uses it to build a dry-run preview
// (writes nothing) and to validate entries before the ingest writes anything.
//
// The mapping spreadsheet maps one CBA PDF per row to a district + bargaining
// unit + school year. Districts are resolved by RCDTS 9-digit prefix (primary)
// with a district-name fallback — mirroring the proven bulk-import-customers
// resolver. Files are matched by relative path ("Folder/file.pdf") first, then
// by basename; an ambiguous basename (same name in >1 folder) is reported, not
// guessed.
// ---------------------------------------------------------------------------

import { VALID_BARGAINING_UNITS } from "../routes/bargaining-units.js";
import type { DriveFile } from "./google-drive.js";

// Header alias → canonical column. Case-insensitive, trimmed comparison.
const COLUMN_ALIASES: Record<keyof ManifestColumnMap, string[]> = {
  iRcdts: ["rcdts", "rcdts code", "rcdts id", "rcdts number", "state id", "state district id", "district id", "district id (rcdts)"],
  iDistrict: ["district", "district name", "name", "lea", "lea name", "school district"],
  iUnit: ["bargaining_unit", "bargaining unit", "unit", "bu", "employee group", "group", "bargaining group"],
  iYear: ["school_year", "school year", "year", "contract year", "sy", "term"],
  iFile: ["file", "filename", "file name", "pdf", "document", "drive file", "path", "file path", "pdf file"],
};

export interface ManifestColumnMap {
  iRcdts: number;
  iDistrict: number;
  iUnit: number;
  iYear: number;
  iFile: number;
}

export interface DistrictLookups {
  byPrefix: Map<string, number>;
  byName: Map<string, number>;
}

export type MatchStatus =
  | "matched"
  | "invalid_unit"
  | "invalid_year"
  | "unmatched_district"
  | "unmatched_file"
  | "ambiguous_file";

export interface MatchedEntry {
  lineNum: number;
  status: MatchStatus;
  rcdts: string;
  districtName: string;
  districtId: number | null;
  unit: string;
  unitDefaulted: boolean;
  schoolYear: string | null;
  file: string;
  driveFileId: string | null;
  driveFileName: string | null;
  driveMd5: string | null;
  driveSize: number | null;
  driveModifiedTime: string | null;
  reason?: string;
}

export interface UnreferencedFile {
  id: string;
  name: string;
  path: string;
}

/**
 * Map a header row to column indexes by alias. Returns null when neither a
 * district identifier (RCDTS or name) nor a file column is present — without
 * those, no row can be matched.
 */
export function mapManifestColumns(headerRow: string[]): ManifestColumnMap | null {
  const header = headerRow.map((h) => String(h ?? "").trim().toLowerCase());
  const find = (aliases: string[]) => {
    for (const a of aliases) {
      const idx = header.indexOf(a);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const map: ManifestColumnMap = {
    iRcdts: find(COLUMN_ALIASES.iRcdts),
    iDistrict: find(COLUMN_ALIASES.iDistrict),
    iUnit: find(COLUMN_ALIASES.iUnit),
    iYear: find(COLUMN_ALIASES.iYear),
    iFile: find(COLUMN_ALIASES.iFile),
  };
  if (map.iFile < 0) return null;
  if (map.iRcdts < 0 && map.iDistrict < 0) return null;
  return map;
}

const UNIT_ALIASES: Array<[RegExp, string]> = [
  [/^(teacher|teachers|certified|cert|certificated|licensed|education association|ea)$/, "teachers"],
  [/^(para|paras|paraprofessional|paraprofessionals|aide|aides|teacher aide|teacher aides|esp)$/, "paraprofessionals"],
  [/^(custodial|custodian|custodians|maintenance|custodial & maintenance|custodial and maintenance|custodial\/maintenance|buildings & grounds)$/, "custodial_maintenance"],
  [/^(transportation|transport|bus|buses|bus driver|bus drivers|drivers)$/, "transportation"],
  [/^(secretarial|secretary|secretaries|clerical|clerk|clerks|secretarial & clerical|secretarial and clerical|office)$/, "secretarial_clerical"],
  [/^(food service|food services|cafeteria|cafeteria workers|food|nutrition)$/, "food_service"],
  [/^(nurse|nurses|school nurse|school nurses)$/, "nurses"],
  [/^(administrator|administrators|admin|admins|principal|principals)$/, "administrators"],
  [/^(support|support staff|educational support|education support|essp|support personnel)$/, "support_staff"],
  [/^(other|misc|miscellaneous)$/, "other"],
];

/**
 * Normalize a raw unit string to a canonical bargaining unit.
 * Returns { unit, defaulted }: blank defaults to 'teachers' (the common case,
 * matching the single-upload default); an unrecognized non-blank value returns
 * null so the row is flagged invalid_unit rather than silently mis-scoped.
 */
export function normalizeUnit(raw: unknown): { unit: string | null; defaulted: boolean } {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return { unit: "teachers", defaulted: true };
  if (VALID_BARGAINING_UNITS.has(s)) return { unit: s, defaulted: false };
  for (const [re, canon] of UNIT_ALIASES) {
    if (re.test(s)) return { unit: canon, defaulted: false };
  }
  return { unit: null, defaulted: false };
}

/**
 * Normalize a school year to NNNN-NN (e.g. "24-25" → "2024-25", "2024-2025" →
 * "2024-25"). Blank is valid (null). Returns ok:false for an unparseable value.
 */
export function normalizeYear(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (raw == null) return { ok: true, value: null };
  const s = String(raw).trim();
  if (!s) return { ok: true, value: null };
  let v = s;
  const short = /^(\d{2})-(\d{2})$/.exec(s);
  if (short) v = `20${short[1]}-${short[2]}`;
  const long = /^(\d{4})-(\d{4})$/.exec(s);
  if (long) v = `${long[1]}-${long[2].slice(2)}`;
  const single = /^(\d{4})$/.exec(s);
  if (single) {
    const start = Number(single[1]);
    v = `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  }
  if (!/^\d{4}-\d{2}$/.test(v) || v.length > 7) return { ok: false };
  return { ok: true, value: v };
}

/** Resolve a district id by RCDTS 9-digit prefix then by name. */
export function resolveDistrictId(
  rcdts: string,
  name: string,
  lookups: DistrictLookups,
): number | null {
  const r = rcdts.trim();
  if (r) {
    const digits = r.replace(/\D/g, "");
    if (digits) {
      const padded = digits.length < 9 ? digits.padStart(9, "0") : digits.slice(0, 9);
      const hit = lookups.byPrefix.get(padded) ?? lookups.byPrefix.get(digits);
      if (hit != null) return hit;
    }
  }
  const nm = name.trim().toLowerCase();
  if (nm) {
    const hit = lookups.byName.get(nm);
    if (hit != null) return hit;
  }
  return null;
}

function normPath(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+/g, "/");
}

function baseName(s: string): string {
  const n = normPath(s);
  const idx = n.lastIndexOf("/");
  return idx >= 0 ? n.slice(idx + 1) : n;
}

/** Build path/basename indexes over the Drive files for matching. */
export interface FileIndex {
  byFullPath: Map<string, DriveFile>;
  byBase: Map<string, DriveFile[]>;
}

export function buildFileIndex(files: DriveFile[]): FileIndex {
  const byFullPath = new Map<string, DriveFile>();
  const byBase = new Map<string, DriveFile[]>();
  for (const f of files) {
    const full = normPath([...f.parentPath, f.name].join("/"));
    if (!byFullPath.has(full)) byFullPath.set(full, f);
    const base = baseName(f.name);
    const arr = byBase.get(base);
    if (arr) arr.push(f);
    else byBase.set(base, [f]);
  }
  return { byFullPath, byBase };
}

function matchFile(
  value: string,
  index: FileIndex,
): { file: DriveFile | null; ambiguous: boolean } {
  const raw = value.trim();
  if (!raw) return { file: null, ambiguous: false };
  const variants = (s: string): string[] => {
    const v = [s];
    if (!s.endsWith(".pdf")) v.push(`${s}.pdf`);
    return v;
  };
  const nf = normPath(raw);
  // 1. Exact relative-path match (handles "Folder/file.pdf").
  for (const cand of variants(nf)) {
    const hit = index.byFullPath.get(cand);
    if (hit) return { file: hit, ambiguous: false };
  }
  // 2. Basename match (handles a bare filename or a path whose folder differs).
  const base = baseName(nf);
  for (const cand of variants(base)) {
    const arr = index.byBase.get(cand);
    if (arr && arr.length === 1) return { file: arr[0], ambiguous: false };
    if (arr && arr.length > 1) return { file: null, ambiguous: true };
  }
  return { file: null, ambiguous: false };
}

export interface MatchInput {
  rows: string[][]; // data rows only (no header)
  startLine: number; // 1-based line number of rows[0] (header is line 1 → 2)
  cols: ManifestColumnMap;
  files: DriveFile[];
  lookups: DistrictLookups;
}

export interface MatchOutput {
  entries: MatchedEntry[];
  unreferencedFiles: UnreferencedFile[];
}

/**
 * Match every manifest data row to a Drive file + district. Pure: returns the
 * per-row resolution and the set of Drive PDFs no row referenced. The first
 * failing check wins the row's status (invalid_unit → invalid_year →
 * unmatched_district → ambiguous_file → unmatched_file → matched).
 */
export function matchEntries(input: MatchInput): MatchOutput {
  const { rows, startLine, cols, files, lookups } = input;
  const index = buildFileIndex(files);
  const usedFileIds = new Set<string>();
  const entries: MatchedEntry[] = [];

  for (let j = 0; j < rows.length; j++) {
    const cells = rows[j] ?? [];
    if (cells.every((c) => String(c ?? "").trim() === "")) continue; // blank line
    const lineNum = startLine + j;
    const rcdts = cols.iRcdts >= 0 ? String(cells[cols.iRcdts] ?? "").trim() : "";
    const districtName = cols.iDistrict >= 0 ? String(cells[cols.iDistrict] ?? "").trim() : "";
    const unitRaw = cols.iUnit >= 0 ? String(cells[cols.iUnit] ?? "").trim() : "";
    const yearRaw = cols.iYear >= 0 ? String(cells[cols.iYear] ?? "").trim() : "";
    const file = cols.iFile >= 0 ? String(cells[cols.iFile] ?? "").trim() : "";

    const { unit, defaulted } = normalizeUnit(unitRaw);
    const year = normalizeYear(yearRaw);
    const districtId = resolveDistrictId(rcdts, districtName, lookups);
    const fileMatch = matchFile(file, index);

    const entry: MatchedEntry = {
      lineNum,
      status: "matched",
      rcdts,
      districtName,
      districtId,
      unit: unit ?? unitRaw,
      unitDefaulted: defaulted,
      schoolYear: year.ok ? year.value : null,
      file,
      driveFileId: fileMatch.file?.id ?? null,
      driveFileName: fileMatch.file?.name ?? null,
      driveMd5: fileMatch.file?.md5Checksum ?? null,
      driveSize: fileMatch.file?.size ?? null,
      driveModifiedTime: fileMatch.file?.modifiedTime ?? null,
    };

    if (unit == null) {
      entry.status = "invalid_unit";
      entry.reason = `Unrecognized bargaining unit "${unitRaw}"`;
    } else if (!year.ok) {
      entry.status = "invalid_year";
      entry.reason = `Unparseable school year "${yearRaw}" (expected e.g. 2024-25)`;
    } else if (districtId == null) {
      entry.status = "unmatched_district";
      entry.reason = rcdts
        ? `No IL district for RCDTS "${rcdts}"`
        : `No IL district named "${districtName}"`;
    } else if (fileMatch.ambiguous) {
      entry.status = "ambiguous_file";
      entry.reason = `Filename "${file}" matches more than one file; qualify it with its folder`;
    } else if (!fileMatch.file) {
      entry.status = "unmatched_file";
      entry.reason = file ? `No Drive file matches "${file}"` : "No file specified";
    } else {
      entry.status = "matched";
      usedFileIds.add(fileMatch.file.id);
    }
    entries.push(entry);
  }

  const unreferencedFiles: UnreferencedFile[] = files
    .filter((f) => !usedFileIds.has(f.id))
    .map((f) => ({
      id: f.id,
      name: f.name,
      path: [...f.parentPath, f.name].join("/"),
    }));

  return { entries, unreferencedFiles };
}

/** A Drive file looks like a CBA PDF we can ingest. */
export function isPdfFile(f: DriveFile): boolean {
  return f.mimeType === "application/pdf" || /\.pdf$/i.test(f.name);
}
