#!/usr/bin/env python3
"""
ISBE Directory of Educational Entities ingestion.

Reads the first .xlsx file in pipeline/data/il_directory/, extracts
RCDT code + website URL for each district, and upserts website_url
into the districts table (only for rows where website_url is currently NULL).

Usage:
    python3 pipeline/12_load_il_directory.py [path/to/file.xlsx]
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
# RCDT normalization  (same logic as other IL loaders)
# ---------------------------------------------------------------------------

def _normalize_rcdts(raw) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if s.lower() in ("nan", "none", ""):
        return None
    if "." in s:
        s = s.split(".")[0]
    digits = re.sub(r"\D", "", s)
    if not digits:
        return None
    n = len(digits)
    if n < 9 or n > 15:
        return None
    if n < 11:
        digits = digits.zfill(11)
    return digits[:11]


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
    # Add scheme if missing
    if not s.startswith(("http://", "https://")):
        s = "https://" + s.lstrip("/")
    # Strip trailing slashes for consistency
    return s.rstrip("/")


# ---------------------------------------------------------------------------
# Column auto-detection
# ---------------------------------------------------------------------------

# Normalized (lowercase, no-space) → semantic key
_RCDT_KEYS = {"rcdt", "rcdts", "unitrcdts", "rcdtscode", "rcdt#", "rcdt_code",
               "schoolrcdts", "unitno", "unitno.", "cdscode"}
_URL_KEYS  = {"website", "url", "webaddress", "websiteaddress", "homepage",
              "districtwebsite", "www", "web", "websiteurl", "web-address",
              "webpageaddress", "internetaddress"}


def _norm_col(c: str) -> str:
    return re.sub(r"[\s_\-#/.]", "", str(c).lower())


def _find_col(df: pd.DataFrame, candidates: set) -> str | None:
    for col in df.columns:
        if _norm_col(col) in candidates:
            return col
    # fuzzy fallback: contains any candidate substring
    for col in df.columns:
        cn = _norm_col(col)
        for k in candidates:
            if k in cn or cn in k:
                return col
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_directory(path: Path) -> tuple[int, int, int]:
    """
    Load directory from xlsx file.
    Returns (rows_read, districts_matched, urls_upserted).
    """
    log.info("Reading %s", path.name)
    df = pd.read_excel(path, dtype=str)
    log.info("  %d rows, %d columns", len(df), len(df.columns))
    log.info("  Columns: %s", list(df.columns)[:15])

    rcdt_col = _find_col(df, _RCDT_KEYS)
    url_col  = _find_col(df, _URL_KEYS)

    if rcdt_col is None:
        # Try header=1 (title row at row 0)
        df2 = pd.read_excel(path, header=1, dtype=str)
        rcdt_col2 = _find_col(df2, _RCDT_KEYS)
        if rcdt_col2 is not None:
            df = df2
            rcdt_col = rcdt_col2
            url_col  = _find_col(df, _URL_KEYS)
            log.info("  Re-read with header=1; RCDT col=%s", rcdt_col)

    if rcdt_col is None:
        log.error("  Could not find RCDT column. Columns: %s", list(df.columns))
        sys.exit(1)
    if url_col is None:
        log.warning("  Could not find URL column. Columns: %s", list(df.columns))
        # Don't exit — maybe the column has a non-standard name; print first 5 cols
        # for the user to identify it
        print("\nAvailable columns:")
        for c in df.columns:
            print(f"  {c!r}")
        sys.exit(1)

    log.info("  Using RCDT col=%r  URL col=%r", rcdt_col, url_col)

    rows_read = 0
    pairs: list[tuple[str, str]] = []  # (rcdts_11digit, url)
    for _, row in df.iterrows():
        rcdts = _normalize_rcdts(row.get(rcdt_col))
        url   = _normalize_url(row.get(url_col))
        rows_read += 1
        if rcdts and url:
            pairs.append((rcdts, url))

    log.info("  %d rows with both valid RCDT and URL", len(pairs))

    conn = common.get_db_conn()
    cur  = conn.cursor()

    # Build lookup: state_district_id → district id
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

    return rows_read, matched, upserted


def main(path: Path | None = None):
    if path is None:
        candidates = sorted(IL_DIR_DIR.glob("*.xlsx"))
        if not candidates:
            # Also check .xls
            candidates = sorted(IL_DIR_DIR.glob("*.xls"))
        if not candidates:
            log.error(
                "No .xlsx file found in %s — please upload the ISBE Directory "
                "file to that directory and re-run.", IL_DIR_DIR,
            )
            sys.exit(1)
        path = candidates[0]
        log.info("Using %s", path)

    rows_read, matched, upserted = load_directory(path)

    print(f"\n{'='*60}")
    print(f"ISBE Directory Ingestion Results")
    print(f"{'='*60}")
    print(f"  Rows read:          {rows_read:>6,}")
    print(f"  Districts matched:  {matched:>6,}")
    print(f"  URLs upserted:      {upserted:>6,}")

    # Final coverage check
    conn = common.get_db_conn()
    cur  = conn.cursor()
    cur.execute(
        "SELECT COUNT(*), COUNT(website_url) FROM districts WHERE state='IL'"
    )
    total, with_url = cur.fetchone()
    cur.close()
    conn.close()
    print(f"  IL districts total: {total:>6,}")
    print(f"  With website URL:   {with_url:>6,}  ({with_url/total*100:.1f}%)")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    arg_path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    main(arg_path)
