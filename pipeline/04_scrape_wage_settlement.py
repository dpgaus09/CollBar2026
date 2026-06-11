#!/usr/bin/env python3
"""
SERB Wage Settlement Report downloader.

Tries multiple URL patterns for each year 2020–2025 and, when successful,
parses the PDF summary tables into the benchmarks staging table using pdfplumber.

The SERB static PDF paths tested in reconnaissance all returned 404. This script
tries systematically and logs all results to the crawl state. When a PDF is
successfully downloaded, pdfplumber is used to extract wage settlement tables.

Usage: python3 pipeline/04_scrape_wage_settlement.py
"""
import re
import sys
import logging
import itertools
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

import requests

common.setup_logging()
log = logging.getLogger(__name__)

YEARS = list(range(2020, 2026))

# All known URL patterns to try (replace {YEAR} and {YY})
URL_PATTERNS = [
    "https://serb.ohio.gov/static/PDF/Wage_Settlement/Wage_Settlement_{YEAR}.pdf",
    "https://serb.ohio.gov/static/PDF/Wage_Settlement/{YEAR}_Wage_Settlement.pdf",
    "https://serb.ohio.gov/static/PDF/Wage_Settlement/Wage_Settlement_Report_{YEAR}.pdf",
    "https://serb.ohio.gov/static/PDF/Wage_Settlement_Reports/Wage_Settlement_{YEAR}.pdf",
    "https://serb.ohio.gov/static/PDF/WSR/Wage_Settlement_{YEAR}.pdf",
    "https://serb.ohio.gov/static/PDF/Wage/{YEAR}_Wage_Settlement_Report.pdf",
]

WSR_DIR = common.DATA_DIR / "wage_settlement"


def try_download_year(session: requests.Session, year: int) -> tuple[bytes | None, str]:
    """Try all URL patterns for a given year. Returns (bytes, url) or (None, '')."""
    yy = str(year)[2:]
    for pattern in URL_PATTERNS:
        url = pattern.replace("{YEAR}", str(year)).replace("{YY}", yy)
        try:
            r = common.polite_get(session, url)
            if not r or r.status_code != 200:
                continue
            # Must be a real PDF
            if r.content[:4] == b"%PDF" or r.headers.get("Content-Type", "").startswith("application/pdf"):
                log.info("Found wage settlement PDF for %d: %s (%d bytes)", year, url, len(r.content))
                return r.content, url
            else:
                log.debug("Got non-PDF response for %s", url)
        except Exception as e:
            log.debug("Error fetching %s: %s", url, e)
    return None, ""


def parse_wage_tables(pdf_path: Path, source_url: str, conn) -> int:
    """
    Parse a wage settlement PDF with pdfplumber and insert rows into benchmarks.
    Returns number of rows inserted.
    """
    try:
        import pdfplumber
    except ImportError:
        log.warning("pdfplumber not available; skipping PDF parse")
        return 0

    inserted = 0
    try:
        with pdfplumber.open(pdf_path) as pdf:
            cur = conn.cursor()
            for page in pdf.pages:
                tables = page.extract_tables()
                for table in tables:
                    if not table or len(table) < 2:
                        continue
                    # Look for tables with year, district, wage data columns
                    header = [str(c).strip().lower() if c else "" for c in table[0]]
                    if not any(k in " ".join(header) for k in ["district", "employer", "wage", "settle"]):
                        continue
                    for row in table[1:]:
                        if not row or not any(row):
                            continue
                        raw_text = " | ".join(str(c) for c in row if c)
                        try:
                            cur.execute(
                                """
                                INSERT INTO benchmarks (source_url, raw_text)
                                VALUES (%s, %s)
                                ON CONFLICT DO NOTHING
                                """,
                                (source_url, raw_text[:2000]),
                            )
                            inserted += 1
                        except Exception as e:
                            log.debug("benchmarks insert error: %s", e)
                            conn.rollback()
            conn.commit()
            cur.close()
    except Exception as e:
        log.warning("pdfplumber parse error for %s: %s", pdf_path, e)
    return inserted


def main():
    WSR_DIR.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    state = common.load_crawl_state()
    conn = common.get_db_conn()
    cur = conn.cursor()

    downloaded = 0
    failed_urls = []

    for year in YEARS:
        dest = WSR_DIR / f"wage_settlement_{year}.pdf"
        if dest.exists():
            log.info("Already have wage settlement for %d, skipping download", year)
            downloaded += 1
            # Upsert source_documents row for already-downloaded PDFs
            file_hash = common.sha256_file(dest)
            storage_key = f"local:{dest}"
            try:
                cur.execute(
                    """
                    INSERT INTO source_documents
                        (doc_type, source_url, file_hash, storage_key, school_year)
                    VALUES ('wage_settlement_report', %s, %s, %s, %s)
                    ON CONFLICT (source_url, file_hash) DO NOTHING
                    """,
                    (f"local:{dest}", file_hash, storage_key, f"{year}-{str(year+1)[2:]}"),
                )
                conn.commit()
            except Exception as e:
                conn.rollback()
                log.debug("source_documents upsert for %d WSR: %s", year, e)
            parse_wage_tables(dest, f"local:{dest}", conn)
            continue

        pdf_bytes, url = try_download_year(session, year)
        if not pdf_bytes:
            log.warning(
                "Could not download wage settlement for %d — "
                "all %d URL patterns returned 404. "
                "SERB may have moved these reports; check %s manually.",
                year, len(URL_PATTERNS),
                "https://serb.ohio.gov/wps/portal/gov/serb/view-document-archive/wage-settlement-reports",
            )
            failed_urls.append(str(year))
            continue

        dest.write_bytes(pdf_bytes)
        file_hash = common.sha256_bytes(pdf_bytes)
        storage_key = common.upload_to_object_storage(dest, f"oh/wsr/{file_hash}.pdf")

        # Insert into source_documents
        try:
            cur.execute(
                """
                INSERT INTO source_documents (doc_type, source_url, file_hash, storage_key, school_year)
                VALUES ('wage_settlement_report', %s, %s, %s, %s)
                ON CONFLICT (source_url, file_hash) DO NOTHING
                """,
                (url, file_hash, storage_key, f"{year}-{str(year+1)[2:]}"),
            )
            conn.commit()
        except Exception as e:
            conn.rollback()
            log.warning("DB insert failed for %d WSR: %s", year, e)

        downloaded += 1
        parse_wage_tables(dest, url, conn)

    cur.close()
    conn.close()

    state["wage_settlement_downloaded"] = downloaded
    state["wage_settlement_failed_urls"] = failed_urls
    common.save_crawl_state(state)

    if failed_urls:
        log.warning(
            "Wage settlement PDFs not found for years: %s. "
            "These require manual download from "
            "https://serb.ohio.gov/wps/portal/gov/serb/view-document-archive/wage-settlement-reports",
            ", ".join(failed_urls),
        )
    log.info("Wage settlement reports downloaded: %d", downloaded)


if __name__ == "__main__":
    main()
