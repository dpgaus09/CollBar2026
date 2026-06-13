#!/usr/bin/env python3
"""
ISBE Directory of Educational Entities — daily automated refresh.

Downloads the ISBE directory XLS from the official URL, checks SHA-256
against the most recent successful run, and (if changed) upserts district
records into the districts table.  Every run is logged to
directory_refresh_log (created automatically on first run).

Usage:
    python3 pipeline/12_refresh_il_directory.py [--dry-run]
"""
import argparse
import hashlib
import logging
import re
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

ISBE_URL = (
    "https://www.isbe.net/_layouts/Download.aspx"
    "?SourceUrl=/Documents/dir_ed_entities.xls"
)
DOWNLOAD_UA      = "CollBarBot/1.0 (hello@collbar.com)"
DOWNLOAD_TIMEOUT = 30
DOWNLOAD_RETRIES = 3

IL_DIR_DIR = common.DATA_DIR / "il_directory"

CREATE_LOG_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS directory_refresh_log (
    id                SERIAL PRIMARY KEY,
    run_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    file_hash         TEXT,
    row_count         INT,
    new_districts     INT,
    updated_districts INT,
    with_website      INT,
    changed           BOOLEAN,
    status            TEXT NOT NULL,
    error             TEXT
)
"""


def _ensure_log_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(CREATE_LOG_TABLE_SQL)
    conn.commit()


def _download_xls() -> bytes:
    """Download ISBE directory XLS with exponential-backoff retry."""
    headers = {"User-Agent": DOWNLOAD_UA, "Accept": "*/*"}
    last_exc: Exception | None = None
    for attempt in range(DOWNLOAD_RETRIES):
        wait = 2 ** (attempt + 1)
        try:
            r = requests.get(
                ISBE_URL, headers=headers,
                timeout=DOWNLOAD_TIMEOUT, allow_redirects=True,
            )
            if r.status_code == 200 and len(r.content) > 1000:
                return r.content
            log.warning("HTTP %s (attempt %d) — retrying in %ds", r.status_code, attempt + 1, wait)
        except Exception as exc:
            last_exc = exc
            log.warning("Download error (attempt %d): %s — retrying in %ds", attempt + 1, exc, wait)
        if attempt < DOWNLOAD_RETRIES - 1:
            time.sleep(wait)
    raise RuntimeError(
        f"Failed to download ISBE directory after {DOWNLOAD_RETRIES} attempts"
    ) from last_exc


def _norm_col(c: str) -> str:
    return re.sub(r"[\s_\-#/.\n]", "", str(c).lower())


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


def _find_public_sheet(xl: pd.ExcelFile) -> str | None:
    for name in xl.sheet_names:
        if "public" in name.lower() and "dist" in name.lower():
            return name
    for name in xl.sheet_names:
        if name and name[0].isdigit():
            return name
    return None


def _parse_isbe_xls(path: Path) -> list[dict]:
    """
    Parse ISBE directory XLS.
    Returns list of dicts: {rcdts, name, county, url}
    url may be None; rcdts is always an 11-digit string.
    """
    xl = pd.ExcelFile(path)
    sheet = _find_public_sheet(xl)
    if sheet is None:
        raise ValueError(
            f"Could not find public district sheet in {path.name}. "
            f"Sheets: {xl.sheet_names}"
        )

    df = pd.read_excel(path, sheet_name=sheet, dtype=str)
    log.info("  Sheet %r: %d rows, %d columns", sheet, len(df), len(df.columns))

    col_map = {_norm_col(c): c for c in df.columns}

    rcd_col    = col_map.get("region2county3district4")
    type_col   = col_map.get("type")
    rec_col    = col_map.get("rectype")
    sch_col    = col_map.get("school")
    url_col    = col_map.get("website")
    name_col   = col_map.get("facilityname")
    county_col = col_map.get("countyname")

    if rcd_col is None:
        for nc, orig in col_map.items():
            if "region" in nc and "county" in nc:
                rcd_col = orig; break
    if name_col is None:
        for nc, orig in col_map.items():
            if "facility" in nc or "agencyname" in nc:
                name_col = orig; break
    if county_col is None:
        for nc, orig in col_map.items():
            if "county" in nc and "name" in nc:
                county_col = orig; break
    if url_col is None:
        for nc, orig in col_map.items():
            if "website" in nc or "url" in nc:
                url_col = orig; break

    missing = [n for n, c in [
        ("RCD", rcd_col), ("Type", type_col), ("RecType", rec_col), ("School", sch_col),
    ] if c is None]
    if missing:
        raise ValueError(f"Missing required ISBE columns: {missing}. Available: {list(df.columns)}")

    log.info(
        "  Columns — RCD=%r  Type=%r  RecType=%r  School=%r  Website=%r  Name=%r  County=%r",
        rcd_col, type_col, rec_col, sch_col, url_col, name_col, county_col,
    )

    records: list[dict] = []
    for _, row in df.iterrows():
        if str(row.get(rec_col, "")).strip() != "Dist":
            continue
        school = str(row.get(sch_col, "")).strip().lstrip("0") or "0"
        if school not in ("0", ""):
            continue

        rcd   = re.sub(r"\D", "", str(row.get(rcd_col, "")).strip())
        typ   = re.sub(r"\D", "", str(row.get(type_col, "")).strip())
        rcdts = rcd + typ
        if len(rcdts) != 11:
            continue

        def _str(val) -> str | None:
            s = str(val).strip() if val is not None else ""
            return s if s and s.lower() not in ("nan", "none", "n/a", "") else None

        records.append({
            "rcdts":  rcdts,
            "name":   _str(row.get(name_col))   if name_col   else None,
            "county": _str(row.get(county_col)) if county_col else None,
            "url":    _normalize_url(row.get(url_col)) if url_col else None,
        })

    log.info("  Parsed %d district rows", len(records))
    return records


def _upsert_districts(conn, records: list[dict], dry_run: bool) -> tuple[int, int, int]:
    """
    Upsert district records. Returns (new_districts, updated_districts, with_website).
    Never NULLs out an existing non-NULL field.
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT id, state_district_id, name, county, website_url FROM districts WHERE state='IL'"
    )
    existing_rows = cur.fetchall()
    dist_lookup = {
        row[1]: {"id": row[0], "name": row[2], "county": row[3], "url": row[4]}
        for row in existing_rows
    }

    new_count     = 0
    updated_count = 0

    for rec in records:
        rcdts    = rec["rcdts"]
        existing = dist_lookup.get(rcdts)

        if existing is None:
            if rec["name"]:
                if not dry_run:
                    cur.execute(
                        """INSERT INTO districts (state, state_district_id, name, county, website_url)
                           VALUES ('IL', %s, %s, %s, %s)
                           ON CONFLICT DO NOTHING""",
                        (rcdts, rec["name"], rec["county"], rec["url"]),
                    )
                    if cur.rowcount > 0:
                        new_count += 1
                else:
                    new_count += 1
            continue

        changes: dict = {}
        if rec["name"] and rec["name"] != existing["name"]:
            changes["name"] = rec["name"]
        if rec["county"] and rec["county"] != existing["county"]:
            changes["county"] = rec["county"]
        if rec["url"] and rec["url"] != existing["url"]:
            changes["website_url"] = rec["url"]

        if not changes:
            continue

        if not dry_run:
            set_clause = ", ".join(f"{k} = %s" for k in changes)
            set_clause += ", updated_at = now()"
            vals = list(changes.values()) + [existing["id"]]
            cur.execute(f"UPDATE districts SET {set_clause} WHERE id = %s", vals)

        updated_count += 1

    if not dry_run:
        conn.commit()

    cur.execute(
        "SELECT COUNT(*) FROM districts WHERE state='IL' AND website_url IS NOT NULL"
    )
    with_website = cur.fetchone()[0]
    cur.close()
    return new_count, updated_count, with_website


def _log_run(conn, **kwargs) -> None:
    cols = ", ".join(kwargs.keys())
    placeholders = ", ".join(["%s"] * len(kwargs))
    with conn.cursor() as cur:
        cur.execute(
            f"INSERT INTO directory_refresh_log ({cols}) VALUES ({placeholders})",
            list(kwargs.values()),
        )
    conn.commit()


def run(dry_run: bool = False) -> dict:
    """
    Main refresh logic. Returns a result dict.
    Raises on unrecoverable errors.
    """
    conn = common.get_db_conn()
    _ensure_log_table(conn)

    log.info("Downloading ISBE directory …")
    data = _download_xls()
    file_hash = hashlib.sha256(data).hexdigest()
    log.info("Downloaded %d bytes, SHA-256: %s", len(data), file_hash[:16] + "…")

    with conn.cursor() as cur:
        cur.execute(
            """SELECT file_hash FROM directory_refresh_log
               WHERE status IN ('success', 'no_change')
               ORDER BY run_at DESC LIMIT 1"""
        )
        prev = cur.fetchone()
    prev_hash = prev[0] if prev else None

    if prev_hash and prev_hash == file_hash:
        log.info("File unchanged (SHA-256 match) — skipping reprocessing")
        if not dry_run:
            _log_run(conn, file_hash=file_hash, changed=False, status="no_change")
        conn.close()
        return {"changed": False, "status": "no_change"}

    today = date.today().isoformat()

    if not dry_run:
        local_path = IL_DIR_DIR / f"dir_ed_entities_{today}.xls"
        IL_DIR_DIR.mkdir(parents=True, exist_ok=True)
        with open(local_path, "wb") as f:
            f.write(data)
        log.info("Saved locally to %s", local_path)
        storage_key = f"il_directory/dir_ed_entities_{today}.xls"
        actual_key = common.upload_to_object_storage(local_path, storage_key)
        log.info("Object storage: %s", actual_key)
    else:
        tmp = tempfile.NamedTemporaryFile(suffix=".xls", delete=False)
        tmp.write(data)
        tmp.close()
        local_path = Path(tmp.name)
        log.info("Dry-run: temp file %s", local_path)

    records     = _parse_isbe_xls(local_path)
    row_count   = len(records)
    log.info("Parsed %d district rows (%d with URL)",
             row_count, sum(1 for r in records if r["url"]))

    new_count, updated_count, with_website = _upsert_districts(conn, records, dry_run)
    log.info(
        "Upsert: new=%d  updated=%d  with_website=%d  dry_run=%s",
        new_count, updated_count, with_website, dry_run,
    )

    if not dry_run:
        _log_run(
            conn,
            file_hash=file_hash,
            row_count=row_count,
            new_districts=new_count,
            updated_districts=updated_count,
            with_website=with_website,
            changed=True,
            status="success",
        )
    else:
        local_path.unlink(missing_ok=True)

    conn.close()
    return {
        "changed":           True,
        "status":            "success",
        "row_count":         row_count,
        "new_districts":     new_count,
        "updated_districts": updated_count,
        "with_website":      with_website,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Refresh ISBE Directory of Educational Entities"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Download and parse without writing to DB or object storage",
    )
    args = parser.parse_args()

    try:
        result = run(dry_run=args.dry_run)
        if result["status"] == "no_change":
            print("Directory unchanged — no update needed.")
        else:
            print(
                f"Refresh complete.  "
                f"row_count={result['row_count']}  "
                f"new={result['new_districts']}  "
                f"updated={result['updated_districts']}  "
                f"with_website={result['with_website']}"
            )
    except Exception as exc:
        log.exception("Directory refresh failed: %s", exc)
        try:
            conn = common.get_db_conn()
            _ensure_log_table(conn)
            _log_run(conn, changed=False, status="error", error=str(exc))
            conn.close()
        except Exception:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
