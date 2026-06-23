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
import shutil
import signal
import sys
import time
from datetime import date, datetime
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urljoin, urlparse
from xml.etree import ElementTree as ET

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

# --- Discovery boosts (sitemap / JS-render / on-page docs) -----------------
IL_MANUAL_REVIEW_CSV  = common.DATA_DIR / "il_cba_manual_review.csv"
IL_CBA_CRAWL_BASELINE = Path(__file__).parent / "state" / "il_cba_crawl.baseline.json"

# Sitemap discovery
SITEMAP_PATHS          = ("/sitemap.xml", "/sitemap_index.xml")
SITEMAP_MAX_CHILD_MAPS = 10   # follow at most N child sitemaps from an index
SITEMAP_MAX_PAGES      = 20   # seed at most N keyword-matched pages per district
SITEMAP_KEYWORDS = (
    "collective-bargaining", "collectivebargaining", "collective_bargaining",
    "bargaining", "negotiated", "negotiation", "cba", "labor", "union",
    "agreement", "contract", "human-resources", "humanresources", "/hr/",
    "board-policy", "boardpolicy", "board-of-education", "personnel",
    "employment", "master-agreement",
)

# Broadened on-page document discovery: tokens that suggest a link points to a
# downloadable document even without a .pdf extension.
DOC_PATTERN_TOKENS = (
    "pdf", "document", "fileviewer", "documenttrack", "showdocument",
    "getfile", "download", "/assets/", "/media/", "/uploads/", "/files/",
    "/documents/", "/resource", "/cms/lib", "/cdn/",
)
DOC_ID_RE = re.compile(r"(?:/|=)(\d{4,})(?:[/?&.#]|$)")

# Embedded-viewer hosts. Some resolve to a direct download; others can't be
# resolved programmatically and are logged for manual review instead.
VIEWER_MANUAL_HOSTS = (
    "app.box.com", "box.com", "issuu.com", "scribd.com",
    "anyflip.com", "flipsnack.com", "yumpu.com",
)

# JS rendering (Playwright + Nix chromium)
RENDER_CAP_PER_DISTRICT = 3      # max Playwright renders per district
RENDER_NETWORKIDLE_MS   = 5000   # wait_for_load_state('networkidle') budget
RENDER_GOTO_MS          = 15000  # page.goto timeout

# HTML-contract fallback: capture rendered page text as the "source document"
# only when the page very likely *is* the agreement (no downloadable doc found).
HTML_CONTRACT_MIN_CHARS    = 6000
HTML_CONTRACT_MIN_ARTICLES = 3


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
    # NOTE: "board policy" deliberately omitted. It pulled in IASB PRESS
    # board-policy manuals (which share contract vocabulary but are not union
    # contracts) and added little CBA signal. Board pages are still reached via
    # NAV_KEYWORDS ("board of education", "school board"); a true CBA linked
    # from such a page is matched on its own contract keywords.
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

# Per-run document-verification cache (URL -> bool) to bound ranged-GET volume.
_verify_cache: dict[str, bool] = {}

# Domains that required JS rendering (persisted to crawl state so later runs go
# straight to the browser). Loaded at crawl() start, mutated during crawling.
_render_domains: set[str] = set()

# Accumulated manual-review items (unresolvable embedded viewers) for CSV output.
_manual_review: list[dict] = []

# When True, log EVERY embedded viewer/doc-host file to the manual-review CSV,
# not just those whose link text carries a CBA keyword. The content-aware
# recovery step (13_recover_viewer_cbas.py) downloads and classifies each one,
# so casting this wider net is safe: agendas/minutes are rejected by content,
# only genuine CBAs are stored. Opt-in via --log-all-viewers (default off so
# routine crawls keep the keyword-gated, near-empty CSV described in
# .agents/memory/il-viewer-recovery.md).
LOG_ALL_VIEWERS: bool = False

# District currently being crawled — used to attribute manual-review viewer rows
# back to a district (name/rcdts) so the recovery step (13_recover_viewer_cbas.py)
# and human reviewers can act on il_cba_manual_review.csv.
_current_district: dict = {}

# Lazy Playwright singleton — one headless Chromium reused across districts.
_pw = None
_browser = None
_render_disabled = False


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
# Broadened on-page document discovery (Task #72)
# ---------------------------------------------------------------------------

def _is_pdf_url(abs_url: str, href: str = "") -> bool:
    """True when a URL/href looks like a PDF (extension before any query)."""
    return ".pdf" in (abs_url or "").lower().split("?")[0] or ".pdf" in (href or "").lower()


def _resolve_viewer(url: str) -> tuple[Optional[str], bool]:
    """Resolve an embedded-viewer URL to a direct document download.

    Returns (download_url_or_None, is_viewer). When is_viewer is True but the
    download URL is None, the caller logs it for manual review.
    """
    try:
        parts = urlparse(url)
    except Exception:
        return None, False
    host = parts.netloc.lower()
    if host.startswith("www."):
        host = host[4:]

    # Google Drive: /file/d/<id>/..., open?id=<id>, uc?id=<id>
    if "drive.google.com" in host:
        m = re.search(r"/file/d/([A-Za-z0-9_-]+)", parts.path)
        fid = m.group(1) if m else parse_qs(parts.query).get("id", [None])[0]
        if fid:
            return f"https://drive.google.com/uc?export=download&id={fid}", True
        return None, True

    # Google Docs viewer: docs.google.com/viewer?url=<encoded>
    if "docs.google.com" in host:
        target = parse_qs(parts.query).get("url", [None])[0]
        return (target, True) if target else (None, True)

    if any(host == h or host.endswith("." + h) for h in VIEWER_MANUAL_HOSTS):
        return None, True

    return None, False


def _manual_review_row(url: str, page: str, text: str, reason: str) -> dict:
    """Build a manual-review CSV row, attributing it to the current district.

    The host column lets the recovery step (13_recover_viewer_cbas.py) and human
    reviewers group/sort by viewer platform; district/rcdts let it write a proper
    source_documents row without re-deriving the district from the page host.
    """
    host = ""
    try:
        host = urlparse(url).netloc.lower()
        if host.startswith("www."):
            host = host[4:]
    except Exception:
        pass
    return {
        "url":      url,
        "page":     page,
        "host":     host,
        "district": _current_district.get("name", ""),
        "rcdts":    _current_district.get("rcdts", ""),
        "text":     (text or "")[:120],
        "reason":   reason,
    }


def _extract_document_candidates(soup, base_url: str, homepage: str) -> list[dict]:
    """Broadened on-page document discovery.

    Returns candidate dicts with keys: url, text, score, disc, off_domain,
    needs_verify. ``disc`` is 'pdf_link' for a plain same-domain .pdf link
    (handled exactly as before — the download-time %PDF check is its
    verification) or 'onpage' for a broadened match (extensionless / doc-id
    link, embedded viewer, iframe/embed src, or onclick/data-* attribute).
    Unresolvable embedded viewers are appended to the module-level
    ``_manual_review`` list instead of being returned as candidates.

    found_via attribution is assigned by the caller (it depends on whether the
    page was JS-rendered and how it was reached); this function only sets ``disc``.
    """
    out: list[dict] = []
    seen: set[str] = set()

    def _add(abs_url, text, disc):
        if not abs_url or abs_url in seen:
            return
        if not abs_url.startswith(("http://", "https://")):
            return
        score = _score_pdf_text(f"{text} {abs_url}")
        if score <= 0:
            return
        same = _same_domain(homepage, abs_url) if homepage else False
        if disc == "pdf_link":
            if not same:        # plain .pdf links stay on-domain (original rule)
                return
            out.append({"url": abs_url, "text": text, "score": score,
                        "disc": "pdf_link", "off_domain": False, "needs_verify": False})
        else:
            out.append({"url": abs_url, "text": text, "score": score,
                        "disc": "onpage", "off_domain": not same, "needs_verify": True})
        seen.add(abs_url)

    # 1. Anchor links
    for a in soup.find_all("a", href=True):
        href = a.get("href", "").strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        abs_url = urljoin(base_url, href)
        text = a.get_text(" ", strip=True)
        if _is_pdf_url(abs_url, href):
            _add(abs_url, text, "pdf_link")
            continue
        resolved, is_viewer = _resolve_viewer(abs_url)
        if is_viewer:
            kw = _score_pdf_text(f"{text} {href}")
            if resolved and kw > 0:
                _add(resolved, text, "onpage")
            elif resolved and LOG_ALL_VIEWERS:
                # Resolvable but no link-text CBA signal — log the resolved
                # download URL so the content-aware recovery step can fetch and
                # classify it (instead of silently dropping a possible CBA).
                _manual_review.append(_manual_review_row(
                    resolved, base_url, text, "viewer_unflagged"))
            elif kw > 0:
                _manual_review.append(_manual_review_row(
                    abs_url, base_url, text, "viewer_unresolved"))
            elif LOG_ALL_VIEWERS:
                _manual_review.append(_manual_review_row(
                    abs_url, base_url, text, "viewer_unflagged"))
            continue
        hl = f"{href} {abs_url}".lower()
        if any(tok in hl for tok in DOC_PATTERN_TOKENS) or DOC_ID_RE.search(urlparse(abs_url).path):
            _add(abs_url, text, "onpage")

    # 2. iframe / embed src (often a viewer or a direct PDF)
    for tag in soup.find_all(("iframe", "embed")):
        src = (tag.get("src") or "").strip()
        if not src:
            continue
        abs_url = urljoin(base_url, src)
        ctx = tag.get("title") or tag.get("name") or ""
        resolved, is_viewer = _resolve_viewer(abs_url)
        if is_viewer and resolved:
            if _score_pdf_text(f"{ctx} {src}") > 0:
                _add(resolved, ctx, "onpage")
            elif LOG_ALL_VIEWERS:
                _manual_review.append(_manual_review_row(
                    resolved, base_url, str(ctx), "viewer_unflagged"))
        elif is_viewer:
            _manual_review.append(_manual_review_row(
                abs_url, base_url, str(ctx), "viewer_iframe_unresolved"))
        elif _is_pdf_url(abs_url, src) or any(tok in abs_url.lower() for tok in DOC_PATTERN_TOKENS):
            _add(abs_url, ctx, "onpage")

    # 3. onclick / data-* attributes (window.open('/files/x.pdf'), data-href, ...)
    for tag in soup.find_all(True):
        for attr in ("data-href", "data-url", "data-file", "data-document", "onclick"):
            val = tag.get(attr)
            if not val:
                continue
            m = re.search(r"https?://[^\s'\"()]+", val)
            cand = m.group(0) if m else None
            if not cand:
                m2 = re.search(r"['\"](/[^\s'\"()]+)['\"]", val)
                cand = urljoin(base_url, m2.group(1)) if m2 else None
            if not cand:
                continue
            text = tag.get_text(" ", strip=True)[:120]
            if _is_pdf_url(cand, cand) or any(tok in cand.lower() for tok in DOC_PATTERN_TOKENS):
                _add(cand, text, "onpage")

    return out


def _verify_pdf(session: requests.Session, url: str) -> bool:
    """Ranged GET (first 1KB) to confirm a candidate is really a PDF.

    Used for broadened/off-domain document candidates before counting them as
    found. Requires an application/pdf Content-Type OR a %PDF magic header in
    the first bytes. Results cached per-URL for the run.
    """
    if url in _verify_cache:
        return _verify_cache[url]
    ok = False
    try:
        _polite_wait(url)
        r = session.get(
            url,
            headers={"User-Agent": BROWSER_UA, "Accept": "application/pdf,*/*",
                     "Range": "bytes=0-1023"},
            timeout=REQUEST_TIMEOUT, allow_redirects=True, stream=True,
        )
        if r.status_code in (200, 206):
            ctype = r.headers.get("Content-Type", "").lower()
            head = b""
            try:
                for chunk in r.iter_content(chunk_size=1024):
                    head = chunk or b""
                    break
            except Exception:
                head = b""
            ok = ("application/pdf" in ctype) or (b"%PDF" in head[:1024])
        r.close()
    except Exception as e:
        log.debug("  verify_pdf error for %s: %s", url, e)
        ok = False
    _verify_cache[url] = ok
    return ok


def _discover_sitemap_pages(session: requests.Session, homepage: str) -> list[str]:
    """Fetch and parse the district's sitemap(s); return keyword-matched pages.

    Tries /sitemap.xml and /sitemap_index.xml, follows a sitemap index one level
    deep (capped), and returns same-domain URLs whose path matches a CBA/HR
    keyword. Fails silently (returns []) so it never blocks the crawl.
    """
    try:
        parts = urlparse(homepage)
        base = f"{parts.scheme}://{parts.netloc}"
    except Exception:
        return []

    def _read(url):
        r = _fetch(session, url)
        if r is None or not r.ok:
            return None
        return r.text

    def _parse(text):
        try:
            root = ET.fromstring(text.encode("utf-8", "ignore"))
        except Exception:
            return None, []
        rtag = root.tag.rsplit("}", 1)[-1].lower()
        locs = [el.text.strip() for el in root.iter()
                if el.tag.rsplit("}", 1)[-1].lower() == "loc" and el.text]
        return rtag, locs

    page_locs: list[str] = []
    children: list[str] = []
    for sm in (base + p for p in SITEMAP_PATHS):
        text = _read(sm)
        if not text:
            continue
        rtag, locs = _parse(text)
        if rtag == "sitemapindex":
            children.extend(locs)
        else:
            page_locs.extend(locs)

    for child in children[:SITEMAP_MAX_CHILD_MAPS]:
        text = _read(child)
        if not text:
            continue
        _, locs = _parse(text)
        page_locs.extend(locs)

    out: list[str] = []
    seen: set[str] = set()
    for u in page_locs:
        if u in seen or not u.startswith(("http://", "https://")):
            continue
        seen.add(u)
        if not _same_domain(homepage, u):
            continue
        if any(kw in u.lower() for kw in SITEMAP_KEYWORDS):
            out.append(u)
        if len(out) >= SITEMAP_MAX_PAGES:
            break
    return out


# ---------------------------------------------------------------------------
# JS rendering (Playwright + Nix chromium)
# ---------------------------------------------------------------------------

def _get_browser():
    """Lazily launch a single headless Chromium (Nix) and reuse it.

    Returns the browser, or None when Playwright/Chromium is unavailable (in
    which case JS rendering is disabled for the rest of the run).
    """
    global _pw, _browser, _render_disabled
    if _render_disabled:
        return None
    if _browser is not None:
        return _browser
    exe = shutil.which("chromium") or shutil.which("chromium-browser")
    if not exe:
        log.warning("  JS-render unavailable: no chromium on PATH — skipping renders")
        _render_disabled = True
        return None
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        log.warning("  JS-render unavailable: playwright import failed (%s)", e)
        _render_disabled = True
        return None
    try:
        _pw = sync_playwright().start()
        _browser = _pw.chromium.launch(
            executable_path=exe, headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        )
        log.info("  JS-render: launched headless Chromium (%s)", exe)
    except Exception as e:
        log.warning("  JS-render unavailable: chromium launch failed (%s)", e)
        _render_disabled = True
        _browser = None
        try:
            if _pw:
                _pw.stop()
        except Exception:
            pass
        _pw = None
    return _browser


def _render_html(url: str) -> Optional[str]:
    """Fetch a page with headless Chromium and return rendered HTML (or None)."""
    browser = _get_browser()
    if browser is None:
        return None
    ctx = None
    try:
        _polite_wait(url)
        ctx = browser.new_context(user_agent=IL_CBA_BOT_UA)
        page = ctx.new_page()
        page.set_default_timeout(RENDER_GOTO_MS)
        page.goto(url, wait_until="domcontentloaded", timeout=RENDER_GOTO_MS)
        try:
            page.wait_for_load_state("networkidle", timeout=RENDER_NETWORKIDLE_MS)
        except Exception:
            pass  # SPA/long-poll keeps the network busy — use the current DOM
        return page.content()
    except Exception as e:
        log.info("  JS-render failed for %s: %s", url, str(e)[:120])
        return None
    finally:
        if ctx is not None:
            try:
                ctx.close()
            except Exception:
                pass


def _close_browser():
    global _pw, _browser
    try:
        if _browser is not None:
            _browser.close()
    except Exception:
        pass
    try:
        if _pw is not None:
            _pw.stop()
    except Exception:
        pass
    _browser = None
    _pw = None


def _consider_html_fallback(current: Optional[dict], soup, page_url: str,
                            rendered: bool) -> Optional[dict]:
    """Return the better of ``current`` and this page as an HTML-contract source.

    Conservative: the page must read like an actual agreement (length, repeated
    ARTICLE headers, an "agreement" mention, and salary/wage terms), not merely
    mention bargaining. Returns ``current`` unchanged when this page doesn't
    qualify or doesn't beat the incumbent.
    """
    try:
        text = soup.get_text(" ", strip=True)
    except Exception:
        return current
    if len(text) < HTML_CONTRACT_MIN_CHARS:
        return current
    tl = text.lower()
    if len(re.findall(r"\barticle\s+[ivxlc\d]", tl)) < HTML_CONTRACT_MIN_ARTICLES:
        return current
    if "agreement" not in tl:
        return current
    if not any(k in tl for k in ("salary", "wages", "compensation", "schedule", "stipend")):
        return current
    score = _score_text(text)
    if score <= 0:
        return current
    if current is not None and current.get("score", 0) >= score:
        return current
    return {
        "url": page_url,
        "text": text,
        "score": score,
        "source_type": "html_contract",
        "found_via": "html_contract",
        "source_page": page_url,
        "disc": "html",
        "off_domain": False,
        "needs_verify": False,
        "verified_pdf": False,
        "bargaining_unit": _classify_candidate(page_url, text[:2000]),
    }


def _coverage_stats(per_district: dict) -> dict:
    """Summarise a per_district map into found total + counts by found_via."""
    by_via: dict[str, int] = {}
    found = 0
    for e in per_district.values():
        if e.get("status") != "found":
            continue
        found += 1
        v = str(e.get("found_via", "direct_crawl"))
        key = "search" if v.startswith("search_fallback") else v
        by_via[key] = by_via.get(key, 0) + 1
    return {"found": found, "by_via": by_via}


def _write_manual_review_csv() -> int:
    """Write accumulated manual-review viewer URLs to CSV. Returns row count."""
    if not _manual_review:
        return 0
    IL_MANUAL_REVIEW_CSV.parent.mkdir(parents=True, exist_ok=True)
    seen: set = set()
    rows: list[dict] = []
    for it in _manual_review:
        k = (it.get("url"), it.get("page"))
        if k in seen:
            continue
        seen.add(k)
        rows.append(it)
    fields = ["url", "host", "district", "rcdts", "page", "text", "reason"]
    with open(IL_MANUAL_REVIEW_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for it in rows:
            w.writerow({k: it.get(k, "") for k in fields})
    return len(rows)


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
    domain = urlparse(homepage).netloc.lower()
    if domain.startswith("www."):
        domain = domain[4:]
    render_budget = [RENDER_CAP_PER_DISTRICT]

    def _maybe_render(url, static_soup, html_lower):
        """Return rendered soup when the static page shows zero signal and a
        render is available/budgeted; else None."""
        if render_budget[0] <= 0 or _render_disabled:
            return None
        if static_soup is not None:
            links = _extract_links(static_soup, url)
            scored = any(l["score"] > 0 or l["nav_score"] > 0 for l in links)
            if scored or ".pdf" in html_lower:
                return None
        rendered = _render_html(url)
        render_budget[0] -= 1
        if rendered:
            _render_domains.add(domain)
            return BeautifulSoup(rendered, "html.parser")
        return None

    def _collect_docs(soup, page_url, page_via, rendered):
        """Extract + verify document candidates from a page, tagging provenance.

        found_via precedence: js_render > onpage > sitemap > direct_crawl — we
        attribute each doc to the most specific capability that rescued it.
        """
        kept = []
        for c in _extract_document_candidates(soup, page_url, homepage):
            if c.get("needs_verify"):
                if not _verify_pdf(session, c["url"]):
                    continue
                c["verified_pdf"] = True
            if rendered:
                c["found_via"] = "js_render"
            elif c["disc"] == "onpage":
                c["found_via"] = "onpage"
            elif page_via == "sitemap":
                c["found_via"] = "sitemap"
            else:
                c["found_via"] = "direct_crawl"
            c["source_page"] = page_url
            kept.append(c)
        return kept

    pdf_candidates: list[dict] = []
    html_fallback: Optional[dict] = None

    # ----- Homepage (prefer JS render if this domain needed it before) -----
    log.info("  Fetching homepage: %s", homepage)
    soup0 = None
    final_url = homepage
    rendered0 = False
    if domain in _render_domains and not _render_disabled and render_budget[0] > 0:
        rhtml = _render_html(homepage)
        render_budget[0] -= 1
        if rhtml:
            soup0 = BeautifulSoup(rhtml, "html.parser")
            rendered0 = True
    if soup0 is None:
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
        final_url = r.url
        soup0 = BeautifulSoup(html, "html.parser")
        rsoup = _maybe_render(final_url, soup0, html.lower())
        if rsoup is not None:
            log.info("  Homepage had zero signal — re-fetched with JS render")
            soup0 = rsoup
            rendered0 = True

    # Documents directly on the homepage (provenance-tagged)
    pdf_candidates.extend(_collect_docs(soup0, final_url, "direct_crawl", rendered0))
    html_fallback = _consider_html_fallback(html_fallback, soup0, final_url, rendered0)

    # Collect internal links to follow: strict CBA matches first, then broader
    # navigation links (Board, Human Resources, Staff, Documents, etc.) that may
    # lead to CBA pages even when they don't mention CBA directly.
    all_links = _extract_links(soup0, final_url)
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

    # Sitemap-seeded pages (new): keyword-matched CBA/HR pages from the sitemap.
    sitemap_pages = _discover_sitemap_pages(session, homepage)

    log.info("  Homepage: %d doc candidates, %d links (%d CBA + %d nav), %d sitemap page(s)",
             len(pdf_candidates), len(top_links), len(cba_links), len(nav_links),
             len(sitemap_pages))

    visited = {final_url, homepage}

    # Follow top links + sitemap pages (up to MAX_HOPS deep). Each queue item
    # carries its provenance `via` so docs found there are attributed correctly.
    queue = [(lnk["url"], lnk["text"], 1, "direct_crawl") for lnk in top_links]
    queue += [(u, "sitemap", 1, "sitemap") for u in sitemap_pages if u not in visited]
    while queue:
        link_url, link_text, depth, via = queue.pop(0)
        if link_url in visited:
            continue
        if depth > MAX_HOPS:
            continue
        if not _same_domain(homepage, link_url):
            continue
        visited.add(link_url)

        log.info("  Hop %d [%s]: %s  [%s]", depth, via, link_url, link_text[:50])
        r2 = _fetch(session, link_url)
        if r2 is None or not r2.ok:
            continue

        ct2 = r2.headers.get("Content-Type", "")
        if "text/html" not in ct2 and "xhtml" not in ct2:
            if "application/pdf" in ct2:
                # Direct PDF link we followed
                score = _score_pdf_text(link_url + " " + link_text)
                if score > 0:
                    fv = "sitemap" if via == "sitemap" else "direct_crawl"
                    pdf_candidates.append({"url": link_url, "text": link_text,
                                           "score": score, "disc": "pdf_link",
                                           "off_domain": False, "needs_verify": False,
                                           "found_via": fv, "source_page": link_url})
            continue

        html2 = r2.text
        if _looks_like_login(r2.url, html2):
            continue

        soup2 = BeautifulSoup(html2, "html.parser")
        rendered2 = False
        rsoup2 = _maybe_render(r2.url, soup2, html2.lower())
        if rsoup2 is not None:
            soup2 = rsoup2
            rendered2 = True

        new_pdfs = _collect_docs(soup2, r2.url, via, rendered2)
        pdf_candidates.extend(new_pdfs)
        html_fallback = _consider_html_fallback(html_fallback, soup2, r2.url, rendered2)
        log.info("    Found %d doc candidate(s) on hop page%s", len(new_pdfs),
                 " (rendered)" if rendered2 else "")

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

            queue.extend([(l["url"], l["text"], 2, via) for l in cba_sub + nav_sub])

    if not pdf_candidates:
        if html_fallback is not None:
            log.info("  No downloadable doc — capturing HTML-contract text from %s",
                     html_fallback["url"])
            return [html_fallback]
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
    # Atomic write: dump to a per-process temp file then os.replace() into place.
    # The normal crawl and the --recheck-expiring mode may run concurrently and
    # both write this JSON; a plain open("w") could interleave and leave a
    # corrupt file, which _load_crawl_state() would silently discard — wiping all
    # crawl progress. os.replace() is atomic on POSIX, so a reader always sees a
    # complete file (worst case last-writer-wins, which self-heals next run).
    IL_CBA_CRAWL_STATE.parent.mkdir(parents=True, exist_ok=True)
    state["last_updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp = IL_CBA_CRAWL_STATE.parent / f"{IL_CBA_CRAWL_STATE.name}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, IL_CBA_CRAWL_STATE)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _upsert_source_document(cur, district_id: int, source_url: str,
                            file_hash: str, storage_key: str,
                            bargaining_unit: str = "teachers",
                            source_type: str = "pdf") -> Optional[int]:
    cur.execute(
        """
        INSERT INTO source_documents
            (district_id, doc_type, source_url, file_hash, storage_key,
             bargaining_unit, source_type)
        VALUES (%s, 'cba_pdf', %s, %s, %s, %s, %s)
        ON CONFLICT (source_url, file_hash) DO UPDATE SET
            district_id     = COALESCE(EXCLUDED.district_id, source_documents.district_id),
            storage_key     = COALESCE(EXCLUDED.storage_key, source_documents.storage_key),
            bargaining_unit = EXCLUDED.bargaining_unit,
            source_type     = EXCLUDED.source_type
        RETURNING id
        """,
        (district_id, source_url, file_hash, storage_key, bargaining_unit, source_type),
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


def _load_expiring_current_contracts(conn, window_days: int,
                                     target_rcdts: Optional[str] = None) -> list[dict]:
    """Current contract per (district, bargaining unit, unit scope) whose term
    has ended or ends within ``window_days`` days, paired with the saved source
    URL to re-fetch.

    "Current" = the contract with the most recent ``effective_start`` for that
    district+unit+scope (matching the contracts uniqueness key, so a district
    that bargains the same unit across multiple scopes has each scope's current
    contract re-checked). Contracts with an unknown (NULL) ``effective_end`` are excluded:
    we only re-check when we can actually see the term is expiring/expired, so
    districts that are well within term — or whose end date we don't know — are
    left alone (no wasted fetches, no churn). Rows without a saved ``source_url``
    can't be re-fetched and are likewise excluded.
    """
    cur = conn.cursor()
    params: list = []
    rcdts_filter = ""
    if target_rcdts:
        rcdts_filter = "AND d.state_district_id = %s"
        params.append(target_rcdts)
    params.append(window_days)
    cur.execute(f"""
        WITH ranked AS (
            SELECT c.district_id, c.bargaining_unit, c.unit_scope,
                   c.effective_start, c.effective_end, c.source_doc_id,
                   sd.source_url, sd.source_type,
                   d.state_district_id, d.name AS district_name, d.website_url,
                   ROW_NUMBER() OVER (
                       PARTITION BY c.district_id, c.bargaining_unit, c.unit_scope
                       ORDER BY c.effective_start DESC NULLS LAST, c.id DESC
                   ) AS rn
            FROM contracts c
            JOIN districts d ON d.id = c.district_id
            LEFT JOIN source_documents sd ON sd.id = c.source_doc_id
            WHERE d.state = 'IL' {rcdts_filter}
        )
        SELECT district_id, state_district_id, district_name, website_url,
               bargaining_unit, unit_scope, effective_start, effective_end,
               source_doc_id, source_url, source_type
        FROM ranked
        WHERE rn = 1
          AND effective_end IS NOT NULL
          AND effective_end <= CURRENT_DATE + make_interval(days => %s)
          AND source_url IS NOT NULL
        ORDER BY effective_end ASC, district_name
    """, params)
    cols = ["district_id", "state_district_id", "district_name", "website_url",
            "bargaining_unit", "unit_scope", "effective_start", "effective_end",
            "source_doc_id", "source_url", "source_type"]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close()
    return rows


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
# Content guard — reject non-contract PDFs before they pollute the corpus
# ---------------------------------------------------------------------------

# Detail prefixes that mean "we could not actually READ the document" (no
# embedded text layer, corrupt PDF, or an extractor error). A scanned real CBA
# is indistinguishable from scanned junk without OCR — too slow to run mid-crawl
# — so docs with these outcomes are KEPT and left for downstream OCR extraction
# and the stored-doc audit to resolve. We only reject docs we could READ.
_CONTENT_INCONCLUSIVE_PREFIXES = ("insufficient_text", "unreadable", "classify_error")

_classifier_mod = None


def _get_classifier():
    """Lazily load 13_recover_viewer_cbas.py for its accurate content classifier.

    Loaded on first use (importlib) so a plain import of this crawler stays cheap
    and so the two modules can reference each other without an import-time cycle
    (13 already lazy-loads this module for its keyword score).
    """
    global _classifier_mod
    if _classifier_mod is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "recover_viewer_cbas",
            Path(__file__).parent / "13_recover_viewer_cbas.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _classifier_mod = mod
    return _classifier_mod


def _reject_non_cba_content(pdf_bytes: bytes) -> tuple[bool, str]:
    """Decide whether a downloaded PDF should be rejected as a non-contract.

    Returns (reject, detail). The link keyword-score that surfaces candidates is
    noisy — handbooks, board agendas and policy manuals score highly — so before
    storing a PDF as ``cba_pdf`` we run the same content classifier the audit and
    viewer-recovery use (text layer only, no OCR, to keep the crawl fast).

    reject is True ONLY when the text layer was readable AND the classifier
    judged it a confident non-contract. Unreadable / scanned / too-short PDFs
    come back inconclusive and are KEPT, so we never newly false-reject a scanned
    real CBA.
    """
    try:
        is_cba, detail = _get_classifier().classify_cba_bytes(pdf_bytes, use_ocr=False)
    except Exception as e:  # noqa: BLE001 — the gate must never crash a crawl
        log.debug("  content classifier unavailable (%s) — keeping PDF", e)
        return False, f"classify_unavailable ({e})"
    if is_cba or detail.startswith(_CONTENT_INCONCLUSIVE_PREFIXES):
        return False, detail
    return True, detail


# ---------------------------------------------------------------------------
# Download + store a single classified PDF candidate
# ---------------------------------------------------------------------------

def _store_html_contract(cur, conn, district_id, candidate, dry_run):
    """Store an HTML-contract page's extracted text as a source_document.

    The full agreement is published as a web page (no downloadable file), so we
    persist the page text (.txt) to object storage and record it with
    source_type='html_contract' for the extractor to read directly.
    """
    page_url = candidate["url"]
    unit     = candidate.get("bargaining_unit", "teachers")
    text     = candidate.get("text", "") or ""

    if dry_run:
        log.info("[DRY-RUN] Would capture HTML contract [%s]: %s (%d chars)",
                 unit, page_url, len(text))
        return "found", {"status": "found", "url": page_url,
                         "found_via": "html_contract", "bargaining_unit": unit,
                         "source_type": "html_contract", "dry_run": True}

    payload = text.encode("utf-8", "ignore")
    file_hash   = common.sha256_bytes(payload)
    storage_key = f"il/cba/{file_hash}.txt"

    if _hash_already_stored(cur, district_id, file_hash):
        log.info("  Duplicate HTML contract (hash already stored) — skipping")
        return "skip", {"status": "skip", "url": page_url, "file_hash": file_hash,
                        "reason": "duplicate", "bargaining_unit": unit,
                        "source_type": "html_contract"}

    IL_CBA_DATA_DIR.mkdir(parents=True, exist_ok=True)
    local_path = IL_CBA_DATA_DIR / f"{file_hash}.txt"
    with open(local_path, "w", encoding="utf-8") as f:
        f.write(text)
    log.info("  Saved HTML-contract text: %s  (%.1f KB)",
             local_path.name, len(payload) / 1024)

    stored_key = common.upload_to_object_storage(local_path, storage_key)
    doc_id = _upsert_source_document(cur, district_id, page_url, file_hash,
                                     stored_key, unit, source_type="html_contract")
    conn.commit()
    log.info("  source_documents id=%s  unit=%s  (html_contract)", doc_id, unit)

    return "found", {"status": "found", "url": page_url, "found_via": "html_contract",
                     "bargaining_unit": unit, "storage_key": stored_key,
                     "file_hash": file_hash, "doc_id": str(doc_id),
                     "source_type": "html_contract"}


def _store_candidate(cur, conn, session, district_id, candidate, homepage, dry_run):
    """Download, store, and insert one classified PDF candidate.

    Returns (status, info) where status is 'found' | 'failed' | 'skip' and
    info is a per-unit state dict (always carries 'bargaining_unit' and
    'status').
    """
    pdf_url   = candidate["url"]
    unit      = candidate.get("bargaining_unit", "teachers")
    found_via = candidate.get("found_via", "direct_crawl")

    # HTML-contract pages have no downloadable file — store their text instead.
    if candidate.get("source_type") == "html_contract":
        return _store_html_contract(cur, conn, district_id, candidate, dry_run)

    # Final domain guard (defense-in-depth). Off-domain candidates are allowed
    # only when they came from a vetted path: search-fallback (the search engine
    # vetted them) or a broadened on-page / JS-render discovery that we then
    # confirmed with a ranged %PDF check. Unverified direct-crawl candidates must
    # stay on the district's own domain.
    off_domain = bool(homepage) and not _same_domain(homepage, pdf_url)
    verified_pdf = bool(candidate.get("verified_pdf"))
    if off_domain and found_via == "direct_crawl" and not verified_pdf:
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

    # Content guard (Task #89): the link keyword-score that surfaced this
    # candidate is noisy — handbooks, board agendas and policy manuals score
    # highly and used to be stored as cba_pdf, polluting the contract corpus.
    # Run the accurate content classifier on the PDF's actual text BEFORE saving
    # it to disk/object storage or upserting. Only confidently-readable
    # non-contracts are rejected; scanned/unreadable PDFs are kept (a scanned
    # real CBA is indistinguishable until OCR, which is too slow mid-crawl). A
    # rejection returns "failed" so a district with only junk stays in the retry
    # pool instead of being marked resolved.
    reject, cdetail = _reject_non_cba_content(pdf_bytes)
    if reject:
        log.info("  Rejected as non-CBA content [%s] — not storing: %s", cdetail, pdf_url)
        return "failed", {"status": "failed", "url": pdf_url, "file_hash": file_hash,
                          "reason": "not_cba_content", "bargaining_unit": unit,
                          "classify_detail": cdetail}

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
          search_fallback: bool = False,
          retry_failed: bool = False):
    global _render_domains, _manual_review, _verify_cache
    _manual_review = []
    _verify_cache = {}
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

    # Load the render-domain cache so domains that needed JS rendering before go
    # straight to the browser this run.
    _render_domains = set(state.get("render_domains", []))

    # Snapshot the pre-run found counts (by method) for the before/after report.
    baseline_stats = _coverage_stats(state["per_district"])

    # --retry-failed: re-attempt districts previously marked failed/search_failed
    # (which now benefit from sitemap discovery, JS rendering, and broadened
    # on-page discovery). Snapshot the current state as a one-time baseline first.
    if retry_failed:
        if not IL_CBA_CRAWL_BASELINE.exists():
            IL_CBA_CRAWL_BASELINE.parent.mkdir(parents=True, exist_ok=True)
            if IL_CBA_CRAWL_STATE.exists():
                shutil.copyfile(IL_CBA_CRAWL_STATE, IL_CBA_CRAWL_BASELINE)
                log.info("Saved crawl-state baseline → %s", IL_CBA_CRAWL_BASELINE.name)
        cleared = [r for r, e in state["per_district"].items()
                   if e.get("status") in ("failed", "search_failed")]
        for r in cleared:
            del state["per_district"][r]
        log.info("--retry-failed: cleared %d failed/search_failed district(s) for retry",
                 len(cleared))

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
        global _current_district
        _current_district = {"name": name, "rcdts": rcdts, "homepage": homepage}

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

    # Per-method found counters (new capabilities) for visibility.
    after_stats = _coverage_stats(state["per_district"])
    for method in ("sitemap", "js_render", "onpage", "html_contract"):
        state[f"il_found_via_{method}"] = after_stats["by_via"].get(method, 0)

    # Persist the render-domain cache so future runs skip straight to rendering.
    state["render_domains"] = sorted(_render_domains)
    _save_crawl_state(state)

    # Write unfound CSV
    if not dry_run:
        unfound_n = _write_unfound_csv(conn)
    else:
        unfound_n = len(districts) - found

    # Manual-review CSV (unresolvable embedded viewers — Box/Issuu/Drive folders).
    manual_n = 0 if dry_run else _write_manual_review_csv()

    # Close the headless browser (if one was launched).
    _close_browser()

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
        print(f"  Manual-review CSV:           {manual_n:>6,} rows")
    print(f"{'='*65}")

    # Before/after coverage by discovery method (cumulative found totals).
    print("  Cumulative found by method (before → after this run):")
    methods = ["direct_crawl", "sitemap", "js_render", "onpage",
               "html_contract", "search"]
    seen_methods = set(methods) | set(baseline_stats["by_via"]) | set(after_stats["by_via"])
    for m in methods + sorted(seen_methods - set(methods)):
        b = baseline_stats["by_via"].get(m, 0)
        a = after_stats["by_via"].get(m, 0)
        if b == 0 and a == 0:
            continue
        arrow = f"  (+{a - b})" if a != b else ""
        print(f"    {m:<16} {b:>5,} → {a:>5,}{arrow}")
    print(f"    {'TOTAL':<16} {baseline_stats['found']:>5,} → {after_stats['found']:>5,}"
          f"  (+{after_stats['found'] - baseline_stats['found']})")
    print(f"{'='*65}\n")


# ---------------------------------------------------------------------------
# Re-check expiring contracts
# ---------------------------------------------------------------------------

def _record_recheck(state: dict, rcdts: str, unit: str, outcome: str,
                    row: dict, ts: str):
    """Record a per-(unit, scope) re-check outcome in the crawl state for
    observability, without disturbing the district's existing crawl status."""
    entry = state["per_district"].get(rcdts)
    if entry is None:
        # The district has a stored contract, so 'found' is the accurate status.
        entry = {"status": "found"}
        state["per_district"][rcdts] = entry
    rc = entry.setdefault("recheck", {})
    # Key by unit AND scope: a district may bargain the same unit across multiple
    # scopes, each with its own current contract, so a unit-only key would let one
    # scope's outcome clobber another's.
    scope = row.get("unit_scope") or "default"
    rc[f"{unit}::{scope}"] = {
        "outcome":            outcome,
        "unit_scope":         row.get("unit_scope"),
        "effective_end_seen": str(row.get("effective_end")),
        "checked_at":         ts,
    }
    entry["last_rechecked"] = ts


def _is_expired(effective_end) -> bool:
    """True if a contract's term has already ended (strictly before today).

    The re-check window includes contracts that expire *soon* (within
    window_days); the re-discovery fallback only fires for ones that have
    actually lapsed, since a successor is only expected once the term is over.
    """
    if effective_end is None:
        return False
    d = effective_end
    if isinstance(d, datetime):
        d = d.date()
    try:
        return d < date.today()
    except TypeError:
        return False


def _rediscover_for_expired(cur, conn, session, row: dict,
                            search_fallback: bool, dry_run: bool) -> int:
    """Re-run the existing per-district discovery for an expired district whose
    saved URL yielded no newer deal, to catch a successor agreement that was
    posted at a NEW URL (the saved-URL re-fetch can't see it).

    Reuses ``_crawl_district`` (and, when ``search_fallback`` is set,
    ``_search_fallback``) exactly as the normal crawl does, then runs every
    candidate through ``_store_candidate``. A relocated/changed file is stored
    as a new ``source_document`` (and the extraction step ingests it as a new
    contract version); a file identical to one already stored is dropped by the
    per-district hash dedup, so re-finding the old URL causes no churn.

    Returns the number of new versions stored.
    """
    rcdts    = row["state_district_id"]
    name     = row["district_name"]
    homepage = row.get("website_url")
    dist_id  = row["district_id"]

    dist = {
        "id":                dist_id,
        "name":              name,
        "website_url":       homepage,
        "state_district_id": rcdts,
    }

    candidates: list[dict] = []
    if homepage:
        # Same per-district watchdog the normal crawl uses, so a hung district
        # can't stall the whole re-check run.
        signal.signal(signal.SIGALRM, _district_timeout_handler)
        signal.alarm(DISTRICT_TIMEOUT)
        try:
            candidates = _crawl_district(session, homepage, dry_run)
        except TimeoutError:
            log.warning("  [REDISCOVER] %s exceeded %ds — skipping", name, DISTRICT_TIMEOUT)
            return 0
        finally:
            signal.alarm(0)

    if not candidates and search_fallback:
        log.info("  [REDISCOVER] %s — trying search-engine fallback",
                 "direct crawl found nothing" if homepage else "no website URL")
        candidates = _search_fallback(dist, session)

    if not candidates:
        log.info("  [REDISCOVER] no candidates found for %s", name)
        return 0

    new_versions = 0
    for cand in candidates:
        status, info = _store_candidate(
            cur, conn, session, dist_id, cand, homepage, dry_run,
        )
        if status == "found" and info.get("dry_run"):
            log.info("  [REDISCOVER] [DRY-RUN] would store: %s", cand.get("url"))
        elif status == "found":
            new_versions += 1
            log.info("  [REDISCOVER] -> NEW version stored (doc_id=%s) via %s",
                     info.get("doc_id"), cand.get("found_via", "?"))
        elif status == "skip":
            log.info("  [REDISCOVER] candidate unchanged/duplicate: %s", cand.get("url"))
        else:
            log.info("  [REDISCOVER] candidate failed (%s): %s",
                     info.get("reason", "?"), cand.get("url"))
    return new_versions


def recheck_expiring(window_days: int = 90, dry_run: bool = False,
                     target_rcdts: Optional[str] = None,
                     limit: Optional[int] = None,
                     rediscover: bool = False,
                     search_fallback: bool = False):
    """Re-fetch the saved source URL of districts whose CURRENT contract is
    expiring/expired, to pick up a newly-posted successor agreement.

    Efficient policy (per product decision): only districts whose current
    contract term has ended or ends within ``window_days`` are re-checked, and we
    re-download the exact saved URL rather than re-running full discovery. If the
    URL now serves a different file (new content hash) it is stored as a new
    ``source_document`` and the normal extraction step ingests it as a new
    contract version; if the bytes are unchanged nothing is stored (no churn).
    Districts well within term, with an unknown end date, or with no saved URL
    are skipped entirely.

    Re-discovery fallback (``rediscover=True``, off by default to preserve the
    efficient policy): when the saved URL yields "unchanged" or "failed" for a
    district whose contract has *already expired*, fall back to the existing
    per-district discovery (``_crawl_district``, and ``_search_fallback`` when
    ``search_fallback=True``) so a successor agreement posted at a NEW URL is
    still found. Any newly discovered file flows through the same store ->
    extraction path as a new contract version.
    """
    global _current_district
    conn = common.get_db_conn()
    rows = _load_expiring_current_contracts(conn, window_days, target_rcdts)
    log.info(
        "IL CBA re-check starting: %d expiring/expired current contract(s) "
        "(window=%d days, dry_run=%s)",
        len(rows), window_days, dry_run,
    )

    state = _load_crawl_state()
    session = requests.Session()
    cur = conn.cursor()

    def _ts() -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    checked = new_versions = unchanged = failed = skipped_html = 0
    rediscover_attempted = rediscover_new = 0

    for row in rows:
        if limit is not None and checked >= limit:
            log.info("Re-check limit of %d reached — stopping", limit)
            break

        rcdts   = row["state_district_id"]
        name    = row["district_name"]
        unit    = row["bargaining_unit"]
        url     = row["source_url"]
        dist_id = row["district_id"]
        src_type = row["source_type"] or "pdf"
        _current_district = {"name": name, "rcdts": rcdts,
                             "homepage": row.get("website_url")}

        log.info("[RECHECK] %s (%s) unit=%s ends %s → %s",
                 name, rcdts, unit, row["effective_end"], url)
        checked += 1

        # HTML-contract pages would need full page-text re-capture; that path is
        # not supported here (none exist among current expiring contracts).
        if src_type == "html_contract":
            log.info("  Skipping html_contract re-check (page re-capture not supported)")
            skipped_html += 1
            _record_recheck(state, rcdts, unit, "skipped_html", row, _ts())
            continue

        cand = {"url": url, "bargaining_unit": unit, "found_via": "recheck_expiring"}
        # homepage=None: the saved URL was already vetted when first stored, so we
        # deliberately skip the same-domain guard (some districts host PDFs
        # off-domain). _store_candidate still verifies %PDF, rejects non-CBA
        # content, and skips re-storing an unchanged file (per-district hash dedup).
        status, info = _store_candidate(cur, conn, session, dist_id, cand, None, dry_run)

        if status == "found" and info.get("dry_run"):
            outcome = "dry_run"
        elif status == "found":
            new_versions += 1
            outcome = "new_version"
            log.info("  -> NEW version stored (doc_id=%s) — extraction will ingest it",
                     info.get("doc_id"))
        elif status == "skip":
            unchanged += 1
            outcome = "unchanged"
            log.info("  -> unchanged (same file still posted)")
        else:
            failed += 1
            outcome = "failed"
            log.info("  -> re-fetch failed (%s)", info.get("reason", "?"))

        _record_recheck(state, rcdts, unit, outcome, row, _ts())

        # Re-discovery fallback: the saved URL only catches in-place replacements.
        # When it had no newer deal ("unchanged"/"failed") AND the contract has
        # already lapsed, re-run discovery to catch a successor posted at a NEW
        # URL. Gated behind --recheck-rediscover so the efficient default stands.
        # (In dry-run the saved-URL fetch reports "dry_run", so allow that too to
        # let users preview what re-discovery would attempt.)
        if (rediscover and _is_expired(row.get("effective_end"))
                and outcome in ("unchanged", "failed", "dry_run")):
            log.info("  [RECHECK] %s expired (%s) with no newer deal at saved URL "
                     "— re-discovering for a relocated successor", name,
                     row.get("effective_end"))
            rediscover_attempted += 1
            rd_new = _rediscover_for_expired(
                cur, conn, session, row, search_fallback, dry_run,
            )
            if rd_new:
                rediscover_new += rd_new
                new_versions += rd_new
                _record_recheck(state, rcdts, unit, "rediscovered_new_version",
                                row, _ts())

    if not dry_run:
        state["il_recheck"] = {
            "window_days":          window_days,
            "checked":              checked,
            "new_versions":         new_versions,
            "unchanged":            unchanged,
            "failed":               failed,
            "skipped_html":         skipped_html,
            "rediscover":           rediscover,
            "rediscover_attempted": rediscover_attempted,
            "rediscover_new":       rediscover_new,
            "ran_at":               _ts(),
        }
        _save_crawl_state(state)

    cur.close()
    conn.close()

    print(f"\n{'='*65}")
    print(f"IL CBA Re-check (expiring contracts){'  [DRY RUN]' if dry_run else ''}")
    print(f"{'='*65}")
    print(f"  Window:                      <= {window_days} days from today")
    print(f"  Expiring/expired checked:    {checked:>6,}")
    print(f"  New versions found:          {new_versions:>6,}")
    print(f"  Unchanged (same file):       {unchanged:>6,}")
    print(f"  Re-fetch failed:             {failed:>6,}")
    if skipped_html:
        print(f"  Skipped (html_contract):     {skipped_html:>6,}")
    if rediscover:
        print(f"  Re-discovery attempted:      {rediscover_attempted:>6,}")
        print(f"  Re-discovery new versions:   {rediscover_new:>6,}")
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
    parser.add_argument(
        "--retry-failed", action="store_true",
        help=(
            "Re-attempt districts previously recorded as failed/search_failed so "
            "they benefit from the new sitemap discovery, JS-render fallback, and "
            "broadened on-page document discovery. Snapshots the current crawl "
            "state to il_cba_crawl.baseline.json once before clearing those rows."
        ),
    )
    parser.add_argument(
        "--log-all-viewers", action="store_true",
        help=(
            "Log EVERY embedded viewer/doc-host file to il_cba_manual_review.csv, "
            "not just those whose link text carries a CBA keyword. Lets the "
            "content-aware recovery step (13_recover_viewer_cbas.py) download and "
            "classify each one so CBAs hidden behind link text like 'Document' are "
            "found, while agendas/minutes are rejected by content. Off by default."
        ),
    )
    parser.add_argument(
        "--recheck-expiring", action="store_true",
        help=(
            "Re-fetch the saved source URL of districts whose CURRENT contract has "
            "expired or expires within --recheck-window-days, to pick up a newly "
            "posted successor agreement. Re-downloads the exact saved URL (not a "
            "full re-discovery); stores it only if the file changed, otherwise "
            "leaves the existing contract untouched. Skips districts well within "
            "term and those with an unknown end date. Does not run the normal "
            "discovery crawl. Respects --district, --limit, and --dry-run."
        ),
    )
    parser.add_argument(
        "--recheck-window-days", type=int, default=90,
        help=(
            "How many days ahead of today counts as 'expiring' for "
            "--recheck-expiring (default 90). Already-expired contracts are always "
            "included."
        ),
    )
    parser.add_argument(
        "--recheck-rediscover", action="store_true",
        help=(
            "With --recheck-expiring: when the saved URL yields no newer deal "
            "('unchanged'/'failed') for a district whose contract has ALREADY "
            "expired, fall back to the normal per-district discovery to catch a "
            "successor posted at a NEW URL. Off by default to preserve the "
            "efficient saved-URL-only policy. Combine with --search-fallback to "
            "also use search-engine discovery in the fallback."
        ),
    )
    args = parser.parse_args()
    LOG_ALL_VIEWERS = args.log_all_viewers
    if args.recheck_expiring:
        if args.recheck_window_days < 0:
            parser.error("--recheck-window-days must be >= 0")
        recheck_expiring(
            window_days=args.recheck_window_days,
            dry_run=args.dry_run,
            target_rcdts=args.district,
            limit=args.limit,
            rediscover=args.recheck_rediscover,
            search_fallback=args.search_fallback,
        )
    else:
        crawl(
            dry_run=args.dry_run,
            limit=args.limit,
            target_rcdts=args.district,
            search_fallback=args.search_fallback,
            retry_failed=args.retry_failed,
        )
