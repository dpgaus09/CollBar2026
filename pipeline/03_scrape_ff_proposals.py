#!/usr/bin/env python3
"""
SERB Fact-Finding Wage Proposals scraper.

Attempts to fetch the SERB fact-finding catalog page and extract wage proposal data
into the factfinding_proposals table. Also downloads individual FF report PDFs.

The FF catalog page requires JavaScript to render its document list. This script
tries the server-side HTML first; if only a static summary PDF is available, it
parses that instead.

Usage: python3 pipeline/03_scrape_ff_proposals.py
"""
import re
import sys
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

import requests

common.setup_logging()
log = logging.getLogger(__name__)

FF_CATALOG_URL = (
    "https://serb.ohio.gov/wps/portal/gov/serb/view-document-archive/fact-finding-reports"
)
FF_WAGE_URL = (
    "https://serb.ohio.gov/wps/portal/gov/serb/view-document-archive/ff-wage-proposals"
)
FF_STATS_PDF_URL = (
    "https://serb.ohio.gov/static/PDF/FF_Statistics/Fact-Finding_Statistics.pdf"
)

FF_CACHE = common.DATA_DIR / "serb_ff_raw.html"
FF_PDF_DIR = common.DATA_DIR / "ff_reports"

# Same row pattern as CBA page — FF may embed data the same way
FF_ROW_RE = re.compile(
    r'\["([^"]+)","View","(https://serb\.ohio\.gov/static/PDF/[^"]+\.pdf)"'
    r'(?:,"[^"]*"){4},'
    r'"([^"]*)"'  # employer
    r',"([^"]*)"'  # county
    r',"([^"]*)"'  # BU
    r',"(\d*)"'    # unit size
    r',"([^"]*)"'  # union
    r',"([^"]*)"'  # start date
    r',"([^"]*)"'  # end date
    r',"([^"]*)"\]'  # group
)


def try_fetch_ff_page(session: requests.Session) -> tuple[str | None, str]:
    """Try to fetch the FF catalog page. Returns (html, url_tried)."""
    urls_to_try = [FF_CATALOG_URL, FF_WAGE_URL]
    for url in urls_to_try:
        try:
            r = common.polite_get(session, url)
            if r and r.status_code == 200 and len(r.text) > 10000:
                log.info("FF catalog page loaded: %s (%d bytes)", url, len(r.text))
                return r.text, url
            else:
                log.info("FF catalog not accessible at %s (status=%s, size=%d)",
                         url, r.status_code if r else "None",
                         len(r.text) if r else 0)
        except Exception as e:
            log.warning("Error fetching %s: %s", url, e)
    return None, ""


def try_download_stats_pdf(session: requests.Session) -> bytes | None:
    """Try to download the fact-finding statistics aggregate PDF."""
    try:
        r = common.polite_get(session, FF_STATS_PDF_URL)
        if r and r.status_code == 200 and r.content[:4] == b"%PDF":
            dest = common.DATA_DIR / "ff_statistics.pdf"
            dest.write_bytes(r.content)
            log.info("Downloaded FF stats PDF (%d bytes)", len(r.content))
            return r.content
        else:
            log.info("FF stats PDF not available as real PDF (status=%s, content-type=%s)",
                     r.status_code if r else "None",
                     r.headers.get("Content-Type", "") if r else "")
            return None
    except Exception as e:
        log.warning("Error fetching FF stats PDF: %s", e)
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
    FF_PDF_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    state = common.load_crawl_state()

    # Try to fetch the FF catalog page
    ff_html, ff_url = try_fetch_ff_page(session)
    state["ff_page_accessible"] = ff_html is not None

    proposals_loaded = 0

    if ff_html:
        import html as html_module
        decoded = html_module.unescape(ff_html)
        matches = list(FF_ROW_RE.finditer(decoded))
        log.info("FF page rows parsed: %d", len(matches))

        if matches:
            conn = common.get_db_conn()
            cur = conn.cursor()

            for m in matches:
                case_num = m.group(1)
                url = m.group(2)
                employer = m.group(3)
                report_date = m.group(8) or None

                # Download PDF
                fname = url.split("/")[-1]
                dest = FF_PDF_DIR / fname
                pdf_bytes = None
                if not dest.exists():
                    r = common.polite_get(session, url)
                    if r and r.status_code == 200:
                        dest.write_bytes(r.content)
                        pdf_bytes = r.content
                else:
                    pdf_bytes = dest.read_bytes()

                if not pdf_bytes:
                    continue

                file_hash = common.sha256_bytes(pdf_bytes)
                storage_key = common.upload_to_object_storage(dest, f"oh/ff/{file_hash}.pdf")
                doc_id = upsert_source_doc(cur, None, url, file_hash, storage_key)

                # Insert into factfinding_proposals
                try:
                    cur.execute(
                        """
                        INSERT INTO factfinding_proposals
                            (case_number, report_date, source_doc_id)
                        VALUES (%s, %s, %s)
                        ON CONFLICT DO NOTHING
                        """,
                        (case_num, report_date, doc_id),
                    )
                    proposals_loaded += 1
                except Exception as e:
                    log.warning("FF proposal insert failed: %s", e)
                    conn.rollback()
                    continue

            conn.commit()
            cur.close()
            conn.close()
    else:
        log.warning(
            "FF catalog pages not accessible via server-side HTML. "
            "The SERB fact-finding archive requires JavaScript execution (Playwright) "
            "to render its document list. Install Playwright system deps to enable this step."
        )

    # Try the aggregate statistics PDF regardless
    try_download_stats_pdf(session)

    state["ff_proposals_loaded"] = proposals_loaded
    common.save_crawl_state(state)
    log.info("Fact-finding proposals loaded: %d", proposals_loaded)


if __name__ == "__main__":
    main()
