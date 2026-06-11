#!/usr/bin/env python3
"""
Load Ohio school districts from the FY2025 DEW District Profile XLSX into the districts table.

Usage: python3 pipeline/01_load_districts.py
"""
import re
import sys
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

import openpyxl

common.setup_logging()
log = logging.getLogger(__name__)

XLSX = common.DATA_DIR / "fy2025_district_profile.xlsx"

DISTRICT_TYPE_KEYWORDS = [
    ("Exempted Village", "exempted_village"),
    ("Joint Vocational", "jvsd"),
    ("Career", "career_tech"),
    ("STEM", "stem"),
    ("Community", "community"),
    ("City", "city"),
    ("Local", "local"),
    ("Municipal", "city"),
]


def parse_district_row(raw_name: str):
    """
    Parse: "Manchester Local (000442) - Adams County"
    Returns (name, irn, county, district_type)
    """
    m = re.match(r"^(.+?)\s*\((\d{6})\)\s*-\s*(.+)$", raw_name.strip())
    if not m:
        return raw_name.strip(), None, None, "other"
    name_part = m.group(1).strip()
    irn = m.group(2)
    county = m.group(3).strip()
    district_type = "other"
    for kw, dtype in DISTRICT_TYPE_KEYWORDS:
        if kw.lower() in name_part.lower():
            district_type = dtype
            break
    return name_part, irn, county, district_type


def safe_numeric(val):
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def main():
    if not XLSX.exists():
        log.error("XLSX not found: %s", XLSX)
        sys.exit(1)

    log.info("Loading workbook: %s", XLSX)
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb["District Data"]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()

    # Find the data start (skip header rows — header is row with "District Name")
    data_start = 0
    for i, row in enumerate(rows[:15]):
        if row and row[0] and "district" in str(row[0]).lower():
            data_start = i + 1
            break

    data_rows = rows[data_start:]
    log.info("Found %d data rows (starting after row %d)", len(data_rows), data_start)

    state = common.load_crawl_state()
    conn = common.get_db_conn()
    cur = conn.cursor()

    loaded = 0
    skipped = 0

    for row in data_rows:
        if not row or not row[0]:
            continue

        raw_name = str(row[0]).strip()
        # Skip aggregate/summary rows
        if not raw_name or raw_name.lower() in ("district name", "total", "state total"):
            continue
        # Skip rows without the "(XXXXXX)" IRN pattern in column 0
        irn_in_name = re.search(r"\((\d{6})\)", raw_name)
        if not irn_in_name:
            skipped += 1
            continue

        name, irn, county, district_type = parse_district_row(raw_name)

        # col 1: IRN (redundant with name, use as fallback)
        irn = irn or (str(row[1]).strip() if len(row) > 1 and row[1] else None)
        if not irn:
            skipped += 1
            continue

        enrollment = safe_numeric(row[4] if len(row) > 4 else None)
        avg_salary = safe_numeric(row[14] if len(row) > 14 else None)
        valuation = safe_numeric(row[21] if len(row) > 21 else None)

        try:
            cur.execute(
                """
                INSERT INTO districts (state, state_district_id, name, county, district_type,
                    enrollment, valuation, avg_teacher_salary)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (state, state_district_id) DO UPDATE SET
                    name               = EXCLUDED.name,
                    county             = EXCLUDED.county,
                    district_type      = EXCLUDED.district_type,
                    enrollment         = EXCLUDED.enrollment,
                    valuation          = EXCLUDED.valuation,
                    avg_teacher_salary = EXCLUDED.avg_teacher_salary,
                    updated_at         = NOW()
                """,
                ("OH", irn, name, county, district_type, enrollment, valuation, avg_salary),
            )
            loaded += 1
        except Exception as e:
            log.warning("Failed to insert district %s (IRN %s): %s", name, irn, e)
            conn.rollback()
            continue

    conn.commit()
    cur.close()
    conn.close()

    state["districts_loaded"] = loaded
    common.save_crawl_state(state)

    log.info("Districts loaded: %d (skipped: %d)", loaded, skipped)
    return loaded


if __name__ == "__main__":
    main()
