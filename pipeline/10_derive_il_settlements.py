#!/usr/bin/env python3
"""
Phase 9A — Derive IL settlements by diffing consecutive TSS school years.

For every IL district, compare adjacent tss_annual rows (sorted by school_year)
where the two years are truly consecutive in the ISBE TSS sequence.  When a
non-zero, in-range BA-begin change is found a settlements row is written with
    method='tss_diff', confidence=0.90

Additional fields populated:
  base_increase_pct  — BA-beginning salary % change (rounded to 2 dp)
  year2_pct          — MA-beginning salary % change (if both present)
  insurance_changed  — TRUE when trs_board_paid_pct shifts by ≥ 0.1 pp
  notes              — human-readable summary of which fields moved
  from_year / to_year — prev / curr school_year strings

Guard rails (mirrors Ohio derive_settlements skip-reason logging):
  - Pairs that are not truly consecutive        → skip "gap_in_data"
  - BA-begin NULL in either year                → skip "missing_ba_prev/curr"
  - BA change == 0.00%                          → skip "zero_change"
  - BA change > +25% or < -10%                 → skip "delta_out_of_range"
                                                   AND append to review file

Review file: pipeline/state/il_tss_outliers.jsonl
Idempotent: ON CONFLICT (district_id, from_year, to_year) DO NOTHING.

Usage:
    python3 pipeline/10_derive_il_settlements.py [--dry-run]
"""
import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

# Ordered list of all TSS school years loaded.
YEAR_SEQUENCE = [
    "2015-16", "2016-17", "2017-18", "2018-19", "2019-20",
    "2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26",
]
# Map each year to the immediately following year.
NEXT_YEAR: dict[str, str] = {
    a: b for a, b in zip(YEAR_SEQUENCE, YEAR_SEQUENCE[1:])
}

OUTLIER_FILE = Path(__file__).parent / "state" / "il_tss_outliers.jsonl"
CONFIDENCE = 0.90
METHOD = "tss_diff"

# Guard-rail thresholds
MAX_DELTA_PCT =  25.0   # > +25% → probable data error
MIN_DELTA_PCT = -10.0   # < -10% → probable data error (salary cuts are rare)
TRS_CHANGE_THRESHOLD = 0.1   # pp change considered meaningful


# ---------------------------------------------------------------------------
# Outlier queue
# ---------------------------------------------------------------------------

def _flag_outlier(fh, entry: dict) -> None:
    """Write one JSON record to the (already-open) review queue file."""
    fh.write(json.dumps(entry, default=str) + "\n")


# ---------------------------------------------------------------------------
# Settlement note builder
# ---------------------------------------------------------------------------

def _build_notes(
    ba_pct: float,
    ma_pct: Optional[float],
    trs_prev: Optional[float],
    trs_curr: Optional[float],
) -> str:
    parts = [f"ba_begin {ba_pct:+.2f}%"]
    if ma_pct is not None:
        parts.append(f"ma_begin {ma_pct:+.2f}%")
    if trs_prev is not None and trs_curr is not None and abs(trs_curr - trs_prev) >= TRS_CHANGE_THRESHOLD:
        parts.append(f"trs_board_paid_pct {trs_prev:.2f}→{trs_curr:.2f}")
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# Main derivation
# ---------------------------------------------------------------------------

def derive(conn, dry_run: bool = False) -> int:
    """
    Derive IL settlements.  Returns the count of newly inserted rows.
    Mirrors the skip-reason logging pattern from Ohio derive_settlements().
    """
    cur = conn.cursor()

    # Outlier file: truncate at the start of each run so re-runs produce a
    # clean file rather than accumulating duplicates.
    OUTLIER_FILE.parent.mkdir(parents=True, exist_ok=True)
    outlier_fh = OUTLIER_FILE.open("w")

    # skip_reasons[reason] = count  (same pattern as Ohio derivation)
    skip_reasons: dict[str, int] = {}

    def _skip(reason: str) -> None:
        skip_reasons[reason] = skip_reasons.get(reason, 0) + 1

    # --- Load all IL tss_annual rows with district FK ---
    cur.execute("""
        SELECT
            t.state_district_id,
            t.school_year,
            t.ba_begin,
            t.ma_begin,
            t.trs_board_paid_pct,
            t.highest_scheduled_salary,
            d.id AS district_id,
            d.name
        FROM tss_annual t
        JOIN districts d
          ON d.state              = 'IL'
         AND d.state_district_id  = t.state_district_id
        WHERE t.state = 'IL'
        ORDER BY t.state_district_id, t.school_year
    """)
    all_rows = cur.fetchall()

    if not all_rows:
        log.warning("No IL tss_annual rows found — run load_il_tss.py first.")
        return 0

    # Group rows by district.
    from collections import defaultdict
    by_district: dict[str, list] = defaultdict(list)
    no_district_rcdt: set[str] = set()

    for row in all_rows:
        rcdt = row[0]
        district_id = row[6]
        if district_id is None:
            no_district_rcdt.add(rcdt)
            _skip("no_district_id")
        else:
            by_district[rcdt].append(row)

    if no_district_rcdt:
        log.warning(
            "%d RCDTs have no matching districts row — run 09_sync_il_districts.py first.",
            len(no_district_rcdt),
        )

    inserted = 0
    conflict = 0
    pairs_evaluated = 0
    outliers_flagged = 0

    for rcdt, district_rows in by_district.items():
        # district_rows are already sorted by school_year (ORDER BY above)
        district_id: int = district_rows[0][6]
        district_name: str = district_rows[0][7]

        if len(district_rows) < 2:
            _skip("no_prior_year")
            continue

        for i in range(len(district_rows) - 1):
            prev = district_rows[i]
            curr = district_rows[i + 1]

            prev_year = prev[1]    # school_year
            curr_year = curr[1]

            pairs_evaluated += 1

            # ---- Must be truly consecutive in the TSS sequence ----
            if NEXT_YEAR.get(prev_year) != curr_year:
                log.debug(
                    "rcdt=%s %s→%s not consecutive — skipping",
                    rcdt, prev_year, curr_year,
                )
                _skip("gap_in_data")
                continue

            prev_ba: Optional[float] = prev[2]
            curr_ba: Optional[float] = curr[2]
            prev_ma: Optional[float] = prev[3]
            curr_ma: Optional[float] = curr[3]
            prev_trs: Optional[float] = prev[4]
            curr_trs: Optional[float] = curr[4]

            # ---- BA-begin must be present in both years ----
            if prev_ba is None:
                _skip("missing_ba_prev")
                continue
            if curr_ba is None:
                _skip("missing_ba_curr")
                continue

            # ---- Compute BA % change ----
            if prev_ba == 0:
                _skip("prev_ba_zero")
                continue

            ba_pct = round((float(curr_ba) - float(prev_ba)) / float(prev_ba) * 100, 4)

            # ---- Zero-change guard ----
            if ba_pct == 0.0:
                log.debug(
                    "rcdt=%s %s→%s ba_begin unchanged at %.2f — skipping",
                    rcdt, prev_year, curr_year, prev_ba,
                )
                _skip("zero_change")
                continue

            # ---- Out-of-range guard ----
            if ba_pct > MAX_DELTA_PCT or ba_pct < MIN_DELTA_PCT:
                log.debug(
                    "rcdt=%s %s→%s ba_pct=%.2f%% out of range [%.0f%%,+%.0f%%] — flagging",
                    rcdt, prev_year, curr_year, ba_pct, MIN_DELTA_PCT, MAX_DELTA_PCT,
                )
                _skip("delta_out_of_range")
                _flag_outlier(outlier_fh, {
                    "rcdt":           rcdt,
                    "district_name":  district_name,
                    "from_year":      prev_year,
                    "to_year":        curr_year,
                    "ba_begin_prev":  float(prev_ba),
                    "ba_begin_curr":  float(curr_ba),
                    "ba_pct":         ba_pct,
                    "reason":         "delta_out_of_range",
                })
                outliers_flagged += 1
                continue

            # ---- Compute supplementary fields ----
            ma_pct: Optional[float] = None
            if prev_ma is not None and curr_ma is not None and float(prev_ma) > 0:
                ma_pct = round(
                    (float(curr_ma) - float(prev_ma)) / float(prev_ma) * 100, 4
                )

            trs_changed = (
                prev_trs is not None
                and curr_trs is not None
                and abs(float(curr_trs) - float(prev_trs)) >= TRS_CHANGE_THRESHOLD
            )

            notes = _build_notes(ba_pct, ma_pct, prev_trs, curr_trs)

            # ---- Insert settlement ----
            if dry_run:
                log.info(
                    "[dry-run] district=%d rcdt=%s %s→%s ba=+%.2f%% notes=%r",
                    district_id, rcdt, prev_year, curr_year, ba_pct, notes,
                )
                inserted += 1
                continue

            try:
                cur.execute("SAVEPOINT tss_settlement")
                cur.execute(
                    """
                    INSERT INTO settlements
                        (district_id, from_year, to_year,
                         base_increase_pct, year2_pct,
                         insurance_changed,
                         method, confidence, notes)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (district_id, from_year, to_year) DO NOTHING
                    """,
                    (
                        district_id,
                        prev_year,
                        curr_year,
                        round(ba_pct, 2),
                        round(ma_pct, 2) if ma_pct is not None else None,
                        trs_changed,
                        METHOD,
                        CONFIDENCE,
                        notes,
                    ),
                )
                if cur.rowcount > 0:
                    inserted += 1
                    log.debug(
                        "Settlement district=%d %s→%s ba=%.2f%% inserted",
                        district_id, prev_year, curr_year, ba_pct,
                    )
                else:
                    conflict += 1
                cur.execute("RELEASE SAVEPOINT tss_settlement")
            except Exception as exc:
                cur.execute("ROLLBACK TO SAVEPOINT tss_settlement")
                log.warning(
                    "Insert error district=%d %s→%s: %s",
                    district_id, prev_year, curr_year, exc,
                )
                _skip("insert_error")

    if not dry_run:
        conn.commit()

    outlier_fh.close()

    # ---- Skip-reason summary (mirrors Ohio pattern exactly) ----
    total_skips = sum(skip_reasons.values())
    print()
    print("  IL Settlement derivation — skip-reason summary")
    print(f"  {'Reason':<35} {'Count':>7}")
    print(f"  {'-'*35} {'-'*7}")
    if skip_reasons:
        for reason, count in sorted(skip_reasons.items(), key=lambda x: -x[1]):
            print(f"  {reason:<35} {count:>7,}")
    else:
        print("  (no skips)")
    print(f"  {'-'*35} {'-'*7}")
    print(f"  {'TOTAL skipped':<35} {total_skips:>7,}")
    print(f"  {'Pairs evaluated':<35} {pairs_evaluated:>7,}")
    print(f"  {'Settlements inserted':<35} {inserted:>7,}")
    print(f"  {'Conflicts (already existed)':<35} {conflict:>7,}")
    print(f"  {'Outliers flagged to review':<35} {outliers_flagged:>7,}")
    if outliers_flagged:
        print(f"  Review file: {OUTLIER_FILE}")
    print()

    return inserted


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Derive IL TSS settlements from consecutive school-year diffs"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and compute diffs but do not write to DB",
    )
    args = parser.parse_args()

    conn = common.get_db_conn()
    inserted = derive(conn, dry_run=args.dry_run)
    conn.close()

    if args.dry_run:
        print(f"[dry-run] Would insert {inserted:,} settlements — nothing written.")
        return

    # ---- Final acceptance report ----
    conn2 = common.get_db_conn()
    cur = conn2.cursor()

    # Settlements count by to_year for IL
    cur.execute("""
        SELECT s.to_year, COUNT(*) AS n
        FROM settlements s
        JOIN districts d ON d.id = s.district_id AND d.state = 'IL'
        WHERE s.method = %s
        GROUP BY s.to_year
        ORDER BY s.to_year
    """, (METHOD,))
    by_year = cur.fetchall()

    cur.execute("""
        SELECT COUNT(*)
        FROM settlements s
        JOIN districts d ON d.id = s.district_id AND d.state = 'IL'
        WHERE s.method = %s
    """, (METHOD,))
    total_settlements: int = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM districts WHERE state = 'IL'")
    il_districts: int = cur.fetchone()[0]

    cur.execute("""
        SELECT COUNT(*) FROM (
            SELECT state_district_id FROM districts WHERE state = 'IL'
            GROUP BY state_district_id HAVING COUNT(*) > 1
        ) dup
    """)
    il_dupes: int = cur.fetchone()[0]

    cur.close()
    conn2.close()

    W = 58
    print("=" * W)
    print("  10 — IL TSS Settlement Derivation — Final Results")
    print("=" * W)
    print(f"  {'to_year':<12} {'settlements':>12}")
    print(f"  {'-'*12} {'-'*12}")
    for yr, n in by_year:
        print(f"  {yr:<12} {n:>12,}")
    print(f"  {'-'*12} {'-'*12}")
    print(f"  {'TOTAL':<12} {total_settlements:>12,}")
    print()
    print(f"  IL districts in districts table : {il_districts:>6,}")
    print(f"  Duplicate (state, id) pairs     : {il_dupes:>6,}  ← must be 0")
    print("=" * W)
    print()


if __name__ == "__main__":
    main()
