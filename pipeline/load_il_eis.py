#!/usr/bin/env python3
"""
Load ISBE EIS / ATSB individual educator salary records into il_eis_district.
Stores only district-level aggregates — no individual names persisted.

Handles six distinct file formats (2020-EIS through 2025-ATSB) via
auto-detection of the header row and column-name normalization.

Usage:
    python3 pipeline/load_il_eis.py

Files: pipeline/data/il_eis/*.xlsx
"""
import logging
import re
import sys
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

IL_EIS_DIR = common.DATA_DIR / "il_eis"

# ---------------------------------------------------------------------------
# PRIVACY: columns that must never be stored or logged
# ---------------------------------------------------------------------------
PRIVATE_COLS_RE = re.compile(r"(last|first|middle)\s*name|lastname|firstname|middlename",
                             re.IGNORECASE)

# ---------------------------------------------------------------------------
# Column normalization helpers
# ---------------------------------------------------------------------------

def _norm(s: str) -> str:
    """Lowercase, strip whitespace."""
    return re.sub(r"\s+", "", str(s).strip().lower())


# Normalized-name → semantic key
_YEAR_KEYS       = {"schoolyear", "year", "schoolyearid"}
_RCDTS_KEYS      = {"rcdts", "employerrcdts"}
_POSITION_KEYS   = {"positiondescription", "positioncodedescription"}
_BASE_SAL_KEYS   = {"basesalary"}
_SICK_KEYS       = {"sickdays", "sickday"}
_FTE_SALARY_KEYS = {"ftesalary", "positionftesalary"}
# FTE: must match but NOT contain "salary"
_FTE_KEYS        = {"fulltimeequivalent", "fte"}
# Per-educator benefit / leave detail columns
_VACATION_KEYS   = {"vacationday", "vacationdays"}
_BONUS_KEYS      = {"bonus", "bonuses"}
_ANNUITY_KEYS    = {"annuities", "annuity"}
_RETIRE_ENH_KEYS = {"retirementenhancements", "retirementenhancement"}
_OTHER_BEN_KEYS  = {"otherbenefits", "otherbenefit"}


def _find_col(norm_to_orig: dict, candidates: set, exclude_substr: str | None = None) -> Optional[str]:
    for n, orig in norm_to_orig.items():
        if n in candidates:
            if exclude_substr and exclude_substr in n:
                continue
            return orig
    return None


# ---------------------------------------------------------------------------
# Header auto-detection
# ---------------------------------------------------------------------------

def _detect_header_row(path: Path, sheet) -> int:
    """Return the 0-indexed row that contains 'year' and 'rcdts' keywords."""
    raw = pd.read_excel(path, sheet_name=sheet, nrows=5, header=None, dtype=str)
    for i, row in raw.iterrows():
        vals = [_norm(str(v)) for v in row if str(v).strip().lower() not in ("nan", "none", "")]
        has_year  = any("year" in v or v in _YEAR_KEYS  for v in vals)
        has_rcdts = any("rcdts" in v for v in vals)
        if has_year and has_rcdts:
            return int(i)
    return 0


# ---------------------------------------------------------------------------
# RCDTS normalization  (same logic as load_il_classsize.py)
# ---------------------------------------------------------------------------

def _normalize_rcdts(raw) -> Optional[str]:
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
# School year derivation
# ---------------------------------------------------------------------------

def _school_year(raw) -> Optional[str]:
    try:
        s = str(raw).strip().split(".")[0]
        y = int(s)
        if y < 2000 or y > 2100:
            return None
        return f"{y - 1}-{str(y)[2:]}"
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Salary range filter
# ---------------------------------------------------------------------------
SAL_MIN, SAL_MAX = 10_000, 500_000


def _to_float(v) -> Optional[float]:
    try:
        f = float(str(v).replace(",", "").strip())
        return f if np.isfinite(f) else None
    except (ValueError, TypeError):
        return None


def _n(v):
    """Coerce a value to a psycopg2-safe Python native or None.

    `.tolist()` already converts numpy scalars to Python natives, so this only
    needs to map None and NaN floats to None.
    """
    if v is None:
        return None
    if isinstance(v, float) and v != v:  # NaN
        return None
    return v


# ---------------------------------------------------------------------------
# Position grouping (coarse buckets for per-position rollups)
# ---------------------------------------------------------------------------
_ADMIN_RE = re.compile(
    r"superintendent|principal|administrat|\bdean\b|\bdirector\b|"
    r"business\s*manager|business\s*official|coordinator",
    re.IGNORECASE,
)


def _classify_position(pos: str) -> str:
    """Coarse position group: teacher / administrator / other."""
    p = (pos or "").lower()
    if "teacher" in p:
        return "teacher"
    if _ADMIN_RE.search(p):
        return "administrator"
    return "other"


# ---------------------------------------------------------------------------
# Schema self-migration (additive, idempotent, prod-safe)
# ---------------------------------------------------------------------------

def _ensure_eis_schema(conn) -> None:
    """Create the EIS tables/indexes if missing. Safe to run repeatedly and in
    production (CREATE ... IF NOT EXISTS only; no drops, no type changes)."""
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS il_eis_district (
            id BIGSERIAL PRIMARY KEY,
            state_district_id TEXT NOT NULL,
            school_year VARCHAR(7) NOT NULL,
            teacher_headcount INTEGER,
            teacher_fte NUMERIC(12,2),
            avg_teacher_salary NUMERIC(12,2),
            median_teacher_salary NUMERIC(12,2),
            p25_salary NUMERIC(12,2),
            p75_salary NUMERIC(12,2),
            total_teacher_base_payroll NUMERIC(16,2),
            avg_sick_days NUMERIC(6,1),
            all_staff_headcount INTEGER,
            all_staff_fte NUMERIC(12,2),
            loaded_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE (state_district_id, school_year)
        );
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS il_eis_educator (
            id BIGSERIAL PRIMARY KEY,
            state_district_id TEXT NOT NULL,
            school_year VARCHAR(7) NOT NULL,
            position_description TEXT,
            is_teacher BOOLEAN,
            base_salary NUMERIC(12,2),
            fte NUMERIC(6,3),
            fte_salary NUMERIC(12,2),
            sick_days NUMERIC(6,1),
            vacation_days NUMERIC(6,1),
            bonus NUMERIC(12,2),
            annuities NUMERIC(12,2),
            retirement_enhancements NUMERIC(12,2),
            other_benefits NUMERIC(12,2),
            loaded_at TIMESTAMPTZ DEFAULT now()
        );
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS il_eis_educator_district_year_idx
            ON il_eis_educator (state_district_id, school_year);
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS il_eis_educator_year_pos_idx
            ON il_eis_educator (school_year, position_description);
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS il_eis_position_summary (
            id BIGSERIAL PRIMARY KEY,
            state_district_id TEXT NOT NULL,
            school_year VARCHAR(7) NOT NULL,
            position_description TEXT NOT NULL,
            position_group TEXT,
            headcount INTEGER,
            total_fte NUMERIC(12,3),
            avg_salary NUMERIC(12,2),
            median_salary NUMERIC(12,2),
            p25_salary NUMERIC(12,2),
            p75_salary NUMERIC(12,2),
            avg_sick_days NUMERIC(6,1),
            avg_vacation_days NUMERIC(6,1),
            total_base_salary NUMERIC(16,2),
            total_bonus NUMERIC(16,2),
            total_annuities NUMERIC(16,2),
            total_retirement_enhancements NUMERIC(16,2),
            total_other_benefits NUMERIC(16,2),
            loaded_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE (state_district_id, school_year, position_description)
        );
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS il_eis_position_summary_district_year_idx
            ON il_eis_position_summary (state_district_id, school_year);
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS il_eis_position_summary_group_idx
            ON il_eis_position_summary (school_year, position_group);
    """)

    # Self-repair any partial drift: additively add every non-key column if a
    # table already exists from an older version. CREATE TABLE IF NOT EXISTS
    # alone would leave a pre-existing table missing newer columns.
    _eis_alters = {
        "il_eis_educator": [
            ("position_description", "TEXT"), ("is_teacher", "BOOLEAN"),
            ("base_salary", "NUMERIC(12,2)"), ("fte", "NUMERIC(6,3)"),
            ("fte_salary", "NUMERIC(12,2)"), ("sick_days", "NUMERIC(6,1)"),
            ("vacation_days", "NUMERIC(6,1)"), ("bonus", "NUMERIC(12,2)"),
            ("annuities", "NUMERIC(12,2)"),
            ("retirement_enhancements", "NUMERIC(12,2)"),
            ("other_benefits", "NUMERIC(12,2)"),
            ("loaded_at", "TIMESTAMPTZ DEFAULT now()"),
        ],
        "il_eis_position_summary": [
            ("position_group", "TEXT"), ("headcount", "INTEGER"),
            ("total_fte", "NUMERIC(12,3)"), ("avg_salary", "NUMERIC(12,2)"),
            ("median_salary", "NUMERIC(12,2)"), ("p25_salary", "NUMERIC(12,2)"),
            ("p75_salary", "NUMERIC(12,2)"), ("avg_sick_days", "NUMERIC(6,1)"),
            ("avg_vacation_days", "NUMERIC(6,1)"),
            ("total_base_salary", "NUMERIC(16,2)"),
            ("total_bonus", "NUMERIC(16,2)"),
            ("total_annuities", "NUMERIC(16,2)"),
            ("total_retirement_enhancements", "NUMERIC(16,2)"),
            ("total_other_benefits", "NUMERIC(16,2)"),
            ("loaded_at", "TIMESTAMPTZ DEFAULT now()"),
        ],
    }
    for table, cols in _eis_alters.items():
        for col, sqltype in cols:
            cur.execute(
                f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {sqltype}"
            )

    conn.commit()
    cur.close()


# ---------------------------------------------------------------------------
# Per-file processor
# ---------------------------------------------------------------------------

def _process_file(path: Path) -> tuple[int, str, float, float]:
    """
    Process one EIS/ATSB file.
    Returns (rows_upserted, school_year, statewide_teacher_fte, fw_avg_salary).
    """
    log.info("Processing %s", path.name)

    # Detect sheet
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet_name = wb.sheetnames[0]
    wb.close()

    # Detect header row
    hdr_row = _detect_header_row(path, sheet_name)
    log.info("  Header at row %d (sheet '%s')", hdr_row, sheet_name)

    df = pd.read_excel(path, sheet_name=sheet_name, header=hdr_row, dtype=str)

    # Drop private columns immediately — never process individual names
    drop_cols = [c for c in df.columns if PRIVATE_COLS_RE.search(str(c))]
    df.drop(columns=drop_cols, inplace=True)
    log.info("  Dropped private columns: %s", drop_cols)

    # Build normalized column map
    norm_map = {_norm(c): c for c in df.columns}

    year_col    = _find_col(norm_map, _YEAR_KEYS)
    rcdts_col   = _find_col(norm_map, _RCDTS_KEYS)
    pos_col     = _find_col(norm_map, _POSITION_KEYS)
    base_col    = _find_col(norm_map, _BASE_SAL_KEYS)
    sick_col    = _find_col(norm_map, _SICK_KEYS)
    fte_col     = _find_col(norm_map, _FTE_KEYS, exclude_substr="salary")
    ftesal_col  = _find_col(norm_map, _FTE_SALARY_KEYS)
    vac_col     = _find_col(norm_map, _VACATION_KEYS)
    bonus_col   = _find_col(norm_map, _BONUS_KEYS)
    annu_col    = _find_col(norm_map, _ANNUITY_KEYS)
    ret_col     = _find_col(norm_map, _RETIRE_ENH_KEYS)
    other_col   = _find_col(norm_map, _OTHER_BEN_KEYS)

    missing = [k for k, v in {"year": year_col, "rcdts": rcdts_col,
                               "position": pos_col, "fte": fte_col,
                               "fte_salary": ftesal_col}.items() if v is None]
    if missing:
        log.warning("  Missing columns %s in %s — skipping", missing, path.name)
        return 0, "unknown", 0.0, 0.0

    log.info("  Columns: year=%s rcdts=%s pos=%s fte=%s ftesal=%s base=%s sick=%s",
             year_col, rcdts_col, pos_col, fte_col, ftesal_col, base_col, sick_col)

    # Determine school_year from data (take majority-vote value from first non-null rows)
    sample_years = df[year_col].dropna().head(200).map(_school_year).dropna()
    if sample_years.empty:
        log.warning("  Could not derive school_year from %s", path.name)
        return 0, "unknown", 0.0, 0.0
    school_yr = sample_years.mode().iloc[0]
    log.info("  Derived school_year=%s", school_yr)

    # Parse numeric fields
    df["_rcdts"]   = df[rcdts_col].map(_normalize_rcdts)
    df["_fte"]     = df[fte_col].map(_to_float)
    df["_ftesal"]  = df[ftesal_col].map(_to_float)
    # Optional numeric columns -> float64 (NaN where absent) so groupby
    # aggregations below are safe; missing source column => all-NaN column.
    df["_basesal"] = (df[base_col].map(_to_float).astype("float64")
                      if base_col else np.nan)
    df["_sick"]    = (df[sick_col].map(_to_float).astype("float64")
                      if sick_col else np.nan)
    df["_vac"]     = (df[vac_col].map(_to_float).astype("float64")
                      if vac_col else np.nan)
    df["_bonus"]   = (df[bonus_col].map(_to_float).astype("float64")
                      if bonus_col else np.nan)
    df["_annu"]    = (df[annu_col].map(_to_float).astype("float64")
                      if annu_col else np.nan)
    df["_ret"]     = (df[ret_col].map(_to_float).astype("float64")
                      if ret_col else np.nan)
    df["_other"]   = (df[other_col].map(_to_float).astype("float64")
                      if other_col else np.nan)

    # Drop rows with null RCDTS
    total_rows = len(df)
    df = df.dropna(subset=["_rcdts"])
    log.info("  %d rows total, %d with valid RCDTS", total_rows, len(df))

    # Teacher flag: position contains "teacher" (case-insensitive)
    df["_is_teacher"] = df[pos_col].fillna("").str.contains("teacher", case=False, na=False)

    # Apply salary range filter (for salary stats only — mask, not drop)
    df["_ftesal_clean"] = df["_ftesal"].where(
        df["_ftesal"].between(SAL_MIN, SAL_MAX), other=np.nan
    )

    # Group by district
    results = []
    for rcdt, grp in df.groupby("_rcdts"):
        teachers = grp[grp["_is_teacher"]]

        # Teachers with positive FTE — for weighted salary stats
        t_valid = teachers[teachers["_fte"].fillna(0) > 0].copy()
        t_sal   = t_valid[t_valid["_ftesal_clean"].notna()]

        # FTE-weighted average salary
        if not t_sal.empty:
            fw_num  = (t_sal["_ftesal_clean"] * t_sal["_fte"]).sum()
            fw_den  = t_sal["_fte"].sum()
            avg_sal = float(fw_num / fw_den) if fw_den > 0 else None
            med_sal = float(t_sal["_ftesal_clean"].median())
            p25_sal = float(t_sal["_ftesal_clean"].quantile(0.25))
            p75_sal = float(t_sal["_ftesal_clean"].quantile(0.75))
        else:
            avg_sal = med_sal = p25_sal = p75_sal = None

        teacher_fte    = float(teachers["_fte"].fillna(0).sum()) or None
        teacher_hc     = int(len(teachers))
        total_base_pay = (
            float(teachers["_basesal"].fillna(0).sum())
            if "_basesal" in teachers.columns and teachers["_basesal"].notna().any()
            else None
        )
        avg_sick = (
            float(teachers["_sick"].dropna().mean())
            if "_sick" in teachers.columns and teachers["_sick"].notna().any()
            else None
        )
        all_hc  = int(len(grp))
        all_fte = float(grp["_fte"].fillna(0).sum()) or None

        results.append((
            rcdt, school_yr,
            teacher_hc if teacher_hc > 0 else None,
            teacher_fte,
            avg_sal, med_sal, p25_sal, p75_sal,
            total_base_pay,
            avg_sick,
            all_hc if all_hc > 0 else None,
            all_fte,
        ))

    if not results:
        return 0, school_yr, 0.0, 0.0

    # -----------------------------------------------------------------------
    # Per-educator rows (anonymized — names were dropped at read time).
    # Stored unmasked (raw salaries) so downstream stats can be recomputed.
    # tolist() converts numpy scalars to Python natives; _n() maps NaN -> None.
    # -----------------------------------------------------------------------
    df["_pos"] = df[pos_col].fillna("").astype(str).str.strip()
    pos_series = df["_pos"].where(df["_pos"] != "", None)

    rcdts_l  = df["_rcdts"].tolist()
    pos_l    = pos_series.tolist()
    teach_l  = df["_is_teacher"].tolist()
    base_l   = df["_basesal"].tolist()
    fte_l    = df["_fte"].tolist()
    ftesal_l = df["_ftesal"].tolist()
    sick_l   = df["_sick"].tolist()
    vac_l    = df["_vac"].tolist()
    bonus_l  = df["_bonus"].tolist()
    annu_l   = df["_annu"].tolist()
    ret_l    = df["_ret"].tolist()
    other_l  = df["_other"].tolist()

    educator_rows = [
        (
            rcdts_l[i], school_yr, pos_l[i], bool(teach_l[i]),
            _n(base_l[i]), _n(fte_l[i]), _n(ftesal_l[i]), _n(sick_l[i]),
            _n(vac_l[i]), _n(bonus_l[i]), _n(annu_l[i]), _n(ret_l[i]),
            _n(other_l[i]),
        )
        for i in range(len(rcdts_l))
    ]

    # -----------------------------------------------------------------------
    # Per-position summaries (district x position_description).
    # -----------------------------------------------------------------------
    pos_df = df[df["_pos"] != ""].copy()
    summary_rows: list = []
    if not pos_df.empty:
        g = pos_df.groupby(["_rcdts", "_pos"])
        agg = pd.DataFrame({
            "headcount":   g.size(),
            "total_fte":   g["_fte"].apply(lambda s: s.dropna().sum()
                                           if s.notna().any() else np.nan),
            "avg_sick":    g["_sick"].mean(),
            "avg_vac":     g["_vac"].mean(),
            "total_base":  g["_basesal"].sum(min_count=1),
            "total_bonus": g["_bonus"].sum(min_count=1),
            "total_annu":  g["_annu"].sum(min_count=1),
            "total_ret":   g["_ret"].sum(min_count=1),
            "total_other": g["_other"].sum(min_count=1),
        })

        # FTE-weighted salary stats over positive-FTE, in-range salaries only.
        sal_df = pos_df[(pos_df["_fte"].fillna(0) > 0)
                        & pos_df["_ftesal_clean"].notna()].copy()
        if not sal_df.empty:
            sal_df["_w"] = sal_df["_ftesal_clean"] * sal_df["_fte"]
            sg = sal_df.groupby(["_rcdts", "_pos"])
            sal_agg = pd.DataFrame({
                "_num":    sg["_w"].sum(),
                "_den":    sg["_fte"].sum(),
                "med_sal": sg["_ftesal_clean"].median(),
                "p25_sal": sg["_ftesal_clean"].quantile(0.25),
                "p75_sal": sg["_ftesal_clean"].quantile(0.75),
            })
            sal_agg["avg_sal"] = (sal_agg["_num"]
                                  / sal_agg["_den"].where(sal_agg["_den"] > 0))
            agg = agg.join(sal_agg[["avg_sal", "med_sal", "p25_sal", "p75_sal"]])
        else:
            agg[["avg_sal", "med_sal", "p25_sal", "p75_sal"]] = np.nan

        agg = agg.reset_index()
        agg["_grp"] = agg["_pos"].map(_classify_position)

        c = {col: agg[col].tolist() for col in agg.columns}
        summary_rows = [
            (
                c["_rcdts"][i], school_yr, c["_pos"][i], c["_grp"][i],
                _n(c["headcount"][i]), _n(c["total_fte"][i]),
                _n(c["avg_sal"][i]), _n(c["med_sal"][i]),
                _n(c["p25_sal"][i]), _n(c["p75_sal"][i]),
                _n(c["avg_sick"][i]), _n(c["avg_vac"][i]),
                _n(c["total_base"][i]), _n(c["total_bonus"][i]),
                _n(c["total_annu"][i]), _n(c["total_ret"][i]),
                _n(c["total_other"][i]),
            )
            for i in range(len(c["_rcdts"]))
        ]

    # -----------------------------------------------------------------------
    # Write everything in one transaction. DELETE-by-year then insert gives a
    # clean wholesale replace for the detail tables (the district table upserts).
    # -----------------------------------------------------------------------
    conn = common.get_db_conn()
    cur  = conn.cursor()
    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO il_eis_district (
            state_district_id, school_year,
            teacher_headcount, teacher_fte,
            avg_teacher_salary, median_teacher_salary, p25_salary, p75_salary,
            total_teacher_base_payroll, avg_sick_days,
            all_staff_headcount, all_staff_fte, loaded_at
        ) VALUES %s
        ON CONFLICT (state_district_id, school_year) DO UPDATE SET
            teacher_headcount          = EXCLUDED.teacher_headcount,
            teacher_fte                = EXCLUDED.teacher_fte,
            avg_teacher_salary         = EXCLUDED.avg_teacher_salary,
            median_teacher_salary      = EXCLUDED.median_teacher_salary,
            p25_salary                 = EXCLUDED.p25_salary,
            p75_salary                 = EXCLUDED.p75_salary,
            total_teacher_base_payroll = EXCLUDED.total_teacher_base_payroll,
            avg_sick_days              = EXCLUDED.avg_sick_days,
            all_staff_headcount        = EXCLUDED.all_staff_headcount,
            all_staff_fte              = EXCLUDED.all_staff_fte,
            loaded_at                  = now()
        """,
        results,
        template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
    )

    # Per-educator detail — replace this school year wholesale.
    cur.execute("DELETE FROM il_eis_educator WHERE school_year = %s", (school_yr,))
    if educator_rows:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO il_eis_educator (
                state_district_id, school_year, position_description, is_teacher,
                base_salary, fte, fte_salary, sick_days, vacation_days,
                bonus, annuities, retirement_enhancements, other_benefits
            ) VALUES %s
            """,
            educator_rows,
            page_size=5000,
        )

    # Per-position summaries — replace this school year wholesale.
    cur.execute("DELETE FROM il_eis_position_summary WHERE school_year = %s",
                (school_yr,))
    if summary_rows:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO il_eis_position_summary (
                state_district_id, school_year, position_description, position_group,
                headcount, total_fte, avg_salary, median_salary, p25_salary,
                p75_salary, avg_sick_days, avg_vacation_days, total_base_salary,
                total_bonus, total_annuities, total_retirement_enhancements,
                total_other_benefits
            ) VALUES %s
            """,
            summary_rows,
            page_size=5000,
        )

    conn.commit()
    cur.close()
    conn.close()

    log.info("  +%d educator rows, +%d position summaries",
             len(educator_rows), len(summary_rows))

    # Statewide stats for this file
    teacher_rows = [r for r in results if r[3] is not None]
    state_fte = sum(r[3] for r in teacher_rows if r[3])
    sal_vals  = [r[4] for r in teacher_rows if r[4] is not None]
    state_avg = float(np.mean(sal_vals)) if sal_vals else 0.0

    log.info("  Upserted %d districts for %s | teacher FTE=%.0f avg_sal=$%.0f",
             len(results), school_yr, state_fte, state_avg)
    return len(results), school_yr, state_fte, state_avg


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="Load ISBE EIS/ATSB salary data into il_eis_district",
    )
    parser.add_argument(
        "--file",
        help="Process a single .xlsx file (school year auto-detected from the "
             "data) instead of globbing the data dir. Used by the admin upload.",
    )
    args = parser.parse_args()

    single_file_mode = bool(args.file)
    if single_file_mode:
        one = Path(args.file)
        if not one.exists():
            log.error("File not found: %s", one)
            sys.exit(1)
        files = [one]
    else:
        files = sorted(IL_EIS_DIR.glob("*.xlsx"))
        if not files:
            log.error("No .xlsx files found in %s", IL_EIS_DIR)
            sys.exit(1)

    print("\n" + "=" * 68)
    print("ISBE EIS / ATSB Salary Loader (district + educator + position)")
    print("=" * 68)

    # Self-apply the additive schema once before loading (idempotent, prod-safe).
    _schema_conn = common.get_db_conn()
    _ensure_eis_schema(_schema_conn)
    _schema_conn.close()

    year_summary: dict[str, dict] = {}
    processed_ok = False

    for path in files:
        rows, yr, fte, avg_sal = _process_file(path)
        if yr == "unknown" or rows == 0:
            continue
        processed_ok = True
        year_summary.setdefault(yr, {"rows": 0, "fte": 0.0, "avg": 0.0})
        year_summary[yr]["rows"] = max(year_summary[yr]["rows"], rows)
        year_summary[yr]["fte"]  = max(year_summary[yr]["fte"], fte)
        year_summary[yr]["avg"]  = max(year_summary[yr]["avg"], avg_sal)

    # In single-file (upload) mode, a file that produced no usable rows is a
    # hard failure so the admin panel surfaces an error instead of "success".
    if single_file_mode and not processed_ok:
        log.error(
            "No usable rows parsed from %s — the file may not be an EIS/ATSB "
            "salary export (expected SchoolYearId, RCDTS, PositionCodeDescription, "
            "FullTimeEquivalent, FTESalary columns).",
            files[0].name,
        )
        sys.exit(1)

    print(f"\n{'School Year':<12} {'Districts':>10} {'Teacher FTE':>13} {'FW Avg Salary':>15}")
    print("-" * 54)
    for yr in sorted(year_summary):
        info = year_summary[yr]
        flag = ""
        if yr == "2020-21":
            exp_fte, exp_avg = 130876, 69486
            fte_ok  = abs(info["fte"] - exp_fte) / exp_fte < 0.05
            avg_ok  = abs(info["avg"] - exp_avg) / exp_avg < 0.05
            flag = f"  ({'✓' if fte_ok else '⚠'} FTE, {'✓' if avg_ok else '⚠'} avg)"
        print(f"{yr:<12} {info['rows']:>10,} {info['fte']:>13,.0f} "
              f"${info['avg']:>13,.0f}{flag}")

    # Final DB check
    print("\nVerifying il_eis_district table:")
    conn = common.get_db_conn()
    cur  = conn.cursor()
    cur.execute("""
        SELECT school_year,
               COUNT(*)::int                           AS districts,
               SUM(teacher_fte)::numeric(12,1)         AS total_fte,
               ROUND(
                 SUM(avg_teacher_salary * teacher_fte) /
                 NULLIF(SUM(teacher_fte), 0), 0
               )                                       AS fw_avg_salary
        FROM il_eis_district
        WHERE teacher_fte > 0
        GROUP BY school_year ORDER BY school_year
    """)
    rows = cur.fetchall()
    print(f"\n{'Year':<12} {'Districts':>10} {'Total FTE':>11} {'FW Avg Salary':>15}")
    print("-" * 52)
    for yr, n, fte, avg in rows:
        flag = ""
        if yr == "2020-21":
            exp_d, exp_fte, exp_avg = 861, 130876, 69486
            flag = (f"  ({'✓' if abs(n-exp_d)/exp_d<0.05 else '⚠'} districts, "
                    f"{'✓' if float(fte or 0) and abs(float(fte)-exp_fte)/exp_fte<0.05 else '⚠'} FTE, "
                    f"{'✓' if avg and abs(float(avg)-exp_avg)/exp_avg<0.05 else '⚠'} avg)")
        print(f"{yr:<12} {n:>10,} {float(fte or 0):>11,.0f} ${float(avg or 0):>13,.0f}{flag}")

    # Coverage: how many IL settlements now have EIS salary (not TSS fallback)
    cur.execute("""
        SELECT COUNT(*) AS with_eis_salary
        FROM settlements s
        JOIN districts d ON s.district_id = d.id
        JOIN il_eis_district eis
          ON eis.state_district_id = d.state_district_id
         AND eis.school_year = s.from_year
        JOIN il_district_fte fte
          ON fte.state_district_id = d.state_district_id
         AND fte.school_year = s.from_year
        WHERE d.state = 'IL'
          AND s.base_increase_pct IS NOT NULL
          AND eis.avg_teacher_salary IS NOT NULL
          AND fte.teacher_fte IS NOT NULL
    """)
    (eis_count,) = cur.fetchone()

    # EIS cross-check: flag settlements where diff > 2 pp
    cur.execute("""
        SELECT COUNT(*) AS flagged
        FROM settlements s
        JOIN districts d ON s.district_id = d.id
        JOIN il_eis_district eis_curr
          ON eis_curr.state_district_id = d.state_district_id
         AND eis_curr.school_year = s.from_year
        JOIN il_eis_district eis_prev
          ON eis_prev.state_district_id = d.state_district_id
         AND eis_prev.school_year = (
               (CAST(LEFT(s.from_year,4) AS INT) - 1)::TEXT
               || '-' ||
               RIGHT(CAST(LEFT(s.from_year,4) AS INT)::TEXT, 2)
             )
        WHERE d.state = 'IL'
          AND s.base_increase_pct IS NOT NULL
          AND eis_curr.avg_teacher_salary IS NOT NULL
          AND eis_prev.avg_teacher_salary > 0
          AND ABS(
                s.base_increase_pct -
                ROUND(((eis_curr.avg_teacher_salary - eis_prev.avg_teacher_salary)
                       / eis_prev.avg_teacher_salary) * 100, 2)
              ) > 2
    """)
    (flag_count,) = cur.fetchone()

    cur.close()
    conn.close()

    print(f"\nIL settlements with REAL EIS salary (non-modeled): {eis_count:,}")
    print(f"IL settlements flagged by EIS cross-check (diff >2pp): {flag_count:,}")
    print("\nDone.")


if __name__ == "__main__":
    main()
