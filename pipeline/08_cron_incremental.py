#!/usr/bin/env python3
"""
Nightly incremental SERB scraper — Phase 5 cron job.

Fetches the SERB CBA catalog and detects new documents not already in
source_documents. Writes an alert row for each new document found.
Does NOT download PDFs — alerts surface in the admin UI so an operator
can trigger a full scrape when needed.

Usage:
    python3 pipeline/08_cron_incremental.py [--dry-run]

Cron example (run at 3am daily):
    0 3 * * * /usr/bin/python3 /home/runner/workspace/pipeline/08_cron_incremental.py >> /var/log/collbar_cron.log 2>&1
"""
import argparse
import html
import logging
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

import requests

common.setup_logging()
log = logging.getLogger(__name__)

CBA_CATALOG_URL = (
    "https://serb.ohio.gov/wps/portal/gov/serb/view-document-archive"
    "/collective-bargaining-agreements"
)

SCHOOL_BU_CODES = {"T", "NT"}

ROW_RE = re.compile(
    r'\["([^"]+)","View","(https://serb\.ohio\.gov/static/PDF/Contracts/[^"]+\.pdf)"'
    r',"([^"]*)","([^"]*)","([^"]*)","([^"]*)"'
    r',"([^"]*)","([^"]*)","([^"]*)","(\d*)"'
    r',"([^"]*)","([^"]*)","([^"]*)","([^"]*)"\]'
)


def parse_cba_records(raw_html: str) -> list:
    """Extract school-sector CBA rows from the embedded JSON in the SERB page."""
    decoded = html.unescape(raw_html)
    records = []
    for m in ROW_RE.finditer(decoded):
        bu_code = m.group(8).strip().upper()
        if bu_code not in SCHOOL_BU_CODES:
            continue
        records.append({
            "case_number": m.group(1).strip(),
            "url": m.group(2).strip(),
            "employer": m.group(4).strip(),
            "union": m.group(5).strip(),
            "bu_code": bu_code,
            "effective_start": m.group(9).strip(),
            "effective_end": m.group(10).strip(),
        })
    return records


def get_known_urls(conn) -> set:
    """Return all source_urls already in source_documents for cba_pdf doc type."""
    cur = conn.cursor()
    cur.execute("SELECT source_url FROM source_documents WHERE doc_type = 'cba_pdf'")
    rows = cur.fetchall()
    cur.close()
    return {r[0] for r in rows}


def alert_already_pending(cur, source_url: str, alert_type: str) -> bool:
    """Return True if a pending alert already exists for this (url, type) pair."""
    cur.execute(
        "SELECT id FROM alerts WHERE source_url = %s AND alert_type = %s AND status = 'pending'",
        (source_url, alert_type),
    )
    return cur.fetchone() is not None


def insert_alert(cur, district_id, doc_name: str, source_url: str,
                 alert_type: str = "new_doc"):
    """Insert an alert row if no pending alert already exists for this URL."""
    if alert_already_pending(cur, source_url, alert_type):
        return False
    cur.execute(
        """
        INSERT INTO alerts
            (district_id, alert_type, doc_name, source_url, detected_at, status)
        VALUES (%s, %s, %s, %s, NOW(), 'pending')
        """,
        (district_id, alert_type, doc_name, source_url),
    )
    return True


def main():
    parser = argparse.ArgumentParser(description="Nightly incremental SERB scraper")
    parser.add_argument("--dry-run", action="store_true",
                        help="Do not write to database")
    args = parser.parse_args()

    log.info("=== CollBar nightly incremental scraper ===")
    log.info("Mode: %s", "DRY RUN" if args.dry_run else "LIVE")

    session = requests.Session()

    log.info("Fetching SERB CBA catalog (fresh, bypassing cache)…")
    try:
        r = session.get(
            CBA_CATALOG_URL,
            headers=common.HEADERS,
            timeout=90,
            allow_redirects=True,
        )
        if r.status_code != 200:
            log.error("Failed to fetch catalog: HTTP %s", r.status_code)
            sys.exit(1)
        time.sleep(common.POLITE_DELAY)
    except Exception as e:
        log.error("Request error fetching catalog: %s", e)
        sys.exit(1)

    records = parse_cba_records(r.text)
    log.info("Found %d school-sector CBA records in catalog", len(records))

    if not records:
        log.warning("No records parsed — check ROW_RE pattern or SERB page structure")
        sys.exit(0)

    conn = common.get_db_conn()
    known_urls = get_known_urls(conn)
    log.info("Found %d known CBA URLs in database", len(known_urls))

    dist_index = common.build_district_index(conn)

    new_docs = [rec for rec in records if rec["url"] not in known_urls]
    log.info("New documents detected: %d", len(new_docs))

    inserted = 0
    skipped_dupes = 0

    if new_docs and not args.dry_run:
        cur = conn.cursor()
        for doc in new_docs:
            employer = doc.get("employer", "")
            district_id = None
            if employer:
                district_id, status, _ = common.match_employer(employer, dist_index)
                if status != "auto":
                    district_id = None

            eff_start = doc.get("effective_start", "")
            eff_end = doc.get("effective_end", "")
            union = doc.get("union", "")
            doc_name = (
                f"{employer or 'Unknown'} — {union}"
                f" ({eff_start}–{eff_end})"
            ).strip(" —")

            ok = insert_alert(cur, district_id, doc_name, doc["url"], "new_doc")
            if ok:
                inserted += 1
                log.info("Alert inserted: %s", doc_name)
            else:
                skipped_dupes += 1

        conn.commit()
        cur.close()
        log.info("Inserted %d new alerts (%d skipped — already pending)", inserted, skipped_dupes)

    elif new_docs and args.dry_run:
        log.info("[DRY RUN] Would insert up to %d alerts:", len(new_docs))
        for doc in new_docs[:10]:
            log.info("  - %s: %s", doc.get("employer", "?"), doc["url"])
        if len(new_docs) > 10:
            log.info("  … and %d more", len(new_docs) - 10)
        inserted = len(new_docs)

    conn.close()

    print()
    print("=" * 60)
    print("  CollBar Nightly Incremental Scraper")
    print("=" * 60)
    print(f"  Catalog records found   : {len(records):>8,}")
    print(f"  Known URLs in DB        : {len(known_urls):>8,}")
    print(f"  New documents detected  : {len(new_docs):>8,}")
    if not args.dry_run:
        print(f"  Alerts inserted         : {inserted:>8,}")
        print(f"  Alerts skipped (dupe)   : {skipped_dupes:>8,}")
    else:
        print("  [DRY RUN — no DB writes]")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
