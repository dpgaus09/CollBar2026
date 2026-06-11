#!/usr/bin/env python3
"""
SERB Collective Bargaining Agreement scraper.

Fetches the SERB CBA catalog page (which embeds all document records as JSON),
filters for school-sector (T/NT bargaining units), downloads PDFs,
uploads to object storage, and fuzzy-matches employers to districts.

Usage: python3 pipeline/02_scrape_serb_cba.py [--max-pdfs N] [--years-back N]
"""
import csv
import html
import re
import sys
import time
import logging
import argparse
from io import StringIO
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
CBA_CACHE = common.DATA_DIR / "serb_cba_raw.html"
CBA_PDF_DIR = common.DATA_DIR / "cba"

# School-sector bargaining unit codes
SCHOOL_BU_CODES = {"T", "NT"}

# Employer name normalisation lives in common.py (normalise_employer, match_employer,
# build_district_index) so that both the CBA and FF scrapers share the same logic.

ROW_RE = re.compile(
    r'\["([^"]+)","View","(https://serb\.ohio\.gov/static/PDF/Contracts/[^"]+\.pdf)"'
    r',"([^"]*)","([^"]*)","([^"]*)","([^"]*)"'
    r',"([^"]*)","([^"]*)","([^"]*)","(\d*)"'
    r',"([^"]*)","([^"]*)","([^"]*)","([^"]*)"\]'
)


def fetch_cba_page(session: requests.Session) -> str:
    if CBA_CACHE.exists():
        log.info("Using cached CBA page: %s", CBA_CACHE)
        # Warm up session cookies using a lightweight SERB page
        try:
            r0 = session.get("https://serb.ohio.gov/", headers=common.HEADERS, timeout=15, allow_redirects=True)
            log.info("Session warm-up (homepage): HTTP %s, %d cookies", r0.status_code, len(session.cookies))
        except Exception as e:
            log.warning("Session warm-up failed (will try without cookies): %s", e)
        with open(CBA_CACHE, encoding="utf-8") as f:
            return f.read()
    log.info("Fetching CBA catalog page (this is large, ~10MB)…")
    r = common.polite_get(session, CBA_CATALOG_URL)
    if not r or r.status_code != 200:
        raise RuntimeError(f"Failed to fetch CBA catalog: HTTP {r.status_code if r else 'None'}")
    CBA_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with open(CBA_CACHE, "w", encoding="utf-8") as f:
        f.write(r.text)
    log.info("Saved CBA page (%d bytes)", len(r.text))
    return r.text


def parse_cba_records(raw_html: str) -> list[dict]:
    """Extract all CBA rows from the embedded JSON in the page."""
    decoded = html.unescape(raw_html)
    records = []
    for m in ROW_RE.finditer(decoded):
        records.append({
            "case_number": m.group(1),
            "url": m.group(2),
            "addendum1": m.group(3),
            "addendum2": m.group(4),
            "addendum3": m.group(5),
            "addendum4": m.group(6),
            "employer": m.group(7),
            "county": m.group(8),
            "bargaining_unit": m.group(9),
            "unit_size": m.group(10),
            "union": m.group(11),
            "start_date": m.group(12) or None,
            "end_date": m.group(13) or None,
            "group": m.group(14),
        })
    return records


def school_year_from_dates(start_date: str | None, end_date: str | None) -> str | None:
    """Derive a school year string like '2024-25' from contract start/end dates."""
    if start_date:
        try:
            year = int(start_date[:4])
            return f"{year}-{str(year + 1)[2:]}"
        except (ValueError, IndexError):
            pass
    return None




def download_pdf(session: requests.Session, url: str, dest: Path) -> bytes | None:
    """Download a PDF using PDF_HEADERS (with Referer); returns bytes or None on failure."""
    try:
        r = common.polite_get(session, url, headers=common.PDF_HEADERS, timeout=120)
        if not r or r.status_code != 200:
            log.warning("HTTP %s for %s", r.status_code if r else "None", url)
            return None
        ct = r.headers.get("Content-Type", "")
        if "html" in ct.lower():
            log.warning("Got HTML instead of PDF for %s", url)
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
        return r.content
    except Exception as e:
        log.warning("Download error for %s: %s", url, e)
        return None


def upsert_source_document(cur, district_id, doc_type, source_url, file_hash, storage_key, school_year):
    """Insert source_documents row, return id."""
    cur.execute(
        """
        INSERT INTO source_documents (district_id, doc_type, source_url, file_hash, storage_key, school_year)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (source_url, file_hash) DO UPDATE SET
            district_id  = COALESCE(EXCLUDED.district_id, source_documents.district_id),
            storage_key  = COALESCE(EXCLUDED.storage_key, source_documents.storage_key),
            school_year  = COALESCE(EXCLUDED.school_year, source_documents.school_year)
        RETURNING id
        """,
        (district_id, doc_type, source_url, file_hash, storage_key, school_year),
    )
    row = cur.fetchone()
    return row[0] if row else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-pdfs", type=int, default=0,
                        help="Max PDFs to download per run (0 = unlimited)")
    parser.add_argument("--years-back", type=int, default=0,
                        help="Only download CBAs from the last N years (0 = all time, default)")
    args = parser.parse_args()

    CBA_PDF_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    state = common.load_crawl_state()

    # 1 — Fetch / use cached CBA catalog page
    raw_html = fetch_cba_page(session)

    # 2 — Parse all CBA records
    all_records = parse_cba_records(raw_html)
    log.info("Total CBA records parsed: %d", len(all_records))

    # 3 — Filter for school sector
    school_records = [r for r in all_records if r["bargaining_unit"] in SCHOOL_BU_CODES]
    log.info("School-sector records (T/NT): %d", len(school_records))
    state["cba_docs_found"] = len(school_records)
    # cba_docs_in_scope tracks the actual universe for this run:
    # limited to max_pdfs (if set) so the completeness gate compares
    # processed vs intended, not processed vs the full 10k catalog.
    docs_in_scope = min(args.max_pdfs, len(school_records)) if args.max_pdfs else len(school_records)
    state["cba_docs_in_scope"] = docs_in_scope

    # 4 — Year filter: last N years (0 = all time)
    import datetime
    if args.years_back > 0:
        cutoff_year = datetime.date.today().year - args.years_back
        def in_range(rec):
            try:
                year = int(rec["start_date"][:4]) if rec["start_date"] else 0
                return year >= cutoff_year
            except (ValueError, TypeError):
                return False
        recent_records = [r for r in school_records if in_range(r)]
        log.info("Records in last %d years: %d", args.years_back, len(recent_records))
    else:
        recent_records = school_records
        log.info("Records (all time, no year filter): %d", len(recent_records))

    # 5 — Build district index for matching
    conn = common.get_db_conn()
    dist_index = common.build_district_index(conn)
    log.info("Districts in index: %d", len(dist_index))

    # Crawl-state tracking
    downloaded_urls: dict = state.get("downloaded_urls", {})
    manual_review_rows: list = state.get("manual_review", [])
    unmatched_employers: list = state.get("unmatched_employers", [])

    downloaded_count = 0
    skipped_count = 0
    failed_count = 0
    matched_count = 0
    unmatched_count = 0

    cur = conn.cursor()

    for rec in recent_records:
        url = rec["url"]
        employer = rec["employer"]
        case_num = rec["case_number"]

        if args.max_pdfs and downloaded_count >= args.max_pdfs:
            log.info("Reached max-pdfs limit (%d)", args.max_pdfs)
            break

        # Skip already-successfully-downloaded; retry previously-failed URLs
        if downloaded_urls.get(url, {}).get("status") == "ok":
            skipped_count += 1
            continue

        # Match employer → district
        district_id, match_status, matched_name = common.match_employer(employer, dist_index)

        if match_status == "auto":
            matched_count += 1
        elif match_status == "review":
            unmatched_count += 1
            if {"employer": employer, "matched": matched_name} not in manual_review_rows:
                manual_review_rows.append({
                    "employer": employer,
                    "case_number": case_num,
                    "best_match": matched_name,
                    "status": "review_needed",
                })
        else:
            unmatched_count += 1
            if employer not in unmatched_employers:
                unmatched_employers.append(employer)

        # Download PDF
        fname = url.split("/")[-1]
        dest = CBA_PDF_DIR / fname
        if dest.exists():
            pdf_bytes = dest.read_bytes()
        else:
            pdf_bytes = download_pdf(session, url, dest)

        if not pdf_bytes:
            failed_count += 1
            downloaded_urls[url] = {"status": "failed", "case_number": case_num}
            continue

        file_hash = common.sha256_bytes(pdf_bytes)
        storage_key = f"oh/cba/{file_hash}.pdf"

        # Upload to object storage
        actual_key = common.upload_to_object_storage(dest, storage_key)

        # Insert into source_documents
        school_year = school_year_from_dates(rec["start_date"], rec["end_date"])
        try:
            doc_id = upsert_source_document(
                cur, district_id, "cba_pdf", url, file_hash, actual_key, school_year
            )
            conn.commit()
        except Exception as e:
            conn.rollback()
            log.warning("DB insert failed for %s: %s", case_num, e)
            failed_count += 1
            continue

        downloaded_urls[url] = {
            "status": "ok",
            "case_number": case_num,
            "employer": employer,
            "district_id": district_id,
            "match_status": match_status,
            "doc_id": str(doc_id),
        }
        downloaded_count += 1

    cur.close()
    conn.close()

    # Write unmatched CSV
    csv_path = common.DATA_DIR / "unmatched_employers.csv"
    if manual_review_rows:
        with open(csv_path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["employer", "case_number", "best_match", "status"])
            w.writeheader()
            w.writerows(manual_review_rows)
        log.info("Manual review CSV: %s (%d rows)", csv_path, len(manual_review_rows))

    # Update state
    state.update({
        "cba_docs_downloaded": downloaded_count,
        "cba_docs_skipped": skipped_count,
        "cba_docs_failed": failed_count,
        "cba_district_matched": matched_count,
        "cba_district_unmatched": unmatched_count,
        "downloaded_urls": downloaded_urls,
        "manual_review": manual_review_rows,
        "unmatched_employers": unmatched_employers[:200],  # cap list size
    })
    common.save_crawl_state(state)

    total_attempted = downloaded_count + failed_count
    match_rate = (matched_count / max(1, matched_count + unmatched_count)) * 100
    log.info(
        "Done — downloaded: %d, skipped: %d, failed: %d | "
        "matched: %d, unmatched: %d (%.1f%%)",
        downloaded_count, skipped_count, failed_count,
        matched_count, unmatched_count, match_rate,
    )


if __name__ == "__main__":
    main()
