#!/usr/bin/env python3
"""
Phase 9A — Sync IL districts from tss_annual into the districts table.

For every unique (state='IL', state_district_id) present in tss_annual, upsert
a districts row with:
  - name        : district_name from the most-recent school_year
  - enrollment  : integer midpoint parsed from enrollment_range text
  - county      : not available in TSS data — left NULL
  - slug        : il-<normalized-name>-<full-11-digit-rcdt>

Idempotent: safe to re-run; uses ON CONFLICT DO UPDATE so no duplicates.

Acceptance checks printed at end:
  - IL row count in districts
  - zero (state, state_district_id) duplicate pairs
"""
import logging
import re
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_enrollment(s: Optional[str]) -> Optional[int]:
    """
    Parse TSS enrollment_range text → approximate integer.

    Examples:
      "500-999"       → 749  (midpoint)
      "1,000-1,999"   → 1499
      "Less than 500" → 250  (half of upper bound)
      "12,000+"       → 12000
      "0-499"         → 249
    """
    if not s or not s.strip():
        return None
    s = s.strip().replace(",", "")

    # Numeric range: "500-999" or "0-499"
    m = re.match(r"^(\d+)-(\d+)$", s)
    if m:
        return (int(m.group(1)) + int(m.group(2))) // 2

    # "12000+" style
    m = re.match(r"^(\d+)\+$", s)
    if m:
        return int(m.group(1))

    # "Less than 500" / "Under 500"
    m = re.match(r"^(?:less\s+than|under)\s+(\d+)$", s, re.IGNORECASE)
    if m:
        return int(m.group(1)) // 2

    # Plain integer fallback
    try:
        return int(s)
    except ValueError:
        return None


def _slug_il(name: str, rcdt: str) -> str:
    """Unique slug: il-<normalised-name>-<11-digit-rcdt>."""
    base = "il-" + re.sub(r"[^a-z0-9]+", "-", name.lower().strip())
    digits = re.sub(r"\D", "", rcdt).zfill(11)
    slug = re.sub(r"-+", "-", f"{base}-{digits}").strip("-")
    return slug[:120]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    conn = common.get_db_conn()
    cur = conn.cursor()

    # Aggregate tss_annual: most-recent name and enrollment_range per RCDT.
    cur.execute("""
        WITH ranked AS (
            SELECT
                state_district_id,
                district_name,
                enrollment_range,
                ROW_NUMBER() OVER (
                    PARTITION BY state_district_id
                    ORDER BY school_year DESC
                ) AS rn
            FROM tss_annual
            WHERE state = 'IL' AND district_name IS NOT NULL
        )
        SELECT state_district_id, district_name, enrollment_range
        FROM   ranked
        WHERE  rn = 1
        ORDER  BY state_district_id
    """)
    rows = cur.fetchall()
    log.info("Syncing %d unique IL RCDTs from tss_annual", len(rows))

    upserted = 0
    errors = 0

    for rcdt, name, enrollment_range in rows:
        slug = _slug_il(name, rcdt)
        enrollment = _parse_enrollment(enrollment_range)

        try:
            cur.execute("SAVEPOINT sync_il_district")
            cur.execute(
                """
                INSERT INTO districts (state, state_district_id, name, enrollment, slug)
                VALUES ('IL', %s, %s, %s, %s)
                ON CONFLICT (state, state_district_id) DO UPDATE SET
                    name       = EXCLUDED.name,
                    enrollment = COALESCE(EXCLUDED.enrollment, districts.enrollment),
                    slug       = EXCLUDED.slug,
                    updated_at = NOW()
                """,
                (rcdt, name, enrollment, slug),
            )
            cur.execute("RELEASE SAVEPOINT sync_il_district")
            upserted += 1
        except Exception as exc:
            cur.execute("ROLLBACK TO SAVEPOINT sync_il_district")
            log.warning("Upsert error rcdt=%s name=%r: %s", rcdt, name, exc)
            errors += 1

    conn.commit()

    # --- Acceptance checks ---
    cur.execute("SELECT COUNT(*) FROM districts WHERE state = 'IL'")
    il_total: int = cur.fetchone()[0]

    cur.execute("""
        SELECT COUNT(*) FROM (
            SELECT state_district_id
            FROM   districts
            WHERE  state = 'IL'
            GROUP  BY state_district_id
            HAVING COUNT(*) > 1
        ) dup
    """)
    dupes: int = cur.fetchone()[0]

    cur.execute("""
        SELECT COUNT(DISTINCT d.id)
        FROM districts d
        JOIN tss_annual t ON t.state = 'IL'
                         AND t.state_district_id = d.state_district_id
        WHERE d.state = 'IL'
    """)
    matched: int = cur.fetchone()[0]

    cur.close()
    conn.close()

    W = 52
    print()
    print("=" * W)
    print("  09 — IL District Sync Results")
    print("=" * W)
    print(f"  RCDTs in tss_annual            : {len(rows):>6,}")
    print(f"  Rows upserted (or updated)     : {upserted:>6,}")
    print(f"  Errors                         : {errors:>6,}")
    print(f"  Total IL rows in districts     : {il_total:>6,}")
    print(f"  Matched to tss_annual          : {matched:>6,}")
    print(f"  Duplicate (state, id) pairs    : {dupes:>6,}  ← must be 0")
    print("=" * W)
    print()

    if dupes:
        log.error("DUPLICATE (state, state_district_id) pairs found — investigate!")
        sys.exit(1)


if __name__ == "__main__":
    main()
