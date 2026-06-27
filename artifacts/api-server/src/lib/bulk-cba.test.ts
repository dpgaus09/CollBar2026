import { describe, it, expect } from "vitest";
import {
  mapManifestColumns,
  normalizeUnit,
  normalizeYear,
  resolveDistrictId,
  matchEntries,
  isPdfFile,
  type DistrictLookups,
} from "./bulk-cba.js";
import type { DriveFile } from "./google-drive.js";

// ---------------------------------------------------------------------------
// Pure manifest parsing + file matching for the bulk CBA import (Task #199).
// No DB / network — exercises column aliasing, unit/year normalization,
// RCDTS+name district resolution, and row→file matching (incl. ambiguity and
// the per-row first-failing-status priority).
// ---------------------------------------------------------------------------

function file(p: Partial<DriveFile> & { name: string }): DriveFile {
  return {
    id: p.id ?? `id-${p.name}`,
    name: p.name,
    mimeType: p.mimeType ?? "application/pdf",
    size: p.size ?? 1234,
    md5Checksum: p.md5Checksum ?? "abc",
    modifiedTime: p.modifiedTime ?? "2026-01-01T00:00:00Z",
    parentPath: p.parentPath ?? [],
  };
}

const lookups: DistrictLookups = {
  byPrefix: new Map([["010010020", 42]]),
  byName: new Map([["adams cusd 1", 42]]),
};

describe("mapManifestColumns", () => {
  it("resolves aliases case-insensitively", () => {
    const cols = mapManifestColumns([
      "RCDTS",
      "District Name",
      "Bargaining Unit",
      "School Year",
      "File",
    ]);
    expect(cols).toEqual({ iRcdts: 0, iDistrict: 1, iUnit: 2, iYear: 3, iFile: 4 });
  });

  it("returns null without a file column", () => {
    expect(mapManifestColumns(["rcdts", "district", "unit"])).toBeNull();
  });

  it("returns null without any district identifier", () => {
    expect(mapManifestColumns(["file", "unit", "year"])).toBeNull();
  });

  it("accepts file + rcdts only", () => {
    expect(mapManifestColumns(["file", "rcdts"])).toMatchObject({ iFile: 0, iRcdts: 1 });
  });
});

describe("normalizeUnit", () => {
  it("defaults blank to teachers (flagged)", () => {
    expect(normalizeUnit("")).toEqual({ unit: "teachers", defaulted: true });
    expect(normalizeUnit("  ")).toEqual({ unit: "teachers", defaulted: true });
  });

  it("maps common aliases", () => {
    expect(normalizeUnit("Teachers").unit).toBe("teachers");
    expect(normalizeUnit("certified").unit).toBe("teachers");
    expect(normalizeUnit("paraprofessionals").unit).toBe("paraprofessionals");
    expect(normalizeUnit("custodial & maintenance").unit).toBe("custodial_maintenance");
    expect(normalizeUnit("bus drivers").unit).toBe("transportation");
    expect(normalizeUnit("secretarial").unit).toBe("secretarial_clerical");
  });

  it("flags an unrecognized non-blank unit as invalid (null)", () => {
    expect(normalizeUnit("music teachers").unit).toBeNull();
  });
});

describe("normalizeYear", () => {
  it("normalizes short, long, and single-year forms", () => {
    expect(normalizeYear("24-25")).toEqual({ ok: true, value: "2024-25" });
    expect(normalizeYear("2024-2025")).toEqual({ ok: true, value: "2024-25" });
    expect(normalizeYear("2024")).toEqual({ ok: true, value: "2024-25" });
    expect(normalizeYear("2024-25")).toEqual({ ok: true, value: "2024-25" });
  });

  it("treats blank as valid null", () => {
    expect(normalizeYear("")).toEqual({ ok: true, value: null });
    expect(normalizeYear(null)).toEqual({ ok: true, value: null });
  });

  it("rejects unparseable values", () => {
    expect(normalizeYear("not a year")).toEqual({ ok: false });
    expect(normalizeYear("20245")).toEqual({ ok: false });
  });
});

describe("resolveDistrictId", () => {
  it("resolves by RCDTS 9-digit prefix (padding + truncation)", () => {
    expect(resolveDistrictId("010010020", "", lookups)).toBe(42);
    // 11-digit RCDTS → truncated to the 9-digit district prefix
    expect(resolveDistrictId("01001002026", "", lookups)).toBe(42);
    // non-digit separators stripped
    expect(resolveDistrictId("01-001-0020", "", lookups)).toBe(42);
  });

  it("falls back to name", () => {
    expect(resolveDistrictId("", "Adams CUSD 1", lookups)).toBe(42);
    expect(resolveDistrictId("99999", "Adams CUSD 1", lookups)).toBe(42);
  });

  it("returns null when neither matches", () => {
    expect(resolveDistrictId("99999", "Nowhere", lookups)).toBeNull();
  });
});

describe("matchEntries", () => {
  const cols = mapManifestColumns(["rcdts", "district", "unit", "year", "file"])!;

  it("matches a clean row and carries Drive metadata", () => {
    const files = [
      file({ name: "adams.pdf", id: "f1", md5Checksum: "h1", size: 999 }),
    ];
    const { entries } = matchEntries({
      rows: [["010010020", "Adams CUSD 1", "teachers", "2024-25", "adams.pdf"]],
      startLine: 2,
      cols,
      files,
      lookups,
    });
    expect(entries[0]).toMatchObject({
      lineNum: 2,
      status: "matched",
      districtId: 42,
      unit: "teachers",
      schoolYear: "2024-25",
      driveFileId: "f1",
      driveMd5: "h1",
      driveSize: 999,
    });
  });

  it("matches by relative path and detects basename ambiguity", () => {
    const files = [
      file({ name: "cba.pdf", id: "a", parentPath: ["Adams"] }),
      file({ name: "cba.pdf", id: "b", parentPath: ["Brown"] }),
    ];
    const out = matchEntries({
      rows: [
        ["010010020", "Adams CUSD 1", "teachers", "2024-25", "Adams/cba.pdf"],
        ["010010020", "Adams CUSD 1", "teachers", "2024-25", "cba.pdf"],
      ],
      startLine: 2,
      cols,
      files,
      lookups,
    });
    expect(out.entries[0]).toMatchObject({ status: "matched", driveFileId: "a" });
    expect(out.entries[1]).toMatchObject({ status: "ambiguous_file" });
  });

  it("applies first-failing-status priority", () => {
    const files = [file({ name: "adams.pdf" })];
    const { entries } = matchEntries({
      rows: [
        // invalid unit beats every later check
        ["010010020", "Adams CUSD 1", "music teachers", "2024-25", "adams.pdf"],
        // invalid year
        ["010010020", "Adams CUSD 1", "teachers", "nope", "adams.pdf"],
        // unmatched district
        ["99999", "Nowhere", "teachers", "2024-25", "adams.pdf"],
        // unmatched file
        ["010010020", "Adams CUSD 1", "teachers", "2024-25", "missing.pdf"],
      ],
      startLine: 2,
      cols,
      files,
      lookups,
    });
    expect(entries.map((e) => e.status)).toEqual([
      "invalid_unit",
      "invalid_year",
      "unmatched_district",
      "unmatched_file",
    ]);
  });

  it("reports unreferenced files and skips blank rows", () => {
    const files = [
      file({ name: "adams.pdf", id: "used" }),
      file({ name: "orphan.pdf", id: "orphan", parentPath: ["Misc"] }),
    ];
    const { entries, unreferencedFiles } = matchEntries({
      rows: [
        ["010010020", "Adams CUSD 1", "teachers", "2024-25", "adams.pdf"],
        ["", "", "", "", ""],
      ],
      startLine: 2,
      cols,
      files,
      lookups,
    });
    expect(entries).toHaveLength(1);
    expect(unreferencedFiles).toEqual([
      { id: "orphan", name: "orphan.pdf", path: "Misc/orphan.pdf" },
    ]);
  });

  it("matches a manifest filename missing its .pdf extension", () => {
    const files = [file({ name: "adams.pdf", id: "f1" })];
    const { entries } = matchEntries({
      rows: [["010010020", "Adams CUSD 1", "teachers", "2024-25", "adams"]],
      startLine: 2,
      cols,
      files,
      lookups,
    });
    expect(entries[0]).toMatchObject({ status: "matched", driveFileId: "f1" });
  });
});

describe("isPdfFile", () => {
  it("accepts PDFs by mime or extension", () => {
    expect(isPdfFile(file({ name: "x.pdf", mimeType: "application/pdf" }))).toBe(true);
    expect(isPdfFile(file({ name: "X.PDF", mimeType: "application/octet-stream" }))).toBe(true);
  });
  it("rejects non-PDFs", () => {
    expect(isPdfFile(file({ name: "notes.txt", mimeType: "text/plain" }))).toBe(false);
  });
});
