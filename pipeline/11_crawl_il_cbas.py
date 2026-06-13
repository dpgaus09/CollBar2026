#!/usr/bin/env python3
"""
IL CBA Acquisition Pipeline — Phase 12

Crawls each Illinois district website to find their current CBA PDF,
stores the PDF in object storage, and inserts a source_documents row
with doc_type='cba_pdf' so the existing 06_extract_contracts.py picks it up.

Usage:
    python3 pipeline/11_crawl_il_cbas.py [--dry-run] [--limit N] [--district RCDTS]

Options:
    --dry-run       Fetch and score pages, but don't download PDFs or write DB rows.
    --limit N       Stop after attempting N districts (for testing).
    --district RCDTS  Only crawl the specified district (by 11-digit RCDTS code).

Resumable: already-found districts are skipped on re-run.
Priority:  Districts with most-recent settlement to_year 2025-26 or 2026-27 first.
"""

import argparse
import csv
import json
import logging
import re
import sys
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

IL_CBA_CRAWL_STATE = Path(__file__).parent / "state" / "il_cba_crawl.json"
IL_CBA_DATA_DIR    = common.DATA_DIR / "il_cba"
IL_UNFOUND_CSV     = common.DATA_DIR / "il_cba_unfound.csv"

IL_CBA_BOT_UA   = "CollBarBot/1.0 (hello@collbar.com; Illinois K-12 CBA research)"
BROWSER_UA      = common.BROWSER_UA
REQUEST_TIMEOUT = 15   # seconds
MAX_HOPS        = 2    # max link depth from homepage
MAX_CANDIDATES  = 3    # top-scoring links to follow per page
MAX_RETRIES     = 3    # per request
RETRY_DELAYS    = [2, 4, 8]   # exponential backoff seconds

# CBA keyword list (case-insensitive, matched on link text AND href)
CBA_KEYWORDS = [
    "collective bargaining",
    "negotiated agreement",
    "union contract",
    "labor agreement",
    "teacher contract",
    "master agreement",
    "cba",
    "iea",
    "ift",
    "board policy",
]

# Keywords that strongly suggest a PDF is a CBA
PDF_KEYWORDS = CBA_KEYWORDS + [
    "agreement",
    "contract",
    "bargaining",
    "union",
    "association",
    "teachers",
    "education association",
]

# ---------------------------------------------------------------------------
# Per-domain rate limiter
# ---------------------------------------------------------------------------

_domain_last_request: dict[str, float] = {}

def _polite_wait(url: str):
    domain = urlparse(url).netloc
    last = _domain_last_request.get(domain, 0.0)
    elapsed = time.time() - last
    if elapsed < common.POLITE_DELAY:
        time.sleep(common.POLITE_DELAY - elapsed)
    _domain_last_request[domain] = time.time()


def _fetch(session: requests.Session, url: str, *, is_pdf: bool = False) -> Optional[requests.Response]:
    """Fetch a URL with per-domain rate limiting and exponential backoff."""
    headers = {
        "User-Agent": BROWSER_UA if is_pdf else IL_CBA_BOT_UA,
        "Accept": "application/pdf,*/*" if is_pdf else
                  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    for attempt in range(MAX_RETRIES):
        _polite_wait(url)
        try:
            r = session.get(url, headers=headers, timeout=REQUEST_TIMEOUT,
                            allow_redirects=True, stream=is_pdf)
            if r.status_code == 429:
                retry_after = int(r.headers.get("Retry-After", RETRY_DELAYS[attempt]))
                log.info("429 on %s — waiting %ds", url, retry_after)
                time.sleep(retry_after)
                continue
            if r.status_code >= 500:
                wait = RETRY_DELAYS[attempt]
                log.warning("HTTP %s on %s — retrying in %ds", r.status_code, url, wait)
                time.sleep(wait)
                continue
            return r
        except requests.exceptions.SSLError as e:
            log.info("SSL error for %s: %s — skipping", url, e)
            return None
        except requests.exceptions.TooManyRedirects:
            log.info("Too many redirects for %s — skipping", url)
            return None
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                log.warning("Request failed after %d tries for %s: %s", MAX_RETRIES, url, e)
                return None
            wait = RETRY_DELAYS[attempt]
            log.info("Request error for %s: %s — retrying in %ds", url, e, wait)
            time.sleep(wait)
    return None


# ---------------------------------------------------------------------------
# Keyword scoring
# ---------------------------------------------------------------------------

def _score_text(text: str) -> int:
    """Count how many CBA keywords appear in text (case-insensitive)."""
    tl = text.lower()
    return sum(1 for kw in CBA_KEYWORDS if kw in tl)


def _score_pdf_text(text: str) -> int:
    """Count PDF-specific keywords for a PDF candidate link."""
    tl = text.lower()
    return sum(1 for kw in PDF_KEYWORDS if kw in tl)


def _same_domain(base_url: str, link_url: str) -> bool:
    base_host = urlparse(base_url).netloc.lower().lstrip("www.")
    link_host = urlparse(link_url).netloc.lower().lstrip("www.")
    return link_host == base_host or link_host.endswith("." + base_host)


def _looks_like_login(url: str, html: str) -> bool:
    """Heuristic: redirect landed on a login/SSO page."""
    if any(kw in url.lower() for kw in ("login", "signon", "auth", "saml", "oauth")):
        return True
    if html and any(kw in html[:3000].lower() for kw in (
        "username", "password", "sign in", "log in", "enter your credentials"
    )):
        return True
    return False


# ---------------------------------------------------------------------------
# Link extraction
# ---------------------------------------------------------------------------

def _extract_links(soup: BeautifulSoup, base_url: str) -> list[dict]:
    """Extract all <a> links from soup, with score and absolute URL."""
    links = []
    for a in soup.find_all("a", href=True):
        href = a.get("href", "").strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        abs_url = urljoin(base_url, href)
        if not abs_url.startswith(("http://", "https://")):
            continue
        text = a.get_text(" ", strip=True)
        combined = f"{text} {href}"
        score = _score_text(combined)
        links.append({"url": abs_url, "text": text, "href": href, "score": score})
    return links


def _extract_pdf_candidates(soup: BeautifulSoup, base_url: str, homepage: str) -> list[dict]:
    """Find all same-domain PDF links on a page, scored by CBA relevance."""
    candidates = []
    for a in soup.find_all("a", href=True):
        href = a.get("href", "").strip()
        if not href:
            continue
        abs_url = urljoin(base_url, href)
        if not abs_url.startswith(("http://", "https://")):
            continue
        # Only collect PDF links that stay on the district's domain
        if not _same_domain(homepage, abs_url):
            log.debug("  Rejecting off-domain PDF candidate: %s", abs_url)
            continue
        is_pdf = (
            ".pdf" in abs_url.lower().split("?")[0] or
            ".pdf" in href.lower()
        )
        if not is_pdf:
            continue
        text = a.get_text(" ", strip=True)
        combined = f"{text} {href}"
        score = _score_pdf_text(combined)
        if score > 0:
            candidates.append({"url": abs_url, "text": text, "score": score})
    return candidates


# ---------------------------------------------------------------------------
# Per-district crawl
# ---------------------------------------------------------------------------

def _crawl_district(session: requests.Session, homepage: str, dry_run: bool) -> Optional[dict]:
    """
    Crawl a district homepage to find the best CBA PDF.
    Returns dict {url, score} of best PDF candidate, or None.
    """
    log.info("  Fetching homepage: %s", homepage)
    r = _fetch(session, homepage)
    if r is None or not r.ok:
        status = r.status_code if r else "timeout"
        log.info("  Homepage not reachable (%s)", status)
        return None

    content_type = r.headers.get("Content-Type", "")
    if "text/html" not in content_type and "xhtml" not in content_type:
        log.info("  Non-HTML content-type (%s) — skipping", content_type)
        return None

    html = r.text
    if _looks_like_login(r.url, html):
        log.info("  Redirected to login page — skipping")
        return None

    soup0 = BeautifulSoup(html, "html.parser")

    # Check for PDF candidates directly on the homepage (same-domain enforced inside)
    pdf_candidates = _extract_pdf_candidates(soup0, r.url, homepage)

    # Collect high-scoring internal links to follow
    all_links = _extract_links(soup0, r.url)
    top_links = sorted(
        [l for l in all_links if l["score"] > 0 and _same_domain(homepage, l["url"])],
        key=lambda l: l["score"],
        reverse=True,
    )[:MAX_CANDIDATES]

    log.info("  Homepage: %d PDF candidates, %d links to follow",
             len(pdf_candidates), len(top_links))

    visited = {r.url, homepage}

    # Follow top links (up to MAX_HOPS deep)
    queue = [(lnk["url"], lnk["text"], 1) for lnk in top_links]
    while queue:
        link_url, link_text, depth = queue.pop(0)
        if link_url in visited:
            continue
        if depth > MAX_HOPS:
            continue
        if not _same_domain(homepage, link_url):
            continue
        visited.add(link_url)

        log.info("  Hop %d: %s  [%s]", depth, link_url, link_text[:60])
        r2 = _fetch(session, link_url)
        if r2 is None or not r2.ok:
            continue

        ct2 = r2.headers.get("Content-Type", "")
        if "text/html" not in ct2 and "xhtml" not in ct2:
            if "application/pdf" in ct2:
                # Direct PDF link we followed
                score = _score_pdf_text(link_url + " " + link_text)
                if score > 0:
                    pdf_candidates.append({"url": link_url, "text": link_text, "score": score})
            continue

        html2 = r2.text
        if _looks_like_login(r2.url, html2):
            continue

        soup2 = BeautifulSoup(html2, "html.parser")
        new_pdfs = _extract_pdf_candidates(soup2, r2.url, homepage)
        pdf_candidates.extend(new_pdfs)
        log.info("    Found %d PDF candidates on hop page", len(new_pdfs))

        # At depth 1, also collect sub-links (for hop 2)
        if depth == 1:
            sub_links = _extract_links(soup2, r2.url)
            sub_top = sorted(
                [l for l in sub_links if l["score"] > 0 and _same_domain(homepage, l["url"])
                 and l["url"] not in visited],
                key=lambda l: l["score"],
                reverse=True,
            )[:MAX_CANDIDATES]
            queue.extend([(l["url"], l["text"], 2) for l in sub_top])

    if not pdf_candidates:
        log.info("  No CBA PDF candidates found")
        return None

    best = max(pdf_candidates, key=lambda c: c["score"])
    log.info("  Best PDF: score=%d  %s", best["score"], best["url"])
    return best


# ---------------------------------------------------------------------------
# Crawl state helpers
# ---------------------------------------------------------------------------

def _load_crawl_state() -> dict:
    if IL_CBA_CRAWL_STATE.exists():
        try:
            with open(IL_CBA_CRAWL_STATE) as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "il_attempted": 0,
        "il_found": 0,
        "il_failed": 0,
        "il_skipped": 0,
        "il_no_url": 0,
        "last_updated": None,
        "per_district": {},
    }


def _save_crawl_state(state: dict):
    IL_CBA_CRAWL_STATE.parent.mkdir(parents=True, exist_ok=True)
    state["last_updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(IL_CBA_CRAWL_STATE, "w") as f:
        json.dump(state, f, indent=2)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _upsert_source_document(cur, district_id: int, source_url: str,
                            file_hash: str, storage_key: str) -> Optional[int]:
    cur.execute(
        """
        INSERT INTO source_documents (district_id, doc_type, source_url, file_hash, storage_key)
        VALUES (%s, 'cba_pdf', %s, %s, %s)
        ON CONFLICT (source_url, file_hash) DO UPDATE SET
            district_id = COALESCE(EXCLUDED.district_id, source_documents.district_id),
            storage_key = COALESCE(EXCLUDED.storage_key, source_documents.storage_key)
        RETURNING id
        """,
        (district_id, source_url, file_hash, storage_key),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _hash_already_stored(cur, file_hash: str) -> bool:
    cur.execute(
        "SELECT 1 FROM source_documents WHERE file_hash = %s AND doc_type = 'cba_pdf'",
        (file_hash,),
    )
    return cur.fetchone() is not None


def _load_districts(conn) -> list[dict]:
    """Load IL districts with website URL, prioritized by settlement recency."""
    cur = conn.cursor()
    cur.execute("""
        SELECT
            d.id,
            d.name,
            d.state_district_id,
            d.website_url,
            d.county,
            d.enrollment,
            MAX(s.to_year) AS latest_to_year
        FROM districts d
        LEFT JOIN settlements s ON s.district_id = d.id
        WHERE d.state = 'IL'
          AND d.website_url IS NOT NULL
        GROUP BY d.id, d.name, d.state_district_id, d.website_url, d.county, d.enrollment
        ORDER BY
            CASE WHEN MAX(s.to_year) IN ('2025-26','2026-27') THEN 0 ELSE 1 END,
            d.name
    """)
    cols = ["id", "name", "state_district_id", "website_url", "county", "enrollment",
            "latest_to_year"]
    rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    cur.close()
    return rows


def _load_il_no_url_districts(conn) -> list[dict]:
    """Load IL districts that have no website_url, for state record-keeping."""
    cur = conn.cursor()
    cur.execute("""
        SELECT id, name, state_district_id
        FROM districts
        WHERE state = 'IL' AND website_url IS NULL
        ORDER BY name
    """)
    cols = ["id", "name", "state_district_id"]
    rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    cur.close()
    return rows


def _load_all_il_districts_for_unfound(conn) -> list[dict]:
    """Load all IL districts with a website URL but no cba_pdf in source_documents."""
    cur = conn.cursor()
    cur.execute("""
        SELECT
            d.id,
            d.name,
            d.county,
            d.enrollment,
            d.website_url,
            MAX(s.to_year) AS latest_to_year
        FROM districts d
        LEFT JOIN settlements s ON s.district_id = d.id
        WHERE d.state = 'IL'
          AND d.website_url IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM source_documents sd
              WHERE sd.district_id = d.id AND sd.doc_type = 'cba_pdf'
          )
        GROUP BY d.id, d.name, d.county, d.enrollment, d.website_url
        ORDER BY d.name
    """)
    cols = ["id", "name", "county", "enrollment", "website_url", "latest_to_year"]
    rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    cur.close()
    return rows


def _count_il_no_url(conn) -> int:
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM districts WHERE state='IL' AND website_url IS NULL")
    n = cur.fetchone()[0]
    cur.close()
    return n


# ---------------------------------------------------------------------------
# Unfound CSV
# ---------------------------------------------------------------------------

def _write_unfound_csv(conn):
    rows = _load_all_il_districts_for_unfound(conn)
    IL_UNFOUND_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(IL_UNFOUND_CSV, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "district_name", "county", "enrollment", "website_url", "last_settlement_year"
        ])
        writer.writeheader()
        for r in rows:
            writer.writerow({
                "district_name":        r["name"],
                "county":               r["county"] or "",
                "enrollment":           r["enrollment"] or "",
                "website_url":          r["website_url"] or "",
                "last_settlement_year": r["latest_to_year"] or "",
            })
    log.info("Unfound CSV written: %s (%d rows)", IL_UNFOUND_CSV, len(rows))
    return len(rows)


# ---------------------------------------------------------------------------
# Bootstrap: auto-call directory loader if no URLs present
# ---------------------------------------------------------------------------

def _ensure_website_urls(conn):
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM districts WHERE state='IL' AND website_url IS NOT NULL")
    count = cur.fetchone()[0]
    cur.close()
    if count > 0:
        log.info("%d IL districts already have website URLs", count)
        return
    log.info("No IL district website URLs found — attempting ISBE Directory ingestion first")
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "load_il_directory",
            Path(__file__).parent / "12_load_il_directory.py",
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.main()
    except SystemExit as e:
        if e.code != 0:
            log.error("Directory loader failed — upload ISBE Directory to pipeline/data/il_directory/")
            sys.exit(1)


# ---------------------------------------------------------------------------
# Main crawl loop
# ---------------------------------------------------------------------------

def crawl(dry_run: bool = False, limit: Optional[int] = None,
          target_rcdts: Optional[str] = None):
    conn = common.get_db_conn()

    _ensure_website_urls(conn)

    districts = _load_districts(conn)
    no_url_count = _count_il_no_url(conn)

    if target_rcdts:
        districts = [d for d in districts if d["state_district_id"] == target_rcdts]
        if not districts:
            log.error("District with RCDTS %s not found or has no website URL", target_rcdts)
            sys.exit(1)

    log.info("IL CBA crawler starting: %d districts with URL (dry_run=%s, limit=%s)",
             len(districts), dry_run, limit)

    state = _load_crawl_state()
    state["il_no_url"] = no_url_count

    # Record no_url entries in per_district so the schema is complete
    no_url_districts = _load_il_no_url_districts(conn)
    ts_now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for d in no_url_districts:
        rcdts = d["state_district_id"]
        if rcdts not in state["per_district"]:
            state["per_district"][rcdts] = {
                "status":    "no_url",
                "timestamp": ts_now,
            }

    session = requests.Session()

    attempted = 0
    found = 0
    failed = 0
    skipped = 0

    cur = conn.cursor()

    for dist in districts:
        rcdts    = dist["state_district_id"]
        name     = dist["name"]
        homepage = dist["website_url"]
        dist_id  = dist["id"]

        # Skip already-resolved districts
        prev = state["per_district"].get(rcdts, {})
        if prev.get("status") in ("found", "skip"):
            log.info("[SKIP] %s (%s) — already %s", name, rcdts, prev["status"])
            skipped += 1
            continue

        if limit is not None and attempted >= limit:
            log.info("Limit of %d reached — stopping", limit)
            break

        log.info("[ATTEMPT] %s (%s) → %s", name, rcdts, homepage)
        attempted += 1

        best_pdf = _crawl_district(session, homepage, dry_run)

        if best_pdf is None:
            failed += 1
            state["per_district"][rcdts] = {
                "status":    "failed",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            _save_crawl_state(state)
            continue

        pdf_url = best_pdf["url"]

        if dry_run:
            log.info("[DRY-RUN] Would download: %s", pdf_url)
            found += 1
            state["per_district"][rcdts] = {
                "status":    "found",
                "url":       pdf_url,
                "dry_run":   True,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            _save_crawl_state(state)
            continue

        # Final domain guard before download (defense-in-depth)
        if not _same_domain(homepage, pdf_url):
            log.info("  Rejecting off-domain PDF URL (final check): %s", pdf_url)
            failed += 1
            state["per_district"][rcdts] = {
                "status":    "failed",
                "url":       pdf_url,
                "reason":    "off_domain",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            _save_crawl_state(state)
            continue

        # Download
        log.info("  Downloading PDF: %s", pdf_url)
        pdf_resp = _fetch(session, pdf_url, is_pdf=True)
        if pdf_resp is None or not pdf_resp.ok:
            log.warning("  PDF download failed for %s", pdf_url)
            failed += 1
            state["per_district"][rcdts] = {
                "status":    "failed",
                "url":       pdf_url,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            _save_crawl_state(state)
            continue

        pdf_bytes = pdf_resp.content
        if len(pdf_bytes) < 1024:
            log.info("  PDF too small (%d bytes) — likely not a real PDF", len(pdf_bytes))
            failed += 1
            state["per_district"][rcdts] = {
                "status":    "failed",
                "url":       pdf_url,
                "reason":    "too_small",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            _save_crawl_state(state)
            continue

        file_hash   = common.sha256_bytes(pdf_bytes)
        storage_key = f"il/cba/{file_hash}.pdf"

        # Dedup check
        if _hash_already_stored(cur, file_hash):
            log.info("  Duplicate (hash already in DB) — skipping download")
            skipped += 1
            state["per_district"][rcdts] = {
                "status":    "skip",
                "url":       pdf_url,
                "file_hash": file_hash,
                "reason":    "duplicate",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            _save_crawl_state(state)
            continue

        # Save locally
        IL_CBA_DATA_DIR.mkdir(parents=True, exist_ok=True)
        local_path = IL_CBA_DATA_DIR / f"{file_hash}.pdf"
        with open(local_path, "wb") as f:
            f.write(pdf_bytes)
        log.info("  Saved locally: %s  (%.1f KB)", local_path.name, len(pdf_bytes) / 1024)

        # Upload to object storage
        stored_key = common.upload_to_object_storage(local_path, storage_key)
        log.info("  Stored: %s", stored_key)

        # Insert source_documents row
        doc_id = _upsert_source_document(cur, dist_id, pdf_url, file_hash, stored_key)
        conn.commit()
        log.info("  source_documents id=%s", doc_id)

        found += 1
        state["per_district"][rcdts] = {
            "status":      "found",
            "url":         pdf_url,
            "storage_key": stored_key,
            "file_hash":   file_hash,
            "doc_id":      str(doc_id),
            "timestamp":   time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _save_crawl_state(state)

    # Update aggregate counters
    all_statuses = [v["status"] for v in state["per_district"].values()]
    state["il_attempted"] = sum(1 for s in all_statuses if s in ("found", "failed"))
    state["il_found"]     = sum(1 for s in all_statuses if s == "found")
    state["il_failed"]    = sum(1 for s in all_statuses if s == "failed")
    state["il_skipped"]   = sum(1 for s in all_statuses if s in ("skip",))
    _save_crawl_state(state)

    # Write unfound CSV
    if not dry_run:
        unfound_n = _write_unfound_csv(conn)
    else:
        unfound_n = len(districts) - found

    cur.close()
    conn.close()

    total_with_url = len(districts)
    pct = (found / total_with_url * 100) if total_with_url > 0 else 0.0

    print(f"\n{'='*65}")
    print(f"IL CBA Crawl Results{'  [DRY RUN]' if dry_run else ''}")
    print(f"{'='*65}")
    print(f"  Districts with website URL:  {total_with_url:>6,}")
    print(f"  Districts without URL:       {no_url_count:>6,}")
    print(f"  Attempted this run:          {attempted:>6,}")
    print(f"  PDFs found/downloaded:       {found:>6,}  ({pct:.1f}%)")
    print(f"  Failed / no PDF found:       {failed:>6,}")
    print(f"  Skipped (done or dup):       {skipped:>6,}")
    if not dry_run:
        print(f"  Unfound CSV:                 {unfound_n:>6,} rows")
    print(f"{'='*65}\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="IL CBA acquisition crawler")
    parser.add_argument("--dry-run", action="store_true",
                        help="Score pages but don't download or write DB rows")
    parser.add_argument("--limit", type=int, default=None,
                        help="Stop after N districts")
    parser.add_argument("--district", type=str, default=None,
                        help="Only crawl this district (11-digit RCDTS code)")
    args = parser.parse_args()
    crawl(dry_run=args.dry_run, limit=args.limit, target_rcdts=args.district)
