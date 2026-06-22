#!/usr/bin/env python3
"""
IL statutory minimum full-time teacher salary — annual CGFA certification ingest.

Public Act 103-515 (amends Section 24-8 of the School Code) requires the Illinois
Commission on Government Forecasting and Accountability (CGFA) to certify and
publish, by July 20 each year, the statewide minimum salary rate for full-time
teachers. This script downloads the certification PDF, extracts the school year,
prior-year rate, applicable percentage increase, new-year rate, and certified
date, and upserts a single row keyed by school year. Runs that find an unchanged
document (same SHA-256) are skipped, so re-runs never create duplicates.

The certification filename embeds the *calendar year* it was issued, e.g.
    https://cgfa.ilga.gov/Upload/Teacher%20Salary%20Certification%202025.pdf
That 2025 letter certifies the rate for the 2026-2027 school year.

Usage:
    python3 pipeline/17_sync_il_min_salary.py                 # auto: current year URL (fallback to prior year)
    python3 pipeline/17_sync_il_min_salary.py --year 2025     # explicit certification (calendar) year
    python3 pipeline/17_sync_il_min_salary.py --url <pdf_url> # explicit URL
    python3 pipeline/17_sync_il_min_salary.py --pdf <path>    # ingest a local PDF (backfill)
    python3 pipeline/17_sync_il_min_salary.py --dry-run       # parse only, no DB writes
"""
import argparse
import logging
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

DOWNLOAD_UA = "CollBarBot/1.0 (hello@collbar.com; IL K-12 CB research)"
DOWNLOAD_TIMEOUT = 30
DOWNLOAD_RETRIES = 3

MIN_SALARY_DIR = common.DATA_DIR / "il_min_salary"

_MONTHS = {
    m: i
    for i, m in enumerate(
        [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December",
        ],
        start=1,
    )
}


def cgfa_url(cert_year: int) -> str:
    """Canonical CGFA certification URL for a given certification (calendar) year."""
    return (
        f"https://cgfa.ilga.gov/Upload/"
        f"Teacher%20Salary%20Certification%20{cert_year}.pdf"
    )


def _download_pdf(url: str) -> bytes:
    """Download a PDF with exponential-backoff retry. Validates %PDF magic bytes."""
    headers = {"User-Agent": DOWNLOAD_UA, "Accept": "application/pdf,*/*"}
    last_exc: Exception | None = None
    for attempt in range(DOWNLOAD_RETRIES):
        wait = 2 ** (attempt + 1)
        try:
            r = requests.get(
                url, headers=headers, timeout=DOWNLOAD_TIMEOUT, allow_redirects=True
            )
            if r.status_code == 200 and r.content[:5].startswith(b"%PDF"):
                return r.content
            log.warning(
                "HTTP %s / non-PDF (attempt %d) for %s — retrying in %ds",
                r.status_code, attempt + 1, url, wait,
            )
        except Exception as exc:
            last_exc = exc
            log.warning("Download error (attempt %d): %s — retrying in %ds", attempt + 1, exc, wait)
        if attempt < DOWNLOAD_RETRIES - 1:
            time.sleep(wait)
    raise RuntimeError(f"Failed to download a valid PDF from {url}") from last_exc


def _pdf_text(data: bytes) -> str:
    """Extract the embedded text layer from PDF bytes via pdfplumber."""
    import io
    import pdfplumber

    parts: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            parts.append(page.extract_text() or "")
    return "\n\n".join(parts).strip()


def parse_certification(text: str) -> dict:
    """Parse the CGFA certification text into structured fields.

    Returns dict with: school_year, prior_year, prior_year_rate (int),
    percentage_increase (float), new_year_rate (int), certified_date (ISO str|None).
    Raises ValueError when the expected figures cannot be located.
    """
    # Two "Minimum Salary Rate for the YYYY-YYYY School Year ... $NN,NNN" lines:
    # the first is the prior year + rate, the last is the new year + rate.
    rate_lines = re.findall(
        r"Minimum Salary Rate for the\s+(\d{4})-(\d{4})\s+School Year[^\n$]*\$\s?([\d,]+)",
        text,
    )
    if len(rate_lines) < 2:
        raise ValueError(
            f"Expected 2 'Minimum Salary Rate' lines, found {len(rate_lines)}"
        )

    prior = rate_lines[0]
    new = rate_lines[-1]
    prior_year = f"{prior[0]}-{prior[1]}"
    prior_year_rate = int(prior[2].replace(",", ""))
    school_year = f"{new[0]}-{new[1]}"
    new_year_rate = int(new[2].replace(",", ""))

    pct_m = re.search(r"Percentage Increase[^%\n]*?(\d+(?:\.\d+)?)\s*%", text)
    if not pct_m:
        raise ValueError("Could not find applicable percentage increase")
    percentage_increase = float(pct_m.group(1))

    # The certification letter date is the first "Month D, YYYY" in the document.
    certified_date: str | None = None
    date_m = re.search(
        r"\b(" + "|".join(_MONTHS) + r")\s+(\d{1,2}),\s*(\d{4})\b", text
    )
    if date_m:
        certified_date = date(
            int(date_m.group(3)), _MONTHS[date_m.group(1)], int(date_m.group(2))
        ).isoformat()

    # Sanity check: new_year_rate should equal prior_year_rate × (1 + pct/100).
    expected = round(prior_year_rate * (1 + percentage_increase / 100))
    if abs(expected - new_year_rate) > 5:
        log.warning(
            "New rate %s deviates from computed %s (prior %s × %.3f%%) — verify the PDF",
            new_year_rate, expected, prior_year_rate, percentage_increase,
        )

    return {
        "school_year": school_year,
        "prior_year": prior_year,
        "prior_year_rate": prior_year_rate,
        "percentage_increase": percentage_increase,
        "new_year_rate": new_year_rate,
        "certified_date": certified_date,
    }


CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS il_min_teacher_salary (
    id                   bigserial PRIMARY KEY,
    school_year          text NOT NULL UNIQUE,
    prior_year           text,
    prior_year_rate      integer,
    percentage_increase  numeric(6,3),
    new_year_rate        integer NOT NULL,
    certified_date       date,
    source_url           text,
    file_hash            text,
    created_at           timestamptz DEFAULT now(),
    updated_at           timestamptz DEFAULT now()
)
"""


def _ensure_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(CREATE_TABLE_SQL)
    conn.commit()


def _existing_hash(conn, school_year: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT file_hash FROM il_min_teacher_salary WHERE school_year = %s",
            (school_year,),
        )
        row = cur.fetchone()
    return row[0] if row else None


def _upsert(conn, rec: dict, source_url: str | None, file_hash: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO il_min_teacher_salary
                (school_year, prior_year, prior_year_rate, percentage_increase,
                 new_year_rate, certified_date, source_url, file_hash, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (school_year) DO UPDATE SET
                prior_year          = EXCLUDED.prior_year,
                prior_year_rate     = EXCLUDED.prior_year_rate,
                percentage_increase = EXCLUDED.percentage_increase,
                new_year_rate       = EXCLUDED.new_year_rate,
                certified_date      = EXCLUDED.certified_date,
                source_url          = EXCLUDED.source_url,
                file_hash           = EXCLUDED.file_hash,
                updated_at          = now()
            """,
            (
                rec["school_year"], rec["prior_year"], rec["prior_year_rate"],
                rec["percentage_increase"], rec["new_year_rate"],
                rec["certified_date"], source_url, file_hash,
            ),
        )
    conn.commit()


def run(
    pdf_path: str | None = None,
    url: str | None = None,
    cert_year: int | None = None,
    dry_run: bool = False,
) -> dict:
    """Ingest a single CGFA certification. Returns a result dict.

    Source resolution order: --pdf (local file) → --url → constructed URL for
    --year → current calendar year (fallback to prior year).
    """
    source_url: str | None = None

    if pdf_path:
        data = Path(pdf_path).read_bytes()
        if not data[:5].startswith(b"%PDF"):
            raise ValueError(f"{pdf_path} is not a PDF (missing %PDF magic bytes)")
        # Record the canonical CGFA URL when the cert year is known.
        source_url = url or (cgfa_url(cert_year) if cert_year else None)
        log.info("Ingesting local PDF: %s", pdf_path)
    else:
        if url:
            candidates = [url]
        elif cert_year:
            candidates = [cgfa_url(cert_year)]
        else:
            this_year = date.today().year
            candidates = [cgfa_url(this_year), cgfa_url(this_year - 1)]

        data = None
        last_exc: Exception | None = None
        for cand in candidates:
            log.info("Downloading CGFA certification: %s", cand)
            try:
                data = _download_pdf(cand)
                source_url = cand
                break
            except Exception as exc:  # try the next candidate (e.g. prior year)
                last_exc = exc
                log.warning("Could not fetch %s: %s", cand, exc)
        if data is None:
            raise RuntimeError("Could not download any CGFA certification PDF") from last_exc

    file_hash = common.sha256_bytes(data)
    log.info("PDF %d bytes, SHA-256: %s…", len(data), file_hash[:16])

    text = _pdf_text(data)
    if not text:
        raise ValueError("Empty text layer — certification PDF unreadable")

    rec = parse_certification(text)
    log.info(
        "Parsed: %s minimum $%s (prior %s $%s, +%.3f%%), certified %s",
        rec["school_year"], f"{rec['new_year_rate']:,}", rec["prior_year"],
        f"{rec['prior_year_rate']:,}", rec["percentage_increase"],
        rec["certified_date"] or "?",
    )

    if dry_run:
        log.info("Dry-run: no DB writes.")
        return {"status": "dry_run", **rec, "source_url": source_url}

    conn = common.get_db_conn()
    try:
        _ensure_table(conn)
        prev_hash = _existing_hash(conn, rec["school_year"])
        if prev_hash and prev_hash == file_hash:
            log.info(
                "Document unchanged for %s (SHA-256 match) — skipping upsert",
                rec["school_year"],
            )
            return {"status": "no_change", **rec, "source_url": source_url}

        # Persist a local copy + best-effort object-storage upload for provenance.
        MIN_SALARY_DIR.mkdir(parents=True, exist_ok=True)
        local_path = MIN_SALARY_DIR / f"teacher_salary_certification_{rec['school_year']}.pdf"
        local_path.write_bytes(data)
        storage_key = f"il_min_salary/teacher_salary_certification_{rec['school_year']}.pdf"
        common.upload_to_object_storage(local_path, storage_key)

        _upsert(conn, rec, source_url, file_hash)
        log.info("Upserted minimum teacher salary for %s", rec["school_year"])
        return {"status": "success", **rec, "source_url": source_url}
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Ingest the IL statutory minimum full-time teacher salary (CGFA)"
    )
    parser.add_argument("--pdf", help="Path to a local certification PDF (backfill)")
    parser.add_argument("--url", help="Explicit certification PDF URL")
    parser.add_argument(
        "--year", type=int,
        help="Certification (calendar) year; builds the canonical CGFA URL",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Download and parse only; no DB or object-storage writes",
    )
    args = parser.parse_args()

    try:
        result = run(
            pdf_path=args.pdf, url=args.url, cert_year=args.year, dry_run=args.dry_run
        )
        status = result["status"]
        if status == "no_change":
            print(f"Certification for {result['school_year']} unchanged — no update needed.")
        elif status == "dry_run":
            print(
                f"Dry-run: {result['school_year']} minimum ${result['new_year_rate']:,} "
                f"(+{result['percentage_increase']}% over {result['prior_year']} "
                f"${result['prior_year_rate']:,}), certified {result['certified_date']}."
            )
        else:
            print(
                f"Ingested {result['school_year']} minimum ${result['new_year_rate']:,} "
                f"(+{result['percentage_increase']}% over {result['prior_year']} "
                f"${result['prior_year_rate']:,}), certified {result['certified_date']}."
            )
    except Exception as exc:
        log.exception("Minimum teacher salary ingest failed: %s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
