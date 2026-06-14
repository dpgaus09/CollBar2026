#!/usr/bin/env python3
"""
IL CBA Acquisition Pipeline — Phase 12

Crawls each Illinois district website to find their current CBA PDF,
stores the PDF in object storage, and inserts a source_documents row
with doc_type='cba_pdf' so the existing 06_extract_contracts.py picks it up.

Usage:
    python3 pipeline/11_crawl_il_cbas.py [--dry-run] [--limit N] [--district RCDTS]
                                          [--search-fallback]

Options:
    --dry-run           Fetch and score pages, but don't download PDFs or write DB rows.
    --limit N           Stop after attempting N districts (for testing).
    --district RCDTS    Only crawl the specified district (by 11-digit RCDTS code).
    --search-fallback   After a direct crawl fails, issue a search-engine query to find
                        the CBA PDF (uses Google CSE if GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX
                        env vars are set, otherwise falls back to DuckDuckGo HTML search).

Resumable: already-found districts are skipped on re-run.
Priority:  Districts with most-recent settlement to_year 2025-26 or 2026-27 first.
"""

import argparse
import csv
import json
import logging
import os
import re
import signal
import sys
import time
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urljoin, urlparse

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

IL_CBA_BOT_UA        = "CollBarBot/1.0 (hello@collbar.com; Illinois K-12 CBA research)"
BROWSER_UA           = common.BROWSER_UA
REQUEST_TIMEOUT      = 15   # seconds per HTTP request
DISTRICT_TIMEOUT     = 120  # seconds total per district crawl (SIGALRM watchdog)
MAX_HOPS             = 2    # max link depth from homepage
MAX_CANDIDATES       = 5    # top-scoring links to follow per page (CBA + nav)
MAX_RETRIES          = 3    # per request
RETRY_DELAYS         = [2, 4, 8]   # exponential backoff seconds


def _district_timeout_handler(signum, frame):
    raise TimeoutError("District crawl exceeded time limit")

# Bargaining-unit signal keywords — used to follow/score links toward
# non-teacher CBAs so multi-unit collection doesn't miss them. Canonical unit
# assignment is delegated to common.classify_bargaining_unit. Tokens here are
# matched as case-insensitive substrings, so avoid short ambiguous tokens
# (e.g. bare "esp" or "rn") that would false-match common words.
UNIT_KEYWORDS = [
    # union organizations (strong CBA signal regardless of unit)
    "seiu", "afscme", "teamster", "iuoe", "operating engineers",
    # support-staff / ESP umbrella
    "support staff", "support personnel", "educational support",
    "education support", "classified staff", "classified employees",
    "non-certified", "non-certificated", "noncertified",
    # specific non-certified units
    "paraprofessional", "para-professional", "teacher aide",
    "custodial", "custodian", "maintenance", "transportation",
    "bus driver", "secretary", "secretarial", "clerical",
    "food service", "cafeteria", "child nutrition", "nurse",
]

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
] + UNIT_KEYWORDS

# Navigation keywords — broader terms for following links that may lead to CBA pages.
# These don't directly mention a CBA but commonly lead to pages that do.
NAV_KEYWORDS = [
    "board of education",
    "school board",
    "board docs",
    "boarddocs",
    "human resources",
    " hr ",
    "staff resources",
    "employment",
    "personnel",
    "superintendent",
    "labor relations",
    "contract",
    "agreement",
    "bargaining",
    "teachers union",
    "labor union",
    "transparency",
    "teacher resources",
    "employee resources",
    "negotiat",
    "district document",
    "board document",
    "support staff",
    "classified",
    "download",
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

# Search-engine fallback settings
SEARCH_MAX_RESULTS  = 10    # max results to inspect per engine
SEARCH_API_DELAY    = 1.0   # seconds between Google CSE calls
SEARCH_SERPER_DELAY = 1.0   # seconds between Serper.dev calls (politeness/backoff)
SEARCH_DDG_DELAY    = 3.0   # seconds between DuckDuckGo calls
DDG_MAX_RETRIES     = 2

# Module-level rate-limit timestamps
_google_cse_last_call: float = 0.0
_serper_last_call: float = 0.0
_ddg_last_call: float = 0.0

# Per-run cache of search query -> result URLs (avoids repeating identical
# queries across the per-unit variants and across districts that share a host).
_search_query_cache: dict[str, list[str]] = {}

# Set to True once Google CSE returns a quota/auth error
_google_cse_quota_exhausted: bool = False


# ---------------------------------------------------------------------------
# Search-engine helpers
# ---------------------------------------------------------------------------

def _serper_search(query: str, session: requests.Session) -> list[str]:
    """
    Search via Serper.dev (Google Search JSON API).
    Returns a list of result URLs (all types — not just PDF).
    Set SERPER_API_KEY env var to enable.
    """
    global _serper_last_call

    api_key = os.environ.get("SERPER_API_KEY", "").strip()
    if not api_key:
        return []

    cache_key = f"serper::{query}"
    if cache_key in _search_query_cache:
        cached = _search_query_cache[cache_key]
        log.info("  Serper [cache]: %d result(s) for %r", len(cached), query)
        return cached

    # Politeness/backoff: keep at least SEARCH_SERPER_DELAY seconds between calls.
    wait = SEARCH_SERPER_DELAY - (time.time() - _serper_last_call)
    if wait > 0:
        time.sleep(wait)
    _serper_last_call = time.time()

    try:
        r = session.post(
            "https://google.serper.dev/search",
            json={"q": query, "num": SEARCH_MAX_RESULTS},
            headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
            timeout=REQUEST_TIMEOUT,
        )
    except Exception as e:
        log.warning("Serper request error: %s", e)
        return []

    if r.status_code == 429:
        # Rate limited — back off once and retry a single time.
        log.warning("Serper rate-limited (429) — backing off %.1fs and retrying once",
                    SEARCH_SERPER_DELAY * 3)
        time.sleep(SEARCH_SERPER_DELAY * 3)
        try:
            r = session.post(
                "https://google.serper.dev/search",
                json={"q": query, "num": SEARCH_MAX_RESULTS},
                headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
                timeout=REQUEST_TIMEOUT,
            )
            _serper_last_call = time.time()
        except Exception as e:
            log.warning("Serper retry error: %s", e)
            return []

    if not r.ok:
        log.warning("Serper API HTTP %s for query %r: %s", r.status_code, query, r.text[:120])
        return []

    try:
        data = r.json()
    except Exception:
        return []

    urls = [item["link"] for item in data.get("organic", []) if item.get("link")]
    log.info("  Serper: %d result(s) for %r", len(urls), query)
    _search_query_cache[cache_key] = urls
    return urls


def _google_cse_search(
    query: str, session: requests.Session, api_key: str, cx: str
) -> Optional[list[str]]:
    """
    Search using Google Custom Search API.

    Returns a list of candidate URLs (may be empty), or *None* to signal
    a hard quota / auth error.  On a quota/auth error the module-level
    ``_google_cse_quota_exhausted`` flag is set so subsequent calls in the
    same run are skipped immediately without wasting additional API quota.
    """
    global _google_cse_last_call, _google_cse_quota_exhausted

    if _google_cse_quota_exhausted:
        log.debug("  Google CSE disabled for this run (quota/auth error earlier)")
        return None

    wait = SEARCH_API_DELAY - (time.time() - _google_cse_last_call)
    if wait > 0:
        time.sleep(wait)
    _google_cse_last_call = time.time()

    params = {
        "key":      api_key,
        "cx":       cx,
        "q":        query,
        "num":      SEARCH_MAX_RESULTS,
        "fileType": "pdf",
    }
    try:
        r = session.get(
            "https://www.googleapis.com/customsearch/v1",
            params=params,
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": IL_CBA_BOT_UA},
        )
    except Exception as e:
        log.warning("Google CSE request error: %s", e)
        return []

    if r.status_code in (403, 429):
        log.warning(
            "Google CSE quota/auth error (HTTP %s) — disabling for this run",
            r.status_code,
        )
        _google_cse_quota_exhausted = True
        return None   # Caller will fall through to DuckDuckGo

    if not r.ok:
        log.warning("Google CSE returned HTTP %s for query: %s", r.status_code, query)
        return []

    try:
        data = r.json()
    except Exception:
        return []

    items = data.get("items") or []
    urls = [
        item["link"]
        for item in items
        if item.get("link") and ".pdf" in item["link"].lower()
    ]
    log.info("  Google CSE: %d PDF result(s) for %r", len(urls), query)
    return urls


def _ddg_search(query: str, session: requests.Session) -> list[str]:
    """
    Search DuckDuckGo HTML interface (no API key required).

    Parses <a class="result__a"> elements and resolves DDG redirect wrappers
    (uddg= query param) to real URLs.  Returns a list of candidate URLs
    (may be empty).
    """
    global _ddg_last_call
    wait = SEARCH_DDG_DELAY - (time.time() - _ddg_last_call)
    if wait > 0:
        time.sleep(wait)
    _ddg_last_call = time.time()

    for attempt in range(DDG_MAX_RETRIES):
        try:
            r = session.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers={
                    "User-Agent":      BROWSER_UA,
                    "Accept":          "text/html,application/xhtml+xml",
                    "Accept-Language": "en-US,en;q=0.9",
                },
                timeout=REQUEST_TIMEOUT,
            )
        except Exception as e:
            log.warning("DuckDuckGo request error: %s", e)
            return []

        if r.status_code == 429:
            wait_s = int(r.headers.get("Retry-After", SEARCH_DDG_DELAY * (attempt + 2)))
            log.warning("DuckDuckGo rate-limited — waiting %ds", wait_s)
            time.sleep(wait_s)
            _ddg_last_call = time.time()
            continue

        if not r.ok:
            log.warning("DuckDuckGo returned HTTP %s", r.status_code)
            return []

        soup = BeautifulSoup(r.text, "html.parser")
        urls: list[str] = []
        for a in soup.select("a.result__a"):
            href = a.get("href", "")
            # DDG wraps links: /l/?uddg=<encoded-real-url>&...
            if "uddg=" in href:
                qs = parse_qs(urlparse(href).query)
                real = qs.get("uddg", [""])[0]
                if real:
                    href = real
            if href and ".pdf" in href.lower():
                urls.append(href)

        log.info("  DuckDuckGo: %d PDF result(s) for %r", len(urls), query)
        return urls

    return []


# Per-unit search phrases. Each adds a unit-targeted query variant so the
# crawler can surface separate non-teacher CBAs (support staff, custodial,
# ESP, etc.) that a single generic "collective bargaining" query would miss.
# The bargaining unit of each returned PDF is still decided by
# _classify_candidate (filename/link text), never by which query surfaced it —
# so units are never mixed.
_SEARCH_UNIT_PHRASES = [
    "collective bargaining agreement",
    "support staff collective bargaining agreement",
    "educational support personnel agreement",
]


# Domains that host generic, district-agnostic documents (state board-meeting
# packets, legislative records, association libraries). For a no-URL district
# these routinely match on the district name alone and yield false-positive
# "CBAs"; some (isbe.net) are also unreachable from this environment, wasting
# download retries. A CBA candidate from one of these is never accepted.
_SEARCH_DOMAIN_DENYLIST = (
    "isbe.net",
    "ilga.gov",
    "illinois.gov",
)


def _is_denied_search_domain(url: str) -> bool:
    """True if url's host is (a subdomain of) a denylisted aggregator domain."""
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return False
    if host.startswith("www."):
        host = host[4:]
    return any(host == d or host.endswith("." + d) for d in _SEARCH_DOMAIN_DENYLIST)


def _serper_collect(name: str, domain: Optional[str],
                    session: requests.Session) -> list[str]:
    """Run Serper queries (generic + per-unit variants) and return all URLs.

    Site-scoped queries run first when a domain is known (cheap, precise). Only
    when those return nothing do we fall back to off-site name-scoped queries
    (union/state-hosted PDFs) — which is also the only path for the ~194 IL
    districts that have no website_url at all.
    """
    urls: list[str] = []

    if domain:
        for phrase in _SEARCH_UNIT_PHRASES:
            q = f'site:{domain} "{phrase}" filetype:pdf'
            log.info("  Search fallback [Serper, site]: %s", q)
            urls.extend(_serper_search(q, session))
        if not urls:
            # Broader site-scoped (catches non-.pdf doc-management links).
            q = f'site:{domain} "collective bargaining" OR "negotiated agreement"'
            log.info("  Search fallback [Serper, site-broad]: %s", q)
            urls.extend(_serper_search(q, session))

    if not urls:
        # Off-site / no-domain: constrain to the exact district name + Illinois.
        for phrase in ("collective bargaining agreement", "support staff agreement"):
            q = f'"{name}" Illinois "{phrase}" filetype:pdf'
            log.info("  Search fallback [Serper, name]: %s", q)
            urls.extend(_serper_search(q, session))

    return urls


def _search_fallback(district: dict, session: requests.Session) -> list[dict]:
    """
    Issue search-engine queries to find CBA PDF(s) for a district whose direct
    crawl failed, or which has no website_url at all.

    Priority order:
      1. Serper.dev (SERPER_API_KEY) — reliable Google results JSON API
      2. Google CSE (GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX)
      3. DuckDuckGo HTML scraping (no key required, fragile fallback)

    Every candidate URL is scored against CBA keywords (+5 same-domain bonus,
    +3 .pdf bonus) and classified into a bargaining unit. The best-scoring PDF
    *per unit* is kept, so a district that publishes separate teacher / support
    staff / custodial CBAs yields one candidate per unit (units never mixed).

    Returns a list of candidate dicts {url, score, found_via, bargaining_unit,
    text} (possibly empty).
    """
    name     = district["name"]
    homepage = district.get("website_url") or None
    # Derive domain only when we have a real homepage URL.
    domain   = urlparse(homepage).netloc.lstrip("www.") if homepage else None

    candidate_urls: list[str] = []
    engine_used    = "none"

    serper_key = os.environ.get("SERPER_API_KEY", "").strip()

    # --- 1. Serper (primary — uses Google's index, reliable JSON API) ---
    if serper_key:
        candidate_urls = _serper_collect(name, domain, session)
        if candidate_urls:
            engine_used = "serper"

    # --- 2. Google CSE ---
    if not candidate_urls:
        api_key = os.environ.get("GOOGLE_CSE_API_KEY", "").strip()
        cx      = os.environ.get("GOOGLE_CSE_CX", "").strip()
        if api_key and cx and domain:
            q = f'site:{domain} "collective bargaining" filetype:pdf'
            log.info("  Search fallback [Google CSE]: %s", q)
            result = _google_cse_search(q, session, api_key, cx)
            if result is None:
                log.warning("  Google CSE quota exhausted — will still try DuckDuckGo")
            else:
                candidate_urls.extend(result)
            if candidate_urls:
                engine_used = "google_cse"

    # --- 3. DuckDuckGo HTML scraping ---
    if not candidate_urls:
        if domain:
            q_site = f'site:{domain} "collective bargaining" filetype:pdf'
            log.info("  Search fallback [DDG, site-scoped]: %s", q_site)
            candidate_urls.extend(_ddg_search(q_site, session))

        if not candidate_urls:
            q_broad = f'"{name}" "collective bargaining agreement" filetype:pdf'
            log.info("  Search fallback [DDG, broad]: %s", q_broad)
            candidate_urls.extend(_ddg_search(q_broad, session))

        if candidate_urls:
            engine_used = "duckduckgo"

    if not candidate_urls:
        log.info("  Search fallback found no candidates")
        return []

    # Score + classify each unique URL; keep the best-scoring PDF per unit.
    found_via = f"search_fallback:{engine_used}"
    best_per_unit: dict[str, dict] = {}
    seen: set[str] = set()
    for url in candidate_urls:
        if url in seen:
            continue
        seen.add(url)
        if _is_denied_search_domain(url):
            log.info("  [search] skipping denylisted (non-district) domain: %s", url)
            continue
        kw_score  = _score_pdf_text(url)
        on_domain = _same_domain(homepage, url) if homepage else False
        pdf_bonus = 3 if ".pdf" in url.lower().split("?")[0] else 0
        total     = kw_score + (5 if on_domain else 0) + pdf_bonus
        if total <= 0:
            continue
        unit = _classify_candidate(url, "")
        cur_best = best_per_unit.get(unit)
        if cur_best is None or total > cur_best["score"]:
            best_per_unit[unit] = {
                "url":             url,
                "score":           total,
                "found_via":       found_via,
                "bargaining_unit": unit,
                "text":            "",
            }

    if not best_per_unit:
        log.info("  Search fallback: no candidate scored above 0")
        return []

    results = sorted(best_per_unit.values(), key=lambda c: c["score"], reverse=True)
    log.info(
        "  Search fallback [%s] %d unit(s): %s",
        engine_used, len(results),
        ", ".join(f'{c["bargaining_unit"]}({c["score"]})' for c in results),
    )
    return results


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


def _score_nav(text: str) -> int:
    """Count navigation keywords — used to decide which links are worth following
    even when they don't directly mention a CBA (e.g. Board, Human Resources)."""
    tl = text.lower()
    return sum(1 for kw in NAV_KEYWORDS if kw in tl)


def _score_pdf_text(text: str) -> int:
    """Count PDF-specific keywords for a PDF candidate link."""
    tl = text.lower()
    return sum(1 for kw in PDF_KEYWORDS if kw in tl)


def _same_domain(base_url: str, link_url: str) -> bool:
    base_host = urlparse(base_url).netloc.lower().lstrip("www.")
    link_host = urlparse(link_url).netloc.lower().lstrip("www.")
    return link_host == base_host or link_host.endswith("." + base_host)


def _classify_candidate(url: str, text: str) -> str:
    """Classify a PDF candidate's bargaining unit from its link text + filename.

    Defaults to 'teachers': a generic "Collective Bargaining Agreement" link
    with no unit signal is, by IL convention, the certificated/teacher CBA.
    This is only a crawl-time hint — the extraction LLM overrides it per
    contract from the document's actual content.
    """
    fname = urlparse(url).path.rsplit("/", 1)[-1]
    return common.classify_bargaining_unit(text, fname, default="teachers")


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
        score     = _score_text(combined)
        nav_score = _score_nav(combined)
        links.append({"url": abs_url, "text": text, "href": href,
                      "score": score, "nav_score": nav_score})
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

def _crawl_district(session: requests.Session, homepage: str, dry_run: bool) -> list[dict]:
    """
    Crawl a district homepage to find CBA PDFs across bargaining units.
    Returns a list of {url, text, score, bargaining_unit} dicts — the
    best-scoring PDF per classified unit (teachers, support_staff, custodial,
    etc.) — or an empty list when none are found.
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

    # Collect internal links to follow: strict CBA matches first, then broader
    # navigation links (Board, Human Resources, Staff, Documents, etc.) that may
    # lead to CBA pages even when they don't mention CBA directly.
    all_links = _extract_links(soup0, r.url)
    same_domain_links = [l for l in all_links if _same_domain(homepage, l["url"])]

    cba_links = sorted(
        [l for l in same_domain_links if l["score"] > 0],
        key=lambda l: l["score"],
        reverse=True,
    )[:MAX_CANDIDATES]
    cba_urls = {l["url"] for l in cba_links}

    nav_links = sorted(
        [l for l in same_domain_links
         if l["score"] == 0 and l["nav_score"] > 0 and l["url"] not in cba_urls],
        key=lambda l: l["nav_score"],
        reverse=True,
    )[:MAX_CANDIDATES]

    top_links = cba_links + nav_links

    log.info("  Homepage: %d PDF candidates, %d links to follow (%d CBA + %d nav)",
             len(pdf_candidates), len(top_links), len(cba_links), len(nav_links))

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

        # At depth 1, also collect sub-links (for hop 2) — include nav-scored links
        # so pages like "Board of Education" lead us deeper toward the CBA PDF.
        if depth == 1:
            sub_links = _extract_links(soup2, r2.url)
            sub_same = [l for l in sub_links
                        if _same_domain(homepage, l["url"]) and l["url"] not in visited]

            cba_sub = sorted(
                [l for l in sub_same if l["score"] > 0],
                key=lambda l: l["score"], reverse=True,
            )[:MAX_CANDIDATES]
            cba_sub_urls = {l["url"] for l in cba_sub}

            nav_sub = sorted(
                [l for l in sub_same
                 if l["score"] == 0 and l["nav_score"] > 0
                 and l["url"] not in cba_sub_urls],
                key=lambda l: l["nav_score"], reverse=True,
            )[:MAX_CANDIDATES]

            queue.extend([(l["url"], l["text"], 2) for l in cba_sub + nav_sub])

    if not pdf_candidates:
        log.info("  No CBA PDF candidates found")
        return []

    # Dedup by URL, keeping the highest score per URL.
    by_url: dict[str, dict] = {}
    for c in pdf_candidates:
        u = c["url"]
        if u not in by_url or c["score"] > by_url[u]["score"]:
            by_url[u] = c

    # Multi-unit collection: classify each PDF and keep the best-scoring PDF
    # per bargaining unit, so a district that publishes separate teacher,
    # support-staff, custodial, etc. CBAs yields one source_document per unit
    # (instead of only the single top-scoring PDF, which was always a teacher
    # contract and silently dropped the others).
    best_per_unit: dict[str, dict] = {}
    for c in by_url.values():
        unit = _classify_candidate(c["url"], c["text"])
        cand = {**c, "bargaining_unit": unit}
        cur_best = best_per_unit.get(unit)
        if cur_best is None or cand["score"] > cur_best["score"]:
            best_per_unit[unit] = cand

    results = sorted(best_per_unit.values(), key=lambda c: c["score"], reverse=True)
    log.info(
        "  Collected %d PDF(s) across %d unit(s): %s",
        len(results), len(best_per_unit),
        ", ".join(f'{c["bargaining_unit"]}({c["score"]})' for c in results),
    )
    return results


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
                            file_hash: str, storage_key: str,
                            bargaining_unit: str = "teachers") -> Optional[int]:
    cur.execute(
        """
        INSERT INTO source_documents
            (district_id, doc_type, source_url, file_hash, storage_key, bargaining_unit)
        VALUES (%s, 'cba_pdf', %s, %s, %s, %s)
        ON CONFLICT (source_url, file_hash) DO UPDATE SET
            district_id     = COALESCE(EXCLUDED.district_id, source_documents.district_id),
            storage_key     = COALESCE(EXCLUDED.storage_key, source_documents.storage_key),
            bargaining_unit = EXCLUDED.bargaining_unit
        RETURNING id
        """,
        (district_id, source_url, file_hash, storage_key, bargaining_unit),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _hash_already_stored(cur, district_id: int, file_hash: str) -> bool:
    """True if THIS district already has a cba_pdf with this file hash.

    Per-district (not global) so two districts may legitimately host the same
    PDF, while a district's own duplicate downloads are still skipped.
    """
    cur.execute(
        "SELECT 1 FROM source_documents "
        "WHERE district_id = %s AND file_hash = %s AND doc_type = 'cba_pdf'",
        (district_id, file_hash),
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
# Download + store a single classified PDF candidate
# ---------------------------------------------------------------------------

def _store_candidate(cur, conn, session, district_id, candidate, homepage, dry_run):
    """Download, store, and insert one classified PDF candidate.

    Returns (status, info) where status is 'found' | 'failed' | 'skip' and
    info is a per-unit state dict (always carries 'bargaining_unit' and
    'status').
    """
    pdf_url   = candidate["url"]
    unit      = candidate.get("bargaining_unit", "teachers")
    found_via = candidate.get("found_via", "direct_crawl")

    # Final domain guard (defense-in-depth). Search-fallback results may be
    # off-domain — the search engine already vetted them — but direct-crawl
    # candidates must stay on the district's own domain.
    if found_via == "direct_crawl" and homepage and not _same_domain(homepage, pdf_url):
        log.info("  Rejecting off-domain PDF URL (final check): %s", pdf_url)
        return "failed", {"status": "failed", "url": pdf_url,
                          "reason": "off_domain", "bargaining_unit": unit}

    if dry_run:
        log.info("[DRY-RUN] Would download [%s]: %s  (via %s)", unit, pdf_url, found_via)
        return "found", {"status": "found", "url": pdf_url, "found_via": found_via,
                         "bargaining_unit": unit, "dry_run": True}

    log.info("  Downloading PDF [%s]: %s", unit, pdf_url)
    pdf_resp = _fetch(session, pdf_url, is_pdf=True)
    if pdf_resp is None or not pdf_resp.ok:
        log.warning("  PDF download failed for %s", pdf_url)
        return "failed", {"status": "failed", "url": pdf_url, "bargaining_unit": unit}

    pdf_bytes = pdf_resp.content
    if len(pdf_bytes) < 1024:
        log.info("  PDF too small (%d bytes) — likely not a real PDF", len(pdf_bytes))
        return "failed", {"status": "failed", "url": pdf_url,
                          "reason": "too_small", "bargaining_unit": unit}

    # Content guard: many candidates (doc-management landing pages, board index
    # pages) are HTML, not PDFs. The broad site-scoped search query intentionally
    # returns such non-.pdf URLs because some redirect to a PDF — but when the
    # body is actually HTML, storing it under a .pdf key marks the district
    # 'found' with junk and guarantees a downstream extraction failure. Require
    # the %PDF header (tolerating a small leading BOM/whitespace offset).
    if b"%PDF" not in pdf_bytes[:1024]:
        ctype = pdf_resp.headers.get("Content-Type", "?")
        log.info("  Not a PDF (Content-Type=%s, no %%PDF header) — rejecting: %s",
                 ctype, pdf_url)
        return "failed", {"status": "failed", "url": pdf_url,
                          "reason": "not_a_pdf", "bargaining_unit": unit}

    file_hash   = common.sha256_bytes(pdf_bytes)
    storage_key = f"il/cba/{file_hash}.pdf"

    # Per-district dedup: skip re-storing the same file for the same district.
    if _hash_already_stored(cur, district_id, file_hash):
        log.info("  Duplicate (hash already stored for district) — skipping download")
        return "skip", {"status": "skip", "url": pdf_url, "file_hash": file_hash,
                        "reason": "duplicate", "bargaining_unit": unit}

    IL_CBA_DATA_DIR.mkdir(parents=True, exist_ok=True)
    local_path = IL_CBA_DATA_DIR / f"{file_hash}.pdf"
    with open(local_path, "wb") as f:
        f.write(pdf_bytes)
    log.info("  Saved locally: %s  (%.1f KB)", local_path.name, len(pdf_bytes) / 1024)

    stored_key = common.upload_to_object_storage(local_path, storage_key)
    log.info("  Stored: %s", stored_key)

    doc_id = _upsert_source_document(cur, district_id, pdf_url, file_hash, stored_key, unit)
    conn.commit()
    log.info("  source_documents id=%s  unit=%s", doc_id, unit)

    return "found", {"status": "found", "url": pdf_url, "found_via": found_via,
                     "bargaining_unit": unit, "storage_key": stored_key,
                     "file_hash": file_hash, "doc_id": str(doc_id)}


# ---------------------------------------------------------------------------
# Main crawl loop
# ---------------------------------------------------------------------------

def crawl(dry_run: bool = False, limit: Optional[int] = None,
          target_rcdts: Optional[str] = None,
          search_fallback: bool = False):
    conn = common.get_db_conn()

    # Always-on Serper discovery: when a Serper key is present, enable
    # search-engine discovery even without the explicit --search-fallback flag,
    # so the ~194 IL districts with no website_url are still covered and failed
    # homepage crawls get a search retry.
    if not search_fallback and os.environ.get("SERPER_API_KEY", "").strip():
        log.info("SERPER_API_KEY present — enabling Serper-first search discovery (always-on)")
        search_fallback = True

    _ensure_website_urls(conn)

    districts = _load_districts(conn)
    url_district_count = len(districts)
    no_url_count = _count_il_no_url(conn)

    # When search is enabled, also process the no-URL districts via search-engine
    # discovery (a homepage crawl is impossible without a URL). Known-URL
    # districts keep the cheap homepage crawl first and only fall back to search
    # on failure; no-URL districts go straight to search.
    if search_fallback:
        all_no_url = _load_il_no_url_districts(conn)
        # Synthesise minimal district dicts (no website_url) compatible with the crawl loop
        synth = [
            {
                "id":                d["id"],
                "name":              d["name"],
                "state_district_id": d["state_district_id"],
                "website_url":       None,
                "county":            None,
                "enrollment":        None,
                "latest_to_year":    None,
            }
            for d in all_no_url
        ]
        if synth:
            log.info(
                "Including %d no-URL IL district(s) for search-engine discovery",
                len(synth),
            )
        districts = districts + synth

    if target_rcdts:
        districts = [d for d in districts if d["state_district_id"] == target_rcdts]
        if not districts:
            log.error("District with RCDTS %s not found (or has no website URL without --search-fallback)", target_rcdts)
            sys.exit(1)

    log.info(
        "IL CBA crawler starting: %d districts "
        "(dry_run=%s, limit=%s, search_fallback=%s)",
        len(districts), dry_run, limit, search_fallback,
    )

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
        skip_statuses = {"found", "skip"}
        # When running with --search-fallback, also skip districts whose
        # search fallback already ran and failed (to preserve quota).
        if search_fallback:
            skip_statuses.add("search_failed")
        if prev.get("status") in skip_statuses:
            log.info("[SKIP] %s (%s) — already %s", name, rcdts, prev["status"])
            skipped += 1
            continue

        if limit is not None and attempted >= limit:
            log.info("Limit of %d reached — stopping", limit)
            break

        log.info("[ATTEMPT] %s (%s) → %s", name, rcdts, homepage or "(no URL — search-fallback only)")
        attempted += 1

        candidates: list[dict] = []
        if homepage:
            # Per-district watchdog: SIGALRM fires if a district hangs > DISTRICT_TIMEOUT secs.
            signal.signal(signal.SIGALRM, _district_timeout_handler)
            signal.alarm(DISTRICT_TIMEOUT)
            try:
                candidates = _crawl_district(session, homepage, dry_run)
            except TimeoutError:
                signal.alarm(0)
                log.warning("  [TIMEOUT] %s exceeded %ds — skipping", name, DISTRICT_TIMEOUT)
                failed += 1
                state["per_district"][rcdts] = {
                    "status":    "failed",
                    "reason":    "timeout",
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                _save_crawl_state(state)
                continue
            finally:
                signal.alarm(0)

        if not candidates and search_fallback:
            log.info("  %s — trying search-engine fallback",
                     "Direct crawl failed" if homepage else "No website URL")
            candidates = _search_fallback(dist, session)

        if not candidates:
            failed += 1
            # Use "search_failed" when search fallback also ran and found nothing,
            # so subsequent runs with --search-fallback don't repeat the query.
            fail_status = "search_failed" if search_fallback else "failed"
            state["per_district"][rcdts] = {
                "status":    fail_status,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            _save_crawl_state(state)
            continue

        # Multi-unit: a district may expose separate CBAs (teachers, support
        # staff, custodial, etc.). Download/store each, tracking per-unit state.
        units_state: dict[str, dict] = {}
        any_found = False
        any_failed = False
        for cand in candidates:
            status, info = _store_candidate(
                cur, conn, session, dist_id, cand, homepage, dry_run,
            )
            info["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            unit = info.get("bargaining_unit", "teachers")
            # If the same unit appears more than once, prefer a 'found' entry.
            prev_u = units_state.get(unit)
            if prev_u is None or (prev_u.get("status") != "found" and status == "found"):
                units_state[unit] = info
            if status == "found":
                any_found = True
            elif status == "failed":
                any_failed = True

        if any_found:
            found += 1
            overall = "found"
        elif any_failed:
            failed += 1
            overall = "failed"
        else:
            skipped += 1
            overall = "skip"

        found_via_overall = next(
            (u.get("found_via") for u in units_state.values()
             if u.get("status") == "found"),
            "direct_crawl",
        )
        state["per_district"][rcdts] = {
            "status":    overall,
            "found_via": found_via_overall,
            "units":     units_state,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _save_crawl_state(state)

    # Update aggregate counters
    all_statuses = [v["status"] for v in state["per_district"].values()]
    state["il_attempted"]      = sum(1 for s in all_statuses if s in ("found", "failed", "search_failed"))
    state["il_found"]          = sum(1 for s in all_statuses if s == "found")
    state["il_failed"]         = sum(1 for s in all_statuses if s in ("failed", "search_failed"))
    state["il_skipped"]        = sum(1 for s in all_statuses if s in ("skip",))
    # Break out search-fallback stats for visibility
    all_entries = list(state["per_district"].values())
    state["il_found_via_search"] = sum(
        1 for e in all_entries
        if e.get("status") == "found"
        and str(e.get("found_via", "")).startswith("search_fallback")
    )
    state["il_search_failed"]  = sum(1 for s in all_statuses if s == "search_failed")
    _save_crawl_state(state)

    # Write unfound CSV
    if not dry_run:
        unfound_n = _write_unfound_csv(conn)
    else:
        unfound_n = len(districts) - found

    cur.close()
    conn.close()

    total_districts = len(districts)
    pct = (found / total_districts * 100) if total_districts > 0 else 0.0
    search_found = state.get("il_found_via_search", 0)
    search_fail  = state.get("il_search_failed", 0)

    print(f"\n{'='*65}")
    print(f"IL CBA Crawl Results{'  [DRY RUN]' if dry_run else ''}")
    print(f"{'='*65}")
    print(f"  Districts with website URL:  {url_district_count:>6,}")
    print(f"  Districts without URL:       {no_url_count:>6,}")
    print(f"  Attempted this run:          {attempted:>6,}")
    print(f"  PDFs found/downloaded:       {found:>6,}  ({pct:.1f}%)")
    if search_fallback:
        print(f"    via search fallback:       {search_found:>6,}")
    print(f"  Failed / no PDF found:       {failed:>6,}")
    if search_fallback and search_fail:
        print(f"    incl. search also failed:  {search_fail:>6,}")
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
    parser.add_argument(
        "--search-fallback", action="store_true",
        help=(
            "After a direct crawl fails, issue a search-engine query to find "
            "the CBA PDF.  Uses Google Custom Search API if GOOGLE_CSE_API_KEY "
            "and GOOGLE_CSE_CX env vars are set; otherwise uses DuckDuckGo "
            "HTML search (no API key required).  Quota errors are handled "
            "gracefully and the failed status is recorded so the district is "
            "not retried on subsequent runs."
        ),
    )
    args = parser.parse_args()
    crawl(
        dry_run=args.dry_run,
        limit=args.limit,
        target_rcdts=args.district,
        search_fallback=args.search_fallback,
    )
