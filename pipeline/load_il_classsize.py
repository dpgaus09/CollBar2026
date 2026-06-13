#!/usr/bin/env python3
"""
Load ISBE Class Size Report xlsx files into il_district_fte.

Usage:
    python3 pipeline/load_il_classsize.py

Expects files in pipeline/data/il_classsize/*.xlsx
"""
import logging
import re
import sys
from pathlib import Path
from typing import Optional

import pandas as pd
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

IL_CLASSSIZE_DIR = common.DATA_DIR / "il_classsize"


def normalize_rcdts(raw) -> Optional[str]:
    """
    Normalize RCDTS (15-digit) or RCDT (11-digit) to 11-digit state_district_id.
    Per spec: strip non-digits, zero-pad to 15 (right-extend), take first 11.
    Skip rows whose RCDT isn't 9-11 digits after stripping (before padding).
    """
    if raw is None:
        return None
    try:
        if isinstance(raw, float):
            import math
            if math.isnan(raw):
                return None
    except Exception:
        pass
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


def school_year_from_int(raw) -> Optional[str]:
    """Convert year value (2024) → '2023-24' format."""
    try:
        s = str(raw).strip().split(".")[0]
        y = int(s)
        if y < 2000 or y > 2100:
            return None
        return f"{y - 1}-{str(y)[2:]}"
    except (ValueError, TypeError):
        return None


def range_sanitize(val, lo: float, hi: float) -> Optional[float]:
    """Return float if in [lo, hi], else None."""
    try:
        v = float(str(val).replace(",", "").strip())
        if lo <= v <= hi:
            return v
        return None
    except (ValueError, TypeError):
        return None


def load_school_data(path: Path) -> dict:
    """
    Read School Data sheet.
    Returns {(state_district_id, school_year): teacher_fte_sum}
    """
    log.info("  Reading School Data from %s", path.name)
    df = pd.read_excel(path, sheet_name="School Data", dtype=str)

    cols_lower = {c.strip().lower(): c for c in df.columns}

    rcdts_col = next((cols_lower[k] for k in cols_lower if "rcdts" in k), None)
    fte_col   = next((cols_lower[k] for k in cols_lower if "total teacher fte" in k), None)
    year_col  = next((cols_lower[k] for k in cols_lower if k.strip() == "school year"), None)

    if not rcdts_col or not fte_col or not year_col:
        log.warning("  School Data: missing columns in %s (rcdts=%s fte=%s year=%s)",
                    path.name, rcdts_col, fte_col, year_col)
        return {}

    result: dict = {}
    skipped = 0
    for _, row in df.iterrows():
        rcdt = normalize_rcdts(row[rcdts_col])
        if rcdt is None:
            skipped += 1
            continue
        fy = school_year_from_int(row[year_col])
        if fy is None:
            skipped += 1
            continue
        fte = range_sanitize(row[fte_col], 0, 20000)
        if fte is None:
            continue
        key = (rcdt, fy)
        result[key] = result.get(key, 0.0) + fte

    log.info("  School Data: %d district-year pairs, %d rows skipped", len(result), skipped)
    return result


def load_district_data(path: Path) -> dict:
    """
    Read District Data sheet (two-row header at rows 4-5, zero-indexed 3-4).
    Returns {(state_district_id, school_year): (ptr_elementary, ptr_highschool)}
    """
    log.info("  Reading District Data from %s", path.name)

    df = pd.read_excel(path, sheet_name="District Data", header=[3, 4], dtype=str)

    flat_cols = []
    for col in df.columns:
        if isinstance(col, tuple):
            parts = [
                str(p).strip()
                for p in col
                if str(p).strip()
                and str(p).strip().lower() not in ("nan", "none")
                and not str(p).strip().lower().startswith("unnamed:")
            ]
            flat_cols.append(" ".join(parts))
        else:
            flat_cols.append(str(col).strip())
    df.columns = flat_cols

    cols_lower = {c.lower(): c for c in flat_cols}

    year_col = next((cols_lower[k] for k in cols_lower if k.strip() == "school year"), None)
    rcdt_col  = next(
        (cols_lower[k] for k in cols_lower
         if "rcdt" in k and "entity" not in k and "rcdts" not in k),
        None,
    )
    if rcdt_col is None:
        rcdt_col = next((cols_lower[k] for k in cols_lower if "rcdt" in k), None)

    elem_col = next(
        (cols_lower[k] for k in cols_lower
         if "elementary" in k and ("pk" in k.replace("-", "").replace("(", "") or "pk" in k)),
        None,
    )
    hs_col = next(
        (cols_lower[k] for k in cols_lower
         if "high school" in k and "9" in k),
        None,
    )

    if not rcdt_col or not year_col:
        log.warning("  District Data: missing RCDT/year columns in %s "
                    "(rcdt=%s year=%s)", path.name, rcdt_col, year_col)
        return {}

    result: dict = {}
    skipped = 0
    for _, row in df.iterrows():
        rcdt = normalize_rcdts(row.get(rcdt_col))
        if rcdt is None:
            skipped += 1
            continue
        fy = school_year_from_int(row.get(year_col))
        if fy is None:
            skipped += 1
            continue
        ptr_elem = range_sanitize(row.get(elem_col), 0, 100) if elem_col else None
        ptr_hs   = range_sanitize(row.get(hs_col), 0, 100) if hs_col else None
        result[(rcdt, fy)] = (ptr_elem, ptr_hs)

    log.info("  District Data: %d district-year pairs, %d rows skipped", len(result), skipped)
    return result


def upsert_file(conn, path: Path) -> tuple[int, str, float]:
    """
    Process one xlsx file. Returns (rows_upserted, school_year, statewide_fte).
    """
    log.info("Processing %s", path.name)

    school = load_school_data(path)
    district = load_district_data(path)

    all_keys = set(school.keys()) | set(district.keys())
    if not all_keys:
        log.warning("  No data found in %s", path.name)
        return 0, "unknown", 0.0

    school_years = {fy for _, fy in all_keys}
    if len(school_years) > 1:
        log.warning("  Multiple school years found: %s — using all", school_years)
    primary_year = sorted(school_years)[-1]

    rows: list[tuple] = []
    for key in all_keys:
        rcdt, fy = key
        fte = school.get(key)
        ptr_elem, ptr_hs = district.get(key, (None, None))
        rows.append((rcdt, fy, fte, ptr_elem, ptr_hs))

    cur = conn.cursor()
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO il_district_fte
            (state_district_id, school_year, teacher_fte, ptr_elementary, ptr_highschool, loaded_at)
        VALUES %s
        ON CONFLICT (state_district_id, school_year) DO UPDATE SET
            teacher_fte    = EXCLUDED.teacher_fte,
            ptr_elementary = EXCLUDED.ptr_elementary,
            ptr_highschool = EXCLUDED.ptr_highschool,
            loaded_at      = now()
        """,
        rows,
        template="(%s, %s, %s, %s, %s, now())",
    )
    conn.commit()
    cur.close()

    statewide_fte = sum(v for (_, fy), v in school.items() if fy == primary_year and v is not None)
    log.info("  Upserted %d rows for %s", len(rows), path.name)
    return len(rows), primary_year, statewide_fte


def main():
    files = sorted(IL_CLASSSIZE_DIR.glob("*.xlsx"))
    if not files:
        log.error("No .xlsx files found in %s", IL_CLASSSIZE_DIR)
        sys.exit(1)

    conn = common.get_db_conn()

    print("\n" + "=" * 64)
    print("ISBE Class Size Report Loader")
    print("=" * 64)

    year_summary: dict[str, dict] = {}
    total_rows = 0

    for path in files:
        rows, primary_year, statewide_fte = upsert_file(conn, path)
        total_rows += rows
        year_summary.setdefault(primary_year, {"rows": 0, "fte": 0.0})
        year_summary[primary_year]["rows"] += rows
        year_summary[primary_year]["fte"] = max(year_summary[primary_year]["fte"], statewide_fte)

    conn.close()

    print(f"\n{'School Year':<12} {'Rows Loaded':>12} {'Statewide FTE':>14}")
    print("-" * 42)
    for yr in sorted(year_summary):
        info = year_summary[yr]
        flag = ""
        if yr == "2023-24":
            expected = 131840
            actual = info["fte"]
            delta_pct = abs(actual - expected) / expected * 100
            flag = f"  ({'✓ within 5%' if delta_pct <= 5 else f'⚠ expected ~{expected:,.0f}'})"
        print(f"{yr:<12} {info['rows']:>12,} {info['fte']:>14,.1f}{flag}")
    print("-" * 42)
    print(f"{'TOTAL':<12} {total_rows:>12,}")

    print("\nVerifying il_district_fte table:")
    conn2 = common.get_db_conn()
    cur = conn2.cursor()
    cur.execute("""
        SELECT school_year,
               COUNT(*) AS districts,
               SUM(teacher_fte) AS total_fte
        FROM il_district_fte
        GROUP BY school_year
        ORDER BY school_year
    """)
    rows_check = cur.fetchall()
    print(f"\n{'Year':<12} {'Districts':>10} {'Total FTE':>12}")
    print("-" * 36)
    for yr, n, fte in rows_check:
        print(f"{yr:<12} {n:>10,} {float(fte or 0):>12,.1f}")

    cur.execute("""
        SELECT COUNT(*) AS il_settlements_with_impact
        FROM settlements s
        JOIN districts d ON s.district_id = d.id
        JOIN il_district_fte fte
          ON fte.state_district_id = d.state_district_id
         AND fte.school_year = s.from_year
        JOIN tss_annual tss
          ON tss.state_district_id = d.state_district_id
         AND tss.school_year = s.from_year
         AND tss.state = 'IL'
        WHERE d.state = 'IL'
          AND s.base_increase_pct IS NOT NULL
          AND fte.teacher_fte IS NOT NULL
          AND tss.ba_begin IS NOT NULL
          AND tss.highest_scheduled_salary IS NOT NULL
    """)
    (impact_count,) = cur.fetchone()
    print(f"\nIL settlements with cost-impact estimate: {impact_count:,}")

    cur.close()
    conn2.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
