#!/usr/bin/env python3
"""
Phase 3 Acceptance Summary.

Prints extraction stats and exits non-zero if:
  - Any contract row has no source_doc_id
  - Fewer than MIN_CONTRACTS contracts extracted AND --require-100 is set

Usage: python3 pipeline/07_acceptance_phase3.py [--require-100]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()

MIN_CONTRACTS = 100


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--require-100",
        action="store_true",
        help="Fail if fewer than 100 contracts are extracted (use for full-corpus runs)",
    )
    args = parser.parse_args()

    conn = common.get_db_conn()
    cur = conn.cursor()

    print("\n" + "=" * 60)
    print("  CollBar — Phase 3 Acceptance Summary")
    print("=" * 60)

    # Extraction run counts
    cur.execute("SELECT status, COUNT(*) FROM extraction_runs GROUP BY status")
    run_counts = {row[0]: row[1] for row in cur.fetchall()}
    total_runs = sum(run_counts.values())
    successes = run_counts.get("success", 0)
    failures = run_counts.get("failed", 0)
    pending = run_counts.get("pending", 0)

    print(f"\n--- Extraction Runs ---")
    print(f"  Total runs              : {total_runs:>8,}")
    print(f"  Successes               : {successes:>8,}")
    print(f"  Failures                : {failures:>8,}")
    print(f"  Pending                 : {pending:>8,}")

    # Contract counts
    cur.execute("SELECT COUNT(*) FROM contracts")
    total_contracts = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM contracts WHERE source_doc_id IS NULL")
    orphan_contracts = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM contract_provisions")
    total_provisions = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM contract_provisions WHERE confidence < 0.8 AND NOT human_verified")
    review_queue_count = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM contract_provisions WHERE human_verified = true")
    human_verified_count = cur.fetchone()[0]

    print(f"\n--- Contracts & Provisions ---")
    print(f"  Contracts extracted     : {total_contracts:>8,}")
    print(f"  Contracts w/o source_doc: {orphan_contracts:>8,}  (must be 0)")
    print(f"  Provisions extracted    : {total_provisions:>8,}")
    print(f"  Review queue items      : {review_queue_count:>8,}  (confidence < 0.8, unverified)")
    print(f"  Human-verified          : {human_verified_count:>8,}")

    # Settlement counts
    cur.execute("SELECT COUNT(*) FROM settlements")
    total_settlements = cur.fetchone()[0]
    cur.execute("SELECT method, COUNT(*) FROM settlements GROUP BY method")
    settlement_methods = dict(cur.fetchall())

    print(f"\n--- Settlements ---")
    print(f"  Total settlements       : {total_settlements:>8,}")
    for method, count in settlement_methods.items():
        print(f"  Method '{method}'{' ' * max(0, 14 - len(method))}: {count:>8,}")

    # Source doc coverage
    cur.execute("SELECT COUNT(*) FROM source_documents WHERE doc_type = 'cba_pdf'")
    total_cba_docs = cur.fetchone()[0]
    cur.execute(
        """
        SELECT COUNT(DISTINCT source_doc_id)
        FROM extraction_runs
        WHERE status = 'success'
        """
    )
    processed_docs = cur.fetchone()[0]

    print(f"\n--- Source Coverage ---")
    print(f"  CBA PDFs in DB          : {total_cba_docs:>8,}")
    print(f"  PDFs with successful run: {processed_docs:>8,}")
    if total_cba_docs > 0:
        coverage = (processed_docs / total_cba_docs) * 100
        print(f"  Extraction coverage     : {coverage:>7.1f}%")

    cur.close()
    conn.close()

    print("\n" + "=" * 60)

    failures_found = []

    # Gate 1: No orphan contracts (zero rows without source_doc_id)
    if orphan_contracts > 0:
        failures_found.append(
            f"{orphan_contracts} contract row(s) have no source_doc_id. "
            "Every extracted row must be traceable."
        )

    # Gate 2: Minimum contracts (only when --require-100)
    if args.require_100 and total_contracts < MIN_CONTRACTS:
        failures_found.append(
            f"Only {total_contracts} contracts extracted; require ≥{MIN_CONTRACTS}. "
            "Run 06_extract_contracts.py on the full corpus first."
        )

    if failures_found:
        for msg in failures_found:
            print(f"\n  FAIL: {msg}")
        print("=" * 60 + "\n")
        return 1
    else:
        if total_contracts == 0:
            print("\n  NOTE: No contracts extracted yet — run 06_extract_contracts.py first.")
        elif not args.require_100:
            print(f"\n  PASS: {total_contracts} contracts, {orphan_contracts} orphans, "
                  f"{review_queue_count} in review queue.")
            print("  (Run with --require-100 to enforce the ≥100 threshold.)")
        else:
            print(f"\n  PASS: {total_contracts} contracts extracted, 0 orphans.")
        print("=" * 60 + "\n")
        return 0


if __name__ == "__main__":
    sys.exit(main())
