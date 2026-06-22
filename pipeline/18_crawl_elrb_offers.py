#!/usr/bin/env python3
"""18_crawl_elrb_offers.py — Scrape IL ELRB public-posting final offers.

The Illinois Educational Labor Relations Board (ELRB) publicly posts each
side's "final offer" when a school district and its union reach impasse in
interest arbitration/mediation. This crawler reads the ELRB year-archive
page(s), parses every posted case (district, union, case number, posted date,
and the two offer PDFs), matches the district, downloads + content-verifies the
PDFs, stores them in object storage under source_documents (doc_type
'final_offer'), and upserts one final_offer_postings row per case.

Self-rolling: by default it crawls the current calendar year's page plus a
small look-back window, so once wired into the nightly cron it picks up new
cases — and brand-new years — with no code change. A year page that does not
exist yet (404) is simply skipped.

The ELRB year page is server-rendered HTML; the offer PDFs are plain <a href>
links under /content/dam/.../public-posting/{YYYY}/. URL pattern (predictable):

    https://elrb.illinois.gov/public-posting---offers-/{YYYY}-public-posting---offers.html

Usage:
    python3 pipeline/18_crawl_elrb_offers.py [--year YYYY] [--years N]
                                             [--dry-run] [--limit N]

    --year YYYY   Crawl exactly this year (repeatable).
    --years N     Crawl the current year plus the previous N-1 years (default 2).
    --dry-run     Parse and report cases without downloading PDFs or writing DB.
    --limit N     Stop after N cases (across all years); for quick testing.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import logging
import re
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup  # type: ignore

import common

log = logging.getLogger("elrb_offers")

ELRB_BASE = "https://elrb.illinois.gov"
YEAR_PAGE_TMPL = ELRB_BASE + "/public-posting---offers-/{year}-public-posting---offers.html"

ELRB_DATA_DIR = common.DATA_DIR / "elrb_offers"

# ELRB case number, e.g. 2026-IM-0007-C  (year-IM-seq-suffix).
CASE_RE = re.compile(r"\b(\d{4}-[A-Z]{1,3}-\d{3,5}-[A-Z])\b")

# Tokens stripped when reducing an IL district name to a comparable "key".
_IL_TYPE_TOKENS = {
    "sd", "cusd", "ccsd", "chsd", "csd", "thsd", "esd", "hsd", "usd", "ud",
    "cud", "gsd", "sds", "district", "schools", "school", "public",
    "community", "unit", "consolidated", "cons", "grade", "high", "elementary",
    "township", "twp", "county", "co", "the", "of", "no", "board", "education",
}

# Party classification. ELRB titles list a district and a union joined by " and "
# or "/", in EITHER order, and the offer-PDF links are identified by party name
# rather than a fixed "District Offer"/"Union Offer" label. Classify any string
# (a title half, or an offer link's href+text) by which keyword family it hits.
_DISTRICT_RE = re.compile(
    r"\b(district|board|employer|cusd|ccsd|chsd|thsd|hsd|esd|usd|csd|sd)\b",
    re.I,
)
_UNION_RE = re.compile(
    r"\b(union|association|federation|council|iea|ift|aft|nea|seiu|"
    r"teamsters|afl|cio|employees|local)\b",
    re.I,
)


def _party_kind(text: str) -> Optional[str]:
    """Classify a string as 'district' | 'union' | None by keyword family."""
    s = " " + re.sub(r"[-/#,.]", " ", text or "").lower() + " "
    dc = len(_DISTRICT_RE.findall(s))
    uc = len(_UNION_RE.findall(s))
    if dc and not uc:
        return "district"
    if uc and not dc:
        return "union"
    if dc and uc:
        return "district" if dc >= uc else "union"
    return None


# ---------------------------------------------------------------------------
# Page parsing
# ---------------------------------------------------------------------------

def _posted_date(title_tag) -> Optional[str]:
    """Pull the ELRB-reported modify date from the title block's data layer."""
    parent = getattr(title_tag, "parent", None)
    raw = parent.get("data-cmp-data-layer") if parent else None
    if not raw:
        return None
    try:
        data = json.loads(raw)
        for v in data.values():
            if isinstance(v, dict) and v.get("repo:modifyDate"):
                return v["repo:modifyDate"]
    except Exception:
        return None
    return None


def _is_case_title(text: str) -> bool:
    low = text.lower()
    if "public posting" in low:
        return False
    if "/" not in text and " and " not in low:
        return False
    return len(text) > 12


def _split_parties(title: str) -> tuple[str, Optional[str]]:
    """Split a case title into (district, union).

    The two parties are joined by '/' or ' and ', and may appear in EITHER
    order (sometimes the union is listed first), so classify each half by
    keyword family rather than trusting position.
    """
    if "/" in title:
        parts = re.split(r"/", title, maxsplit=1)
    else:
        parts = re.split(r"\s+and\s+", title, maxsplit=1)
    if len(parts) < 2:
        return title.strip(), None
    a, b = parts[0].strip(), parts[1].strip()
    ka, kb = _party_kind(a), _party_kind(b)
    swap = (ka == "union" and kb != "union") or (kb == "district" and ka != "district")
    if swap:
        a, b = b, a
    district, union = a, b
    if union and union.lower().startswith("the "):
        union = union[4:].strip()
    return district, union


def parse_year_page(html: str, year: int, page_url: str) -> list[dict]:
    """Return one dict per case parsed from a year-archive page."""
    soup = BeautifulSoup(html, "html.parser")
    cases: list[dict] = []
    cur: Optional[dict] = None

    # Tags in document order: titles (h2/h3), case-number text (p/strong),
    # and offer-PDF links (a). <p> wraps <strong>; whichever supplies the case
    # number first wins (we only set it once per case).
    for tag in soup.find_all(["h2", "h3", "p", "strong", "a"]):
        name = tag.name
        if name in ("h2", "h3"):
            txt = re.sub(r"\s+", " ", tag.get_text(" ", strip=True)).strip()
            if _is_case_title(txt):
                district, union = _split_parties(txt)
                cur = {
                    "title": txt,
                    "district_name": district,
                    "union_name": union,
                    "case_number": None,
                    "posted_date": _posted_date(tag),
                    "year": year,
                    "page_url": page_url,
                    "district_offer_url": None,
                    "union_offer_url": None,
                }
                cases.append(cur)
        elif name in ("p", "strong"):
            if cur is None or cur.get("case_number"):
                continue
            m = CASE_RE.search(tag.get_text(" ", strip=True))
            if m:
                cur["case_number"] = m.group(1)
        elif name == "a":
            if cur is None:
                continue
            href = tag.get("href") or ""
            if not href.lower().endswith(".pdf"):
                continue
            side = _party_kind(href + " " + tag.get_text(" ", strip=True))
            if side is None:
                continue
            cur[f"{side}_offer_url"] = urljoin(ELRB_BASE, href)  # last wins

    # Drop case blocks with neither a case number nor any offer PDF.
    return [
        c for c in cases
        if c.get("case_number")
        or c.get("district_offer_url")
        or c.get("union_offer_url")
    ]


# ---------------------------------------------------------------------------
# IL district matching (number-aware: IL names embed the district number)
# ---------------------------------------------------------------------------

def _name_key(name: str) -> str:
    n = name.lower().replace("#", " ")
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    toks = [
        t for t in n.split()
        if t and not t.isdigit() and t not in _IL_TYPE_TOKENS
    ]
    return " ".join(toks)


def _district_number(name: str) -> Optional[str]:
    nums = re.findall(r"\d+", name)
    return nums[-1] if nums else None


def build_il_index(conn):
    cur = conn.cursor()
    cur.execute("SELECT id, name FROM districts WHERE state = 'IL'")
    by_number: dict[Optional[str], list[tuple]] = {}
    all_rows: list[tuple] = []
    for did, name in cur.fetchall():
        row = (int(did), name, _name_key(name))
        by_number.setdefault(_district_number(name), []).append(row)
        all_rows.append(row)
    cur.close()
    return by_number, all_rows


def _best_fuzzy(key: str, rows: list[tuple]):
    if not key or not rows:
        return None
    try:
        from rapidfuzz import fuzz, process  # type: ignore
    except ImportError:
        for did, name, ckey in rows:
            if ckey == key:
                return (did, name), 100
        return None
    keys = [r[2] for r in rows]
    res = process.extract(key, keys, scorer=fuzz.token_sort_ratio, limit=1)
    if not res:
        return None
    _, score, idx = res[0]
    return (rows[idx][0], rows[idx][1]), score


def match_il_district(district_name: str, by_number, all_rows) -> tuple:
    """Return (district_id | None, status, matched_name)."""
    if not district_name:
        return None, "unmatched", ""
    num = _district_number(district_name)
    key = _name_key(district_name)
    candidates = by_number.get(num, []) if num else []
    if candidates:
        for did, name, ckey in candidates:
            if ckey == key:
                return did, "auto", name
        best = _best_fuzzy(key, candidates)
        if best and best[1] >= 80:
            return best[0][0], "auto", best[0][1]
        if len(candidates) == 1:
            return candidates[0][0], "review", candidates[0][1]
    best = _best_fuzzy(key, all_rows)
    if best and best[1] >= 90:
        return best[0][0], "auto", best[0][1]
    if best and best[1] >= 80:
        return None, "review", best[0][1]
    return None, "unmatched", ""


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _upsert_source_document(cur, district_id, source_url, file_hash,
                            storage_key, bargaining_unit) -> Optional[int]:
    cur.execute(
        """
        INSERT INTO source_documents
            (district_id, doc_type, source_url, file_hash, storage_key,
             bargaining_unit, source_type)
        VALUES (%s, 'final_offer', %s, %s, %s, %s, 'pdf')
        ON CONFLICT (source_url, file_hash) DO UPDATE SET
            district_id     = COALESCE(EXCLUDED.district_id, source_documents.district_id),
            storage_key     = COALESCE(EXCLUDED.storage_key, source_documents.storage_key),
            doc_type        = 'final_offer',
            bargaining_unit = EXCLUDED.bargaining_unit
        RETURNING id
        """,
        (district_id, source_url, file_hash, storage_key, bargaining_unit),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _upsert_posting(cur, case: dict, district_id, bargaining_unit,
                    district_doc_id, union_doc_id) -> Optional[int]:
    posted = case.get("posted_date")
    cur.execute(
        """
        INSERT INTO final_offer_postings
            (district_id, case_number, year, bargaining_unit, district_name,
             union_name, posted_date, district_offer_url, union_offer_url,
             district_source_doc_id, union_source_doc_id, page_url, updated_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, NOW())
        ON CONFLICT (case_number) DO UPDATE SET
            district_id            = COALESCE(EXCLUDED.district_id, final_offer_postings.district_id),
            district_name          = EXCLUDED.district_name,
            union_name             = EXCLUDED.union_name,
            posted_date            = COALESCE(EXCLUDED.posted_date, final_offer_postings.posted_date),
            district_offer_url     = COALESCE(EXCLUDED.district_offer_url, final_offer_postings.district_offer_url),
            union_offer_url        = COALESCE(EXCLUDED.union_offer_url, final_offer_postings.union_offer_url),
            district_source_doc_id = COALESCE(EXCLUDED.district_source_doc_id, final_offer_postings.district_source_doc_id),
            union_source_doc_id    = COALESCE(EXCLUDED.union_source_doc_id, final_offer_postings.union_source_doc_id),
            bargaining_unit        = EXCLUDED.bargaining_unit,
            year                   = EXCLUDED.year,
            page_url               = EXCLUDED.page_url,
            updated_at             = NOW()
        RETURNING id
        """,
        (district_id, case["case_number"], case["year"], bargaining_unit,
         case["district_name"], case.get("union_name"), posted,
         case.get("district_offer_url"), case.get("union_offer_url"),
         district_doc_id, union_doc_id, case.get("page_url")),
    )
    row = cur.fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------------------
# Download + store one offer PDF
# ---------------------------------------------------------------------------

def _download_offer(session, conn, pdf_url, district_id,
                    bargaining_unit) -> Optional[int]:
    resp = common.polite_get(session, pdf_url, headers=common.PDF_HEADERS)
    if resp is None or not resp.ok:
        log.warning("  PDF download failed: %s", pdf_url)
        return None
    data = resp.content
    if len(data) < 1024 or b"%PDF" not in data[:1024]:
        log.warning("  Not a valid PDF (%d bytes): %s", len(data), pdf_url)
        return None

    file_hash = common.sha256_bytes(data)
    storage_key = f"il/final_offers/{file_hash}.pdf"
    ELRB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    local_path = ELRB_DATA_DIR / f"{file_hash}.pdf"
    with open(local_path, "wb") as f:
        f.write(data)
    stored_key = common.upload_to_object_storage(local_path, storage_key)
    with conn.cursor() as cur:
        doc_id = _upsert_source_document(
            cur, district_id, pdf_url, file_hash, stored_key, bargaining_unit)
    conn.commit()
    log.info("  Stored offer doc id=%s (%.1f KB)", doc_id, len(data) / 1024)
    return doc_id


# ---------------------------------------------------------------------------
# Crawl
# ---------------------------------------------------------------------------

def crawl(years: list[int], dry_run: bool = False,
          limit: Optional[int] = None) -> dict:
    session = requests.Session()
    stats = {"pages": 0, "cases": 0, "matched": 0, "unmatched": 0,
             "pdfs_stored": 0, "postings": 0}

    conn = None
    by_number = all_rows = None
    if not dry_run:
        conn = common.get_db_conn()
        by_number, all_rows = build_il_index(conn)

    processed = 0
    for year in years:
        page_url = YEAR_PAGE_TMPL.format(year=year)
        resp = common.polite_get(session, page_url, headers=common.HEADERS)
        if resp is None or resp.status_code == 404:
            log.info("Year %s: no page (HTTP %s) — skipping",
                     year, getattr(resp, "status_code", "none"))
            continue
        if not resp.ok:
            log.warning("Year %s: HTTP %s — skipping", year, resp.status_code)
            continue
        stats["pages"] += 1
        cases = parse_year_page(resp.text, year, page_url)
        log.info("Year %s: %d case(s) parsed", year, len(cases))

        for case in cases:
            if limit is not None and processed >= limit:
                break
            processed += 1
            stats["cases"] += 1
            cno = case.get("case_number") or "(no case#)"
            log.info("Case %s — %s vs %s", cno, case["district_name"],
                     case.get("union_name"))

            bargaining_unit = common.classify_bargaining_unit(
                case.get("union_name") or "", case["district_name"],
                default="teachers")

            if dry_run:
                log.info("  [dry-run] district_offer=%s union_offer=%s posted=%s unit=%s",
                         bool(case.get("district_offer_url")),
                         bool(case.get("union_offer_url")),
                         case.get("posted_date"), bargaining_unit)
                continue

            if not case.get("case_number"):
                log.warning("  No case number — skipping DB write")
                continue

            did, status, matched = match_il_district(
                case["district_name"], by_number, all_rows)
            if did is not None:
                stats["matched"] += 1
                log.info("  Matched district id=%s (%s) [%s]", did, matched, status)
            else:
                stats["unmatched"] += 1
                log.info("  District unmatched [%s] — storing with NULL district_id",
                         status)

            district_doc_id = union_doc_id = None
            if case.get("district_offer_url"):
                district_doc_id = _download_offer(
                    session, conn, case["district_offer_url"],
                    did, bargaining_unit)
                if district_doc_id:
                    stats["pdfs_stored"] += 1
            if case.get("union_offer_url"):
                union_doc_id = _download_offer(
                    session, conn, case["union_offer_url"],
                    did, bargaining_unit)
                if union_doc_id:
                    stats["pdfs_stored"] += 1

            with conn.cursor() as cur:
                posting_id = _upsert_posting(
                    cur, case, did, bargaining_unit,
                    district_doc_id, union_doc_id)
            conn.commit()
            if posting_id:
                stats["postings"] += 1
                log.info("  final_offer_postings id=%s", posting_id)

    if conn is not None:
        conn.close()
    return stats


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def resolve_years(args) -> list[int]:
    if args.year:
        return sorted(set(args.year), reverse=True)
    this_year = _dt.date.today().year
    n = max(1, args.years)
    return [this_year - i for i in range(n)]


def main() -> None:
    common.setup_logging()
    ap = argparse.ArgumentParser(description="Scrape IL ELRB final offers")
    ap.add_argument("--year", type=int, action="append",
                    help="Crawl exactly this year (repeatable)")
    ap.add_argument("--years", type=int, default=2,
                    help="Current year plus previous N-1 years (default 2)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Parse only; no downloads or DB writes")
    ap.add_argument("--limit", type=int, default=None,
                    help="Stop after N cases (testing)")
    args = ap.parse_args()

    years = resolve_years(args)
    log.info("Crawling ELRB offers for year(s): %s%s",
             years, " [dry-run]" if args.dry_run else "")
    stats = crawl(years, dry_run=args.dry_run, limit=args.limit)
    log.info("Done. %s", json.dumps(stats))

    if not args.dry_run:
        status = "success"
        detail = json.dumps(stats)
        common.record_sync_run_status("elrb_offers_crawl", status, detail=detail)


if __name__ == "__main__":
    main()
