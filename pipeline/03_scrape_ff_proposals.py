#!/usr/bin/env python3
"""
SERB Fact-Finding Report scraper.

Fetches the SERB FF Reports catalog page which embeds all document records as
HTML-entity-encoded JSON in a hidden div (#js-placeholder-json-data), identical
in structure to the CBA catalog page. Filters for school-sector BU codes (T, NT),
downloads PDFs, and inserts rows into factfinding_proposals + source_documents.

Column order in FF JSON data:
  0: Case Number  1: "View"  2: URL  3: Page Number  4: Bargaining Unit
  5: Employer Name  6: Union/Local  7: Neutral  8: Date Issued  9: Group

Usage: python3 pipeline/03_scrape_ff_proposals.py [--max-pdfs N]
"""
import re
import sys
import json
import html as html_module
import logging
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

import requests

common.setup_logging()
log = logging.getLogger(__name__)

FF_CATALOG_URL = (
    "https://serb.ohio.gov/wps/portal/gov/serb/view-document-archive/fact-finding-reports"
)
FF_STATS_PDF_URL = (
    "https://serb.ohio.gov/static/PDF/FF_Statistics/Fact-Finding_Statistics.pdf"
)

FF_CACHE = common.DATA_DIR / "serb_ff_raw.html"
FF_PDF_DIR = common.DATA_DIR / "ff_reports"

SCHOOL_BU_CODES = {"T", "NT"}

# JSON data is embedded inside a hidden div, HTML-entity-encoded
JSON_DIV_RE = re.compile(
    r'<div[^>]+id=["\']js-placeholder-json-data["\'][^>]*>(.*?)</div>',
    re.DOTALL | re.IGNORECASE,
)


def fetch_ff_page(session: requests.Session) -> str:
    """Fetch/use cached FF catalog page."""
    if FF_CACHE.exists():
        log.info("Using cached FF page: %s", FF_CACHE)
        try:
            r0 = session.get("https://serb.ohio.gov/", headers=common.HEADERS, timeout=15, allow_redirects=True)
            log.info("Session warm-up (homepage): HTTP %s", r0.status_code)
        except Exception as e:
            log.warning("Session warm-up failed: %s", e)
        with open(FF_CACHE, encoding="utf-8") as f:
            return f.read()
    log.info("Fetching FF catalog page…")
    r = common.polite_get(session, FF_CATALOG_URL)
    if not r or r.status_code != 200:
        raise RuntimeError(f"Failed to fetch FF catalog: HTTP {r.status_code if r else 'None'}")
    FF_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with open(FF_CACHE, "w", encoding="utf-8") as f:
        f.write(r.text)
    log.info("Saved FF page (%d bytes)", len(r.text))
    return r.text


def parse_ff_records(raw_html: str) -> list[dict]:
    """Extract all FF report rows from the embedded JSON div."""
    m = JSON_DIV_RE.search(raw_html)
    if not m:
        log.warning("Could not find js-placeholder-json-data div in FF page")
        return []
    decoded = html_module.unescape(m.group(1).strip())
    try:
        data = json.loads(decoded)
    except json.JSONDecodeError as e:
        log.warning("JSON decode failed for FF data: %s", e)
        return []

    rows = data.get("data", [])
    if len(rows) < 2:
        return []

    # Row 0: column types, Row 1: column names, Rows 2+: data
    header = rows[1]
    log.info("FF data header: %s", header)
    records = []
    for row in rows[2:]:
        if not isinstance(row, list) or len(row) < 9:
            continue
        records.append({
            "case_number": str(row[0]).strip(),
            "url": str(row[2]).strip(),
            "page_number": str(row[3]).strip(),
            "bargaining_unit": str(row[4]).strip(),
            "employer": str(row[5]).strip(),
            "union": str(row[6]).strip(),
            "neutral": str(row[7]).strip(),
            "date_issued": str(row[8]).strip() or None,
            "group": str(row[9]).strip() if len(row) > 9 else "",
        })
    return records


def download_ff_pdf(session: requests.Session, url: str, dest: Path) -> bytes | None:
    """Download an FF report PDF with appropriate headers."""
    if dest.exists():
        return dest.read_bytes()
    try:
        headers = {**common.PDF_HEADERS,
                   "Referer": FF_CATALOG_URL}
        r = common.polite_get(session, url, headers=headers, timeout=120)
        if not r or r.status_code != 200:
            log.warning("HTTP %s for %s", r.status_code if r else "None", url)
            return None
        if "html" in r.headers.get("Content-Type", "").lower():
            log.warning("Got HTML instead of PDF for %s", url)
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
        return r.content
    except Exception as e:
        log.warning("Download error for %s: %s", url, e)
        return None


def upsert_source_doc(cur, district_id, source_url, file_hash, storage_key):
    cur.execute(
        """
        INSERT INTO source_documents (district_id, doc_type, source_url, file_hash, storage_key)
        VALUES (%s, 'factfinding_report', %s, %s, %s)
        ON CONFLICT (source_url, file_hash) DO UPDATE SET
            district_id = COALESCE(EXCLUDED.district_id, source_documents.district_id)
        RETURNING id
        """,
        (district_id, source_url, file_hash, storage_key),
    )
    row = cur.fetchone()
    return row[0] if row else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-pdfs", type=int, default=0,
                        help="Max FF PDFs to download (0 = unlimited)")
    args = parser.parse_args()

    FF_PDF_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    state = common.load_crawl_state()

    raw_html = fetch_ff_page(session)
    state["ff_page_accessible"] = True

    all_records = parse_ff_records(raw_html)
    log.info("FF records total: %d", len(all_records))

    school_records = [r for r in all_records if r["bargaining_unit"] in SCHOOL_BU_CODES]
    log.info("School-sector FF records (T/NT): %d", len(school_records))

    proposals_loaded = 0

    if school_records:
        conn = common.get_db_conn()
        dist_index = common.build_district_index(conn)
        log.info("Districts in index: %d", len(dist_index))
        cur = conn.cursor()
        pdf_count = 0

        for rec in school_records:
            if args.max_pdfs and pdf_count >= args.max_pdfs:
                log.info("Reached max-pdfs limit (%d)", args.max_pdfs)
                break

            url = rec["url"]
            if not url.startswith("http"):
                continue

            # Match employer → district
            district_id, match_status, _matched = common.match_employer(
                rec["employer"], dist_index
            )

            fname = url.split("/")[-1]
            dest = FF_PDF_DIR / fname
            pdf_bytes = download_ff_pdf(session, url, dest)
            pdf_count += 1

            if not pdf_bytes:
                continue

            file_hash = common.sha256_bytes(pdf_bytes)
            storage_key = common.upload_to_object_storage(dest, f"oh/ff/{file_hash}.pdf")
            doc_id = upsert_source_doc(cur, district_id, url, file_hash, storage_key)

            # Derive year_covered from date_issued (year of the FF report)
            year_covered = None
            if rec["date_issued"]:
                try:
                    year_covered = rec["date_issued"][:4] + "-" + str(int(rec["date_issued"][:4]) + 1)[2:]
                except (ValueError, IndexError):
                    pass

            try:
                cur.execute(
                    """
                    INSERT INTO factfinding_proposals
                        (district_id, case_number, report_date, union_name,
                         year_covered, source_doc_id)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        district_id,
                        rec["case_number"],
                        rec["date_issued"] or None,
                        rec["union"][:500] if rec["union"] else None,
                        year_covered,
                        doc_id,
                    ),
                )
                proposals_loaded += 1
            except Exception as e:
                log.warning("FF proposal insert failed for %s: %s", rec["case_number"], e)
                conn.rollback()
                continue

        conn.commit()
        cur.close()
        conn.close()
    else:
        log.warning("No school-sector (T/NT) FF records found — BU codes in page may differ from T/NT")

    # Download aggregate statistics PDF (no DB insert needed)
    try:
        r = session.get(FF_STATS_PDF_URL, headers=common.PDF_HEADERS, timeout=30)
        if r.status_code == 200 and r.content[:4] == b"%PDF":
            dest = common.DATA_DIR / "ff_statistics.pdf"
            dest.write_bytes(r.content)
            log.info("Downloaded FF stats PDF (%d bytes)", len(r.content))
    except Exception as e:
        log.warning("FF stats PDF download failed: %s", e)

    state["ff_proposals_loaded"] = proposals_loaded
    common.save_crawl_state(state)
    log.info("Fact-finding proposals loaded: %d", proposals_loaded)


if __name__ == "__main__":
    main()
