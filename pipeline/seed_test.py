#!/usr/bin/env python3
"""
CollBar Phase 1 — Test seed script.

Inserts 3 TEST_ districts and immediately deletes them, then prints a
row-count summary table for all 8 canonical tables.

Exits non-zero if any insert or delete fails.
"""

import os
import sys
import psycopg

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL environment variable is not set.", file=sys.stderr)
    sys.exit(1)

TABLES = [
    "districts",
    "source_documents",
    "contracts",
    "contract_provisions",
    "settlements",
    "factfinding_proposals",
    "extraction_runs",
    "users",
]

TEST_DISTRICTS = [
    ("TEST_ASHTABULA_SD", "TEST_ Ashtabula City School District", "Ashtabula"),
    ("TEST_WARREN_LSD", "TEST_ Warren Local School District", "Trumbull"),
    ("TEST_MEDINA_CSD", "TEST_ Medina City School District", "Medina"),
]


def count_rows(cur, table: str) -> int:
    # Table names are from a fixed allowlist — safe to interpolate.
    cur.execute(f"SELECT COUNT(*) FROM {table}")
    row = cur.fetchone()
    return row[0] if row else 0


def main() -> None:
    print("=" * 60)
    print("CollBar Phase 1 — Seed Test")
    print("=" * 60)

    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:

            # ── Pre-insert counts ─────────────────────────────────────
            print("\nRow counts BEFORE seed insert:")
            print(f"  {'Table':<30} {'Count':>6}")
            print(f"  {'-'*30} {'-'*6}")
            before_counts: dict[str, int] = {}
            for table in TABLES:
                n = count_rows(cur, table)
                before_counts[table] = n
                print(f"  {table:<30} {n:>6}")

            # ── Insert TEST_ districts ────────────────────────────────
            print("\nInserting 3 TEST_ districts…")
            inserted_ids: list[int] = []
            for irn, name, county in TEST_DISTRICTS:
                cur.execute(
                    """
                    INSERT INTO districts (state, state_district_id, name, county, district_type)
                    VALUES ('OH', %s, %s, %s, 'city')
                    RETURNING id
                    """,
                    (irn, name, county),
                )
                row = cur.fetchone()
                if row is None:
                    print(f"ERROR: Insert returned no id for {name}", file=sys.stderr)
                    conn.rollback()
                    sys.exit(1)
                inserted_ids.append(row[0])
                print(f"  Inserted id={row[0]}  {name}")

            conn.commit()

            # ── Post-insert counts ────────────────────────────────────
            after_insert = count_rows(cur, "districts")
            print(f"\ndistricts row count after insert: {after_insert}")
            if after_insert != before_counts["districts"] + 3:
                print(
                    f"ERROR: Expected {before_counts['districts'] + 3} districts, got {after_insert}",
                    file=sys.stderr,
                )
                sys.exit(1)

            # ── Delete TEST_ districts ────────────────────────────────
            print("\nDeleting TEST_ districts…")
            cur.execute(
                "DELETE FROM districts WHERE id = ANY(%s) RETURNING id",
                (inserted_ids,),
            )
            deleted = cur.fetchall()
            if len(deleted) != 3:
                print(
                    f"ERROR: Expected to delete 3 rows, deleted {len(deleted)}",
                    file=sys.stderr,
                )
                conn.rollback()
                sys.exit(1)
            conn.commit()
            print(f"  Deleted ids: {[r[0] for r in deleted]}")

            # ── Final row-count summary ───────────────────────────────
            print("\n" + "=" * 60)
            print("Acceptance Summary — Row counts after seed cleanup")
            print("=" * 60)
            print(f"\n  {'Table':<30} {'Count':>6}  {'Status':>8}")
            print(f"  {'-'*30} {'-'*6}  {'-'*8}")
            all_ok = True
            for table in TABLES:
                n = count_rows(cur, table)
                expected = before_counts[table]
                ok = n == expected
                if not ok:
                    all_ok = False
                status = "✓ OK" if ok else f"✗ FAIL (expected {expected})"
                print(f"  {table:<30} {n:>6}  {status}")

    print()
    if all_ok:
        print("All checks passed. Phase 1 acceptance criteria met.")
        sys.exit(0)
    else:
        print("ERROR: One or more row counts did not return to baseline.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
