"""
CollBar — Illinois TSS Loader v2
Handles all ISBE TSS vintages (2011-12 through 2025-26): auto-detects the data
sheet and header row, normalizes RCDT codes, range-sanitizes numerics so no
vintage's layout drift can overflow database columns.
Run: python3 pipeline/load_tss.py <file.xlsx|.xls> <school_year e.g. 2019-20>
Requires: pandas, openpyxl, xlrd, psycopg[binary]; env DATABASE_URL.
"""
import sys, os, re, json
import pandas as pd

DDL = """
CREATE TABLE IF NOT EXISTS tss_annual (
    id BIGSERIAL PRIMARY KEY,
    state CHAR(2) NOT NULL DEFAULT 'IL',
    state_district_id TEXT NOT NULL,
    school_year VARCHAR(7) NOT NULL,
    district_name TEXT,
    enrollment_range TEXT,
    affiliation TEXT,
    ba_begin NUMERIC(12,2), ba_max NUMERIC(12,2), ba_years_to_max INTEGER,
    ma_begin NUMERIC(12,2), ma_max NUMERIC(12,2), ma_years_to_max INTEGER,
    highest_scheduled_salary NUMERIC(12,2),
    trs_board_paid_pct NUMERIC(6,2),
    contract_expires DATE,
    personal_days NUMERIC(6,1), sick_days NUMERIC(6,1),
    payload JSONB NOT NULL,
    loaded_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (state, state_district_id, school_year)
);
"""
# widen columns if v1 already created them as SMALLINT / narrow NUMERIC
ALTERS = [
    "ALTER TABLE tss_annual ALTER COLUMN ba_years_to_max TYPE INTEGER",
    "ALTER TABLE tss_annual ALTER COLUMN ma_years_to_max TYPE INTEGER",
    "ALTER TABLE tss_annual ALTER COLUMN ba_begin TYPE NUMERIC(12,2)",
    "ALTER TABLE tss_annual ALTER COLUMN ba_max TYPE NUMERIC(12,2)",
    "ALTER TABLE tss_annual ALTER COLUMN ma_begin TYPE NUMERIC(12,2)",
    "ALTER TABLE tss_annual ALTER COLUMN ma_max TYPE NUMERIC(12,2)",
    "ALTER TABLE tss_annual ALTER COLUMN highest_scheduled_salary TYPE NUMERIC(12,2)",
    "ALTER TABLE tss_annual ALTER COLUMN trs_board_paid_pct TYPE NUMERIC(6,2)",
    "ALTER TABLE tss_annual ALTER COLUMN personal_days TYPE NUMERIC(6,1)",
    "ALTER TABLE tss_annual ALTER COLUMN sick_days TYPE NUMERIC(6,1)",
]

def rng(v, lo, hi):
    """Coerce to float and null out anything outside a sane range."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if pd.isna(f) or f < lo or f > hi:
        return None
    return f

def find_sheet_and_header(path):
    xl = pd.ExcelFile(path)
    best = None
    for s in xl.sheet_names:
        head = pd.read_excel(xl, sheet_name=s, header=None, nrows=6)
        for i in range(len(head)):
            if head.iloc[i].astype(str).str.contains("RCDT", case=False, na=False).any():
                n = len(pd.read_excel(xl, sheet_name=s, header=None))
                if best is None or n > best[2]:
                    best = (s, i, n)
                break
    if best is None:
        raise SystemExit(f"No sheet with an RCDT header found in {path}")
    return best[0], best[1]

def norm_rcdt(v):
    s = re.sub(r"\D", "", str(v))          # digits only (kills '.0', dashes)
    if 9 <= len(s) <= 11:
        return s.zfill(11)                  # restore leading zeros lost to Excel
    return None

ALIASES = {
    "name":     ["DISTRICT NAME", "DIST NAME", "DISTRICT"],
    "enroll":   ["ENROLLMENT RANGE", "ENROLLMENT"],
    "affil":    ["AFFILIATION", "=LA", "LA"],
    "ba_begin": ["BACHELOR'S BEGINNING", "BACHELORS BEGINNING", "=BB", "BB"],
    "ba_max":   ["BACHELOR'S MAXIMUM", "BACHELORS MAXIMUM", "=BM", "BM"],
    "ba_ytm":   ["BACHELOR'S YEARS", "BACHELORS YEARS", "=BYTM", "BYTM"],
    "ma_begin": ["MASTER'S BEGINNING", "MASTERS BEGINNING", "=MB", "MB"],
    "ma_max":   ["MASTER'S MAXIMUM", "MASTERS MAXIMUM", "=MM", "MM"],
    "ma_ytm":   ["MASTER'S YEARS", "MASTERS YEARS", "=MYTM", "MYTM"],
    "hss":      ["HIGHEST SCHEDULE", "=HSS", "HSS"],
    "trs":      ["BOARD PAID TRS", "TRS PERCENT", "RETIREMENT", "=TPBP", "TPBP"],
    "exp":      ["EXPIRATION", "=EXP", "EXP"],
    "personal": ["DAYS PERSONAL", "PERSONAL", "=DP", "DP"],
    "sick":     ["DAYS SICK", "SICK", "=DS", "DS"],
}

def col(df, key):
    cands = ALIASES[key]
    cols = {str(c).upper().strip(): c for c in df.columns}
    for cand in cands:
        if cand.startswith("="):                 # exact short-code match only
            if cand[1:] in cols: return cols[cand[1:]]
        else:                                    # fragment match
            for cu, c in cols.items():
                if cand in cu: return c
    return None

def parse(path, school_year):
    sheet, hdr = find_sheet_and_header(path)
    df = pd.read_excel(path, sheet_name=sheet, header=hdr)
    df.columns = [re.sub(r"\s+", " ", str(c)).strip() for c in df.columns]
    rcdt_col = df.columns[0]
    df["_rcdt"] = df[rcdt_col].map(norm_rcdt)
    df = df.dropna(subset=["_rcdt"])
    print(f"  sheet='{sheet}' header_row={hdr} districts={len(df)}")

    c_exp = col(df, "exp")
    rows = []
    for _, r in df.iterrows():
        exp = None
        if c_exp and pd.notna(r[c_exp]):
            raw = str(r[c_exp]).strip()
            for fmt in ("%m/%Y", "%m/%d/%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
                try:
                    exp = pd.to_datetime(raw, format=fmt).date(); break
                except ValueError:
                    continue
            if exp and not (2000 <= exp.year <= 2050):
                exp = None
        payload = {k: (None if pd.isna(v) else (v.isoformat() if hasattr(v, "isoformat") else v))
                   for k, v in r.items() if k != "_rcdt"}
        name_col = col(df, "name") or df.columns[1]
        rows.append((
            r["_rcdt"], school_year,
            str(r[name_col])[:200] if pd.notna(r[name_col]) else None,
            str(r.get(col(df, "enroll"), ""))[:50] or None,
            str(r.get(col(df, "affil"), ""))[:50] or None,
            rng(r.get(col(df, "ba_begin")), 10000, 200000),
            rng(r.get(col(df, "ba_max")), 10000, 300000),
            rng(r.get(col(df, "ba_ytm")), 0, 60),
            rng(r.get(col(df, "ma_begin")), 10000, 250000),
            rng(r.get(col(df, "ma_max")), 10000, 350000),
            rng(r.get(col(df, "ma_ytm")), 0, 60),
            rng(r.get(col(df, "hss")), 10000, 500000),
            rng(r.get(col(df, "trs")), 0, 100),
            exp,
            rng(r.get(col(df, "personal")), 0, 100),
            rng(r.get(col(df, "sick")), 0, 400),
            json.dumps(payload, default=str),
        ))
    return rows

def main(path, school_year):
    rows = parse(path, school_year)
    import psycopg
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(DDL)
        for a in ALTERS:
            try: cur.execute(a)
            except Exception: conn.rollback()
        conn.commit()
        cur.executemany("""
            INSERT INTO tss_annual (state_district_id, school_year, district_name,
                enrollment_range, affiliation, ba_begin, ba_max, ba_years_to_max,
                ma_begin, ma_max, ma_years_to_max, highest_scheduled_salary,
                trs_board_paid_pct, contract_expires, personal_days, sick_days, payload)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (state, state_district_id, school_year) DO UPDATE SET
                payload = EXCLUDED.payload, contract_expires = EXCLUDED.contract_expires,
                ba_begin = EXCLUDED.ba_begin, ba_max = EXCLUDED.ba_max,
                ma_begin = EXCLUDED.ma_begin, ma_max = EXCLUDED.ma_max,
                ba_years_to_max = EXCLUDED.ba_years_to_max,
                ma_years_to_max = EXCLUDED.ma_years_to_max,
                trs_board_paid_pct = EXCLUDED.trs_board_paid_pct,
                district_name = EXCLUDED.district_name, loaded_at = now();
        """, rows)
        cur.execute("""
            INSERT INTO districts (state, state_district_id, name)
            SELECT DISTINCT 'IL', state_district_id, district_name FROM tss_annual
            WHERE school_year = %s AND district_name IS NOT NULL
            ON CONFLICT (state, state_district_id) DO NOTHING;
        """, (school_year,))
        conn.commit()
        cur.execute("""SELECT date_part('year', contract_expires) yr, count(*)
                       FROM tss_annual WHERE school_year=%s AND contract_expires IS NOT NULL
                       GROUP BY 1 ORDER BY 1;""", (school_year,))
        print(f"Loaded {len(rows)} districts for {school_year}. Expirations by year:")
        for yr, n in cur.fetchall():
            print(f"  {int(yr)}: {n}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
