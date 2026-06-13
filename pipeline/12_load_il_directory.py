#!/usr/bin/env python3
"""
ISBE Directory of Educational Entities ingestion.

Reads the ISBE Directory XLS/XLSX file from pipeline/data/il_directory/,
extracts the 11-digit RCDTS code + website URL for each public district,
and upserts website_url into the districts table (only where currently NULL).

ISBE file format:
  Sheet "1 Public Dist & Sch" (or similar "Public" sheet)
  Header at row 0.  Key columns:
    RecType                         — "Dist" for district rows, "Sch" for schools
    "Region-2\\nCounty-3\\nDistrict-4" — 9-digit RCD prefix
    Type                            — 2-digit type suffix
    School                          — 4-digit school code; "0000" = district level
    Website                         — district URL

  state_district_id = RCD(9) + Type(2) = 11 digits

Usage:
    python3 pipeline/12_load_il_directory.py [path/to/file.xls]
"""
import logging
import re
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

IL_DIR_DIR = common.DATA_DIR / "il_directory"


# ---------------------------------------------------------------------------
# URL normalization
# ---------------------------------------------------------------------------

def _normalize_url(raw) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if s.lower() in ("nan", "none", "n/a", "", "#n/a"):
        return None
    if not re.search(r"[a-zA-Z0-9]", s):
        return None
    if not s.startswith(("http://", "https://")):
        s = "https://" + s.lstrip("/")
    return s.rstrip("/")


# ---------------------------------------------------------------------------
# ISBE-format loader  (multi-sheet XLS with RCD + Type columns)
# ---------------------------------------------------------------------------

def _find_public_district_sheet(xl: pd.ExcelFile) -> str | None:
    """Find the sheet that contains public district data."""
    for name in xl.sheet_names:
        if "public" in name.lower() and "dist" in name.lower():
            return name
    # Fallback: first sheet whose name starts with a digit
    for name in xl.sheet_names:
        if name and name[0].isdigit():
            return name
    return None


def _norm_col(c: str) -> str:
    return re.sub(r"[\s_\-#/.\n]", "", str(c).lower())


def _load_isbe_format(path: Path, sheet_name: str) -> list[tuple[str, str]]:
    """
    Load (rcdts_11digit, url) pairs from the ISBE directory format.
    Filters to district-level rows only (RecType='Dist', School='0000').
    """
    df = pd.read_excel(path, sheet_name=sheet_name, dtype=str)
    log.info("  Sheet %r: %d rows, %d columns", sheet_name, len(df), len(df.columns))
    log.info("  Columns: %s", list(df.columns))

    # Locate required columns by normalized name
    col_map = {_norm_col(c): c for c in df.columns}

    rcd_col  = col_map.get("region2county3district4")   # "Region-2\nCounty-3\nDistrict-4"
    type_col = col_map.get("type")
    rec_col  = col_map.get("rectype")
    sch_col  = col_map.get("school")
    url_col  = col_map.get("website")

    # Fallback: search by substring if exact match fails
    if rcd_col is None:
        for nc, orig in col_map.items():
            if "region" in nc and "county" in nc:
                rcd_col = orig
                break
    if type_col is None:
        for nc, orig in col_map.items():
            if nc == "type":
                type_col = orig
                break
    if url_col is None:
        for nc, orig in col_map.items():
            if "website" in nc or "url" in nc:
                url_col = orig
                break

    missing = [name for name, col in [
        ("RCD", rcd_col), ("Type", type_col), ("RecType", rec_col),
        ("School", sch_col), ("Website", url_col),
    ] if col is None]
    if missing:
        log.error("  Missing columns: %s", missing)
        log.error("  Available: %s", list(df.columns))
        sys.exit(1)

    log.info("  RCD=%r  Type=%r  RecType=%r  School=%r  Website=%r",
             rcd_col, type_col, rec_col, sch_col, url_col)

    pairs: list[tuple[str, str]] = []
    skipped_rectype = 0
    skipped_school  = 0
    skipped_url     = 0

    for _, row in df.iterrows():
        rec_type = str(row.get(rec_col, "")).strip()
        school   = str(row.get(sch_col, "")).strip().lstrip("0") or "0"

        # District-level rows only
        if rec_type != "Dist":
            skipped_rectype += 1
            continue
        if school not in ("0", ""):     # "0000" zero-stripped → "0"
            skipped_school += 1
            continue

        rcd  = re.sub(r"\D", "", str(row.get(rcd_col, "")).strip())
        typ  = re.sub(r"\D", "", str(row.get(type_col, "")).strip())
        rcdts = rcd + typ   # 9 + 2 = 11 digits

        if len(rcdts) != 11:
            log.debug("  Bad RCDTS length %d: %r", len(rcdts), rcdts)
            continue

        url = _normalize_url(row.get(url_col))
        if url is None:
            skipped_url += 1
            continue

        pairs.append((rcdts, url))

    log.info("  District rows with URL: %d  (skipped: rectype=%d, non-district-school=%d, no-url=%d)",
             len(pairs), skipped_rectype, skipped_school, skipped_url)
    return pairs


# ---------------------------------------------------------------------------
# Generic fallback loader  (single-sheet XLSX with auto-detected columns)
# ---------------------------------------------------------------------------

_RCDT_KEYS = {"rcdt", "rcdts", "unitrcdts", "rcdtscode", "rcdt_code",
              "schoolrcdts", "unitno", "cdscode"}
_URL_KEYS  = {"website", "url", "webaddress", "websiteaddress", "homepage",
              "districtwebsite", "www", "websiteurl", "webpageaddress"}


def _find_col(df: pd.DataFrame, candidates: set) -> str | None:
    for col in df.columns:
        if _norm_col(col) in candidates:
            return col
    for col in df.columns:
        cn = _norm_col(col)
        for k in candidates:
            if k in cn or cn in k:
                return col
    return None


def _load_generic_format(path: Path) -> list[tuple[str, str]]:
    """Fallback: auto-detect RCDTS and Website columns in a single-sheet file."""
    df = pd.read_excel(path, dtype=str)
    log.info("  Generic format: %d rows, %d columns", len(df), len(df.columns))

    rcdt_col = _find_col(df, _RCDT_KEYS)
    url_col  = _find_col(df, _URL_KEYS)

    if rcdt_col is None:
        df2 = pd.read_excel(path, header=1, dtype=str)
        rcdt_col = _find_col(df2, _RCDT_KEYS)
        if rcdt_col:
            df = df2
            url_col = _find_col(df, _URL_KEYS)

    if rcdt_col is None or url_col is None:
        log.error("  Could not auto-detect RCDTS/URL columns. Columns: %s", list(df.columns))
        sys.exit(1)

    pairs = []
    for _, row in df.iterrows():
        raw_rcdts = str(row.get(rcdt_col, "")).strip()
        digits = re.sub(r"\D", "", raw_rcdts)
        if len(digits) < 9:
            continue
        rcdts = digits[:11].zfill(11)
        url = _normalize_url(row.get(url_col))
        if url:
            pairs.append((rcdts, url))
    return pairs


# ---------------------------------------------------------------------------
# Main load function
# ---------------------------------------------------------------------------

def load_directory(path: Path) -> tuple[int, int, int]:
    """
    Load directory from XLS/XLSX file.
    Returns (district_rows_found, districts_matched, urls_upserted).
    """
    log.info("Reading %s", path.name)

    xl = pd.ExcelFile(path)
    log.info("  Sheets: %s", xl.sheet_names)

    public_sheet = _find_public_district_sheet(xl)
    if public_sheet:
        log.info("  Using ISBE multi-sheet format, sheet: %r", public_sheet)
        pairs = _load_isbe_format(path, public_sheet)
    else:
        log.info("  Falling back to generic single-sheet format")
        pairs = _load_generic_format(path)

    # DB upsert
    conn = common.get_db_conn()
    cur  = conn.cursor()
    cur.execute("SELECT id, state_district_id FROM districts WHERE state='IL'")
    dist_lookup = {row[1]: row[0] for row in cur.fetchall()}

    matched  = 0
    upserted = 0
    for rcdts, url in pairs:
        dist_id = dist_lookup.get(rcdts)
        if dist_id is None:
            continue
        matched += 1
        cur.execute(
            "UPDATE districts SET website_url = %s WHERE id = %s AND website_url IS NULL",
            (url, dist_id),
        )
        if cur.rowcount > 0:
            upserted += 1

    conn.commit()
    cur.close()
    conn.close()

    return len(pairs), matched, upserted


def main(path: Path | None = None):
    if path is None:
        candidates = sorted(IL_DIR_DIR.glob("*.xlsx")) + sorted(IL_DIR_DIR.glob("*.xls"))
        if not candidates:
            log.error(
                "No XLS/XLSX file found in %s — please upload the ISBE Directory "
                "file to that directory and re-run.", IL_DIR_DIR,
            )
            sys.exit(1)
        path = candidates[0]
        log.info("Using %s", path)

    rows_found, matched, upserted = load_directory(path)

    print(f"\n{'='*60}")
    print(f"ISBE Directory Ingestion Results")
    print(f"{'='*60}")
    print(f"  District rows with URL:  {rows_found:>6,}")
    print(f"  Districts matched in DB: {matched:>6,}")
    print(f"  website_url upserted:    {upserted:>6,}")

    conn = common.get_db_conn()
    cur  = conn.cursor()
    cur.execute("SELECT COUNT(*), COUNT(website_url) FROM districts WHERE state='IL'")
    total, with_url = cur.fetchone()
    cur.close()
    conn.close()
    print(f"  IL districts total:      {total:>6,}")
    print(f"  Now have website URL:    {with_url:>6,}  ({with_url/total*100:.1f}%)")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    arg_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    main(arg_path)
