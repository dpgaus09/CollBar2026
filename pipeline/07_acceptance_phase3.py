#!/usr/bin/env python3
"""
Phase 3 Acceptance Summary.

Prints extraction stats and exits non-zero if any gate fails.

Gates (always enforced by default):
  1. Any contract row has no source_doc_id (provenance check)
  2. Any contract_provision is not traceable to a source_doc via contracts table
  3. Fewer than MIN_CONTRACTS contracts extracted (use --sample to bypass in dev)

Usage:
    python3 pipeline/07_acceptance_phase3.py [--sample]

Flags:
    --sample    Skip the ≥100-contract threshold (for sample/dev corpus runs).
                The provenance gate is always enforced.
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
        "--sample",
        action="store_true",
        help="Skip the ≥100 contract threshold (use for sample/dev corpus runs). "
             "Provenance gate is always enforced.",
    )
    args = parser.parse_args()

    conn = common.get_db_conn()
    cur = conn.cursor()

    print("\n" + "=" * 60)
    print("  CollBar — Phase 3 Acceptance Summary")
    print("=" * 60)

    # --- Extraction run counts ---
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

    # --- Contract counts ---
    cur.execute("SELECT COUNT(*) FROM contracts")
    total_contracts = cur.fetchone()[0]

    # Gate 1: contracts without source_doc_id
    cur.execute("SELECT COUNT(*) FROM contracts WHERE source_doc_id IS NULL")
    orphan_contracts = cur.fetchone()[0]

    # Gate 2: contract_provisions not traceable to a source_doc (via contracts)
    cur.execute(
        """
        SELECT COUNT(cp.id)
        FROM contract_provisions cp
        JOIN contracts c ON cp.contract_id = c.id
        WHERE c.source_doc_id IS NULL
        """
    )
    untraceable_provisions = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM contract_provisions")
    total_provisions = cur.fetchone()[0]

    cur.execute(
        "SELECT COUNT(*) FROM contract_provisions WHERE confidence < 0.8 AND NOT human_verified"
    )
    review_queue_count = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM contract_provisions WHERE human_verified = true")
    human_verified_count = cur.fetchone()[0]

    # Gate 4: provisions without page_ref (partial provenance)
    cur.execute("SELECT COUNT(*) FROM contract_provisions WHERE page_ref IS NULL")
    no_page_ref_count = cur.fetchone()[0]

    print(f"\n--- Contracts & Provisions ---")
    print(f"  Contracts extracted     : {total_contracts:>8,}")
    print(f"  Contracts w/o source_doc: {orphan_contracts:>8,}  (must be 0)")
    print(f"  Provisions extracted    : {total_provisions:>8,}")
    print(f"  Untraceable provisions  : {untraceable_provisions:>8,}  (must be 0)")
    print(f"  Provisions w/o page_ref : {no_page_ref_count:>8,}  (must be 0)")
    print(f"  Review queue items      : {review_queue_count:>8,}  (confidence < 0.8, unverified)")
    print(f"  Human-verified          : {human_verified_count:>8,}")

    # --- Settlement counts ---
    cur.execute("SELECT COUNT(*) FROM settlements")
    total_settlements = cur.fetchone()[0]
    cur.execute("SELECT method, COUNT(*) FROM settlements GROUP BY method")
    settlement_methods = dict(cur.fetchall())

    print(f"\n--- Settlements ---")
    print(f"  Total settlements       : {total_settlements:>8,}")
    for method, count in settlement_methods.items():
        label = f"  Method '{method}'"
        print(f"{label:<30}: {count:>8,}")

    # --- Source doc coverage ---
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

    # --- Gate 1: No orphan contracts ---
    if orphan_contracts > 0:
        failures_found.append(
            f"GATE FAIL: {orphan_contracts} contract row(s) have no source_doc_id. "
            "Every extracted contract must be traceable to a source document."
        )

    # --- Gate 2: No untraceable provisions ---
    if untraceable_provisions > 0:
        failures_found.append(
            f"GATE FAIL: {untraceable_provisions} contract_provision row(s) are not "
            "traceable to any source_doc (parent contract has NULL source_doc_id). "
            "Zero rows without provenance is required."
        )

    # --- Gate 4: Provisions without page_ref (partial provenance) ---
    if no_page_ref_count > 0:
        pct = (no_page_ref_count / total_provisions * 100) if total_provisions > 0 else 0.0
        msg = (
            f"{'WARN' if args.sample else 'GATE FAIL'}: "
            f"{no_page_ref_count} provision(s) ({pct:.1f}%) have no page_ref. "
            "Every extracted value should carry page-level provenance. "
            "These provisions are capped at confidence ≤ 0.6 and land in the review queue."
        )
        if args.sample:
            print(f"\n  {msg}")
        else:
            failures_found.append(msg)

    # --- Gate 3: Minimum contract count ---
    if not args.sample and total_contracts < MIN_CONTRACTS:
        failures_found.append(
            f"GATE FAIL: Only {total_contracts} contracts extracted; "
            f"require ≥{MIN_CONTRACTS} for full corpus. "
            "Run 06_extract_contracts.py on the full corpus, or pass --sample "
            "to skip this threshold for development/sample runs."
        )

    if failures_found:
        for msg in failures_found:
            print(f"\n  {msg}")
        print("=" * 60 + "\n")
        return 1

    # --- All gates passed ---
    if total_contracts == 0:
        note = "NOTE: No contracts extracted yet — run 06_extract_contracts.py first."
        if args.sample:
            note += " (--sample bypasses the ≥100 threshold)"
        print(f"\n  {note}")
    elif args.sample:
        print(
            f"\n  PASS (--sample): {total_contracts} contracts, "
            f"{orphan_contracts} orphans, {review_queue_count} in review queue."
        )
        print("  Threshold gate skipped — rerun without --sample on the full corpus.")
    else:
        print(
            f"\n  PASS: {total_contracts} contracts (≥{MIN_CONTRACTS} ✓), "
            f"0 orphans, {review_queue_count} in review queue."
        )
    print("=" * 60 + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
