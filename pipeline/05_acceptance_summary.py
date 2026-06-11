#!/usr/bin/env python3
"""
Acceptance summary — prints row counts for all Phase 2 tables and
the district match rate. Exits non-zero if match rate < 90%.

Usage: python3 pipeline/05_acceptance_summary.py
"""
import argparse
import sys
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

TABLES = [
    "districts",
    "source_documents",
    "factfinding_proposals",
    "benchmarks",
    "contracts",
    "contract_provisions",
    "settlements",
]

MATCH_RATE_THRESHOLD = 90.0
# A full run is considered complete when ≥95% of found docs have been
# processed (downloaded + skipped-cached + failed).
CORPUS_COMPLETENESS_THRESHOLD = 95.0


def count_rows(cur, table: str) -> int:
    try:
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        row = cur.fetchone()
        return row[0] if row else 0
    except Exception as e:
        log.warning("Could not count %s: %s", table, e)
        return -1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--skip-completeness",
        action="store_true",
        help=(
            "Skip the corpus-completeness gate (use for bounded/dev runs "
            "where --max-pdfs was set intentionally)"
        ),
    )
    args = parser.parse_args()

    state = common.load_crawl_state()
    conn = common.get_db_conn()
    cur = conn.cursor()

    print("\n" + "=" * 60)
    print("  CollBar — Phase 2 Acceptance Summary")
    print("=" * 60)

    # Table row counts
    print(f"\n{'Table':<30} {'Rows':>10}")
    print("-" * 42)
    for table in TABLES:
        n = count_rows(cur, table)
        marker = "" if n >= 0 else " (error)"
        print(f"  {table:<28} {n:>10,}{marker}")

    # CBA document breakdown
    docs_found = state.get("cba_docs_found", 0)
    # cba_docs_in_scope = min(max_pdfs, docs_found) when --max-pdfs was set;
    # equals docs_found for unbounded runs.  Use this as the denominator for
    # completeness so bounded/dev runs are not penalised for not downloading
    # the full 10k-doc catalog.
    docs_in_scope = state.get("cba_docs_in_scope", docs_found)
    docs_downloaded = state.get("cba_docs_downloaded", 0)
    docs_skipped = state.get("cba_docs_skipped", 0)
    docs_failed = state.get("cba_docs_failed", 0)
    docs_processed = docs_downloaded + docs_skipped + docs_failed

    print("\n--- CBA Document Crawl ---")
    print(f"  school-sector docs found   : {docs_found:>8,}")
    print(f"  docs in scope (this run)   : {docs_in_scope:>8,}")
    print(f"  PDFs downloaded            : {docs_downloaded:>8,}")
    print(f"  PDFs skipped (cached)      : {docs_skipped:>8,}")
    print(f"  PDFs failed                : {docs_failed:>8,}")
    if docs_in_scope > 0:
        completeness_pct = (docs_processed / docs_in_scope) * 100
        print(f"  corpus completeness        : {completeness_pct:>7.1f}%  (threshold {CORPUS_COMPLETENESS_THRESHOLD:.0f}%)")
    else:
        completeness_pct = 0.0
        print(f"  corpus completeness        :      n/a")

    # District match rate
    matched = state.get("cba_district_matched", 0)
    unmatched = state.get("cba_district_unmatched", 0)
    total_attempted = matched + unmatched
    if total_attempted > 0:
        match_rate = (matched / total_attempted) * 100
    else:
        # Derive from source_documents if we have CBA PDFs
        cur.execute(
            "SELECT COUNT(*), COUNT(district_id) FROM source_documents WHERE doc_type = 'cba_pdf'"
        )
        row = cur.fetchone()
        if row and row[0] > 0:
            match_rate = (row[1] / row[0]) * 100
            total_attempted = row[0]
            matched = row[1]
            unmatched = row[0] - row[1]
        else:
            match_rate = 0.0

    print(f"\n--- District Match Rate (school CBAs) ---")
    print(f"  auto-matched               : {matched:>8,}")
    print(f"  unmatched / review         : {unmatched:>8,}")
    print(f"  match rate                 : {match_rate:>8.1f}%")
    print(f"  threshold                  : {MATCH_RATE_THRESHOLD:>8.1f}%")

    # Other scrapers
    print("\n--- Other Scraper Stats ---")
    print(f"  FF proposals loaded        : {state.get('ff_proposals_loaded', 0):>8,}")
    print(f"  FF page accessible         : {'yes' if state.get('ff_page_accessible') else 'no (JS-only)'}")
    print(f"  Wage settlement downloaded : {state.get('wage_settlement_downloaded', 0):>8,}")
    wsr_failed = state.get('wage_settlement_failed_urls', [])
    if wsr_failed:
        print(f"  Wage settlement missing    : {', '.join(wsr_failed)}")

    cur.close()
    conn.close()

    print("\n" + "=" * 60)

    failures = []

    # Gate 1 — district match rate
    if total_attempted > 0 and match_rate < MATCH_RATE_THRESHOLD:
        failures.append(
            f"Match rate {match_rate:.1f}% is below {MATCH_RATE_THRESHOLD}% threshold. "
            "Run 02_scrape_serb_cba.py and check manual_review CSV."
        )

    # Gate 2 — corpus completeness (skipped when --skip-completeness is set)
    if not args.skip_completeness and docs_in_scope > 0:
        if completeness_pct < CORPUS_COMPLETENESS_THRESHOLD:
            failures.append(
                f"Corpus completeness {completeness_pct:.1f}% is below "
                f"{CORPUS_COMPLETENESS_THRESHOLD}% threshold "
                f"({docs_processed:,} of {docs_found:,} docs processed). "
                "Re-run 02_scrape_serb_cba.py without --max-pdfs, "
                "or pass --skip-completeness for intentional partial runs."
            )

    if failures:
        for msg in failures:
            print(f"\n  FAIL: {msg}")
        print("=" * 60 + "\n")
        return 1
    elif total_attempted == 0:
        print("\n  NOTE: No CBA PDFs downloaded yet — run 02_scrape_serb_cba.py first.")
        print("=" * 60 + "\n")
        return 0
    else:
        print(f"\n  PASS: Match rate {match_rate:.1f}% meets threshold.")
        if not args.skip_completeness and docs_found > 0:
            print(f"  PASS: Corpus completeness {completeness_pct:.1f}% meets threshold.")
        elif args.skip_completeness:
            print("  NOTE: Corpus-completeness gate skipped (--skip-completeness).")
        print("=" * 60 + "\n")
        return 0


if __name__ == "__main__":
    sys.exit(main())
