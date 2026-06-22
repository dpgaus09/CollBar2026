#!/usr/bin/env python3
"""
find_cba_urls.py  —  Locate the hosting URL of each Illinois district's CBA.

WHY THIS EXISTS
---------------
CollBar's crawler sits at ~43% find rate. The failures cluster into three
patterns that a slug-guessing / nav-scraping crawler structurally cannot catch,
all of which were confirmed by hand:

  1. UNION-HOSTED CBAs. A large share of IL teacher contracts live on the
     *local union's* site, not the district's. IFT/AFT locals publish at
     <localnum>.il.aft.org/files/article_assets/<hash>.pdf ; IEA locals publish
     on ieanea.org-affiliated or standalone local sites. A district-domain-only
     crawler will never see these. (Confirmed: Champaign CUSD 4.)

  2. CMS FILE-HANDLER URLs. Direct PDFs often sit behind opaque handlers:
     Blackboard/Finalsite  /site/handlers/filedownload.ashx?...dataid=...
     SchoolDesk/Edlio       /common/pages/DisplayFile.aspx?itemId=...
     WordPress              /wp-content/uploads/YYYY/MM/<name>.pdf
     These have no guessable slug. (Confirmed: Bloomington SD 87.)

  3. NON-STANDARD SLUGS. e.g. Alton's /collective-bargaining-agreement-red
     ("Redbird" mascot suffix). Pattern lists of common slugs miss these.

THE WINNING METHOD (what this script does, per district):
  Stage A  Search-engine query restricted to the district domain.
  Stage B  Open search-engine query (no domain restriction) to catch
           union-hosted copies (il.aft.org, ieanea, etc.).
  Stage C  Direct-probe a ranked list of common CBA paths on the domain
           (cheap HEAD/GET) as a last resort.
  Each candidate is scored; the best is written out with a host_type label.

This is the part that must run on YOUR infrastructure: it makes live HTTP
requests to ~450 district + union websites and to a search API. Wire in your
search backend below (Google Programmable Search / Bing / Serper / SerpAPI).

USAGE
-----
  pip install requests beautifulsoup4
  export SEARCH_API_KEY=...        # and SEARCH_CX=... for Google PSE
  python find_cba_urls.py il_cba_unfound.csv il_cba_found.csv
"""

from __future__ import annotations
import csv, os, re, sys, time, urllib.parse
from dataclasses import dataclass, field
from typing import Optional

import requests
from bs4 import BeautifulSoup

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
SEARCH_API_KEY = os.environ.get("SEARCH_API_KEY", "")
SEARCH_CX      = os.environ.get("SEARCH_CX", "")        # Google PSE engine id
REQUEST_TIMEOUT = 15
POLITE_DELAY    = 1.0       # seconds between districts (be a good citizen)
UA = "CollBar-CBA-Discovery/1.0 (+research; contact: you@collbar.com)"

CBA_TERMS = [
    "collective bargaining agreement", "negotiated agreement",
    "master contract", "teacher contract", "education association agreement",
]

# Phrases that, if present in URL or anchor text, strongly indicate a CBA doc.
POSITIVE_URL_HINTS = [
    "collective-bargaining", "collective_bargaining", "bargaining-agreement",
    "negotiated-agreement", "negotiated_agreement", "master-contract",
    "cba", "-cea-", "-bea-", "-ea-agreement", "teacher-contract",
]
# CMS handler signatures -> these are real docs even with opaque query strings.
HANDLER_SIGNATURES = [
    "filedownload.ashx", "displayfile.aspx", "/wp-content/uploads/",
    "downloadfile", "documentid=", "dataid=",
]
# Known union-host signatures (Stage B gold).
UNION_HOST_SIGNATURES = ["il.aft.org", "ieanea.org", "ift-aft.org", ".nea.org"]

# Common district CBA paths to probe in Stage C (ordered by observed frequency).
COMMON_PATHS = [
    "/collective-bargaining-agreement",
    "/collective-bargaining-agreements",
    "/finance/collective-bargaining-agreement",
    "/business-services/collective-bargaining-agreement",
    "/departments/human-resources",
    "/our-district/foia-request",
    "/district/transparency",
    "/about/transparency",
    "/human-resources/collective-bargaining-agreements",
    "/board-of-education/collective-bargaining-agreement",
]

NEGATIVE_DOMAINS = (  # never count these as the district's CBA host
    "scribd.com", "nctq.org", "elrb.illinois.gov", "ilga.gov",
    "nea.org/sites", "afge.org", "ecs.org", "fordhaminstitute.org",
    "mackinac.org", "washingtonea.org", "nh.gov", "sheltonschools.org",
)


@dataclass
class Candidate:
    url: str
    host_type: str          # district_pdf | district_page | union_pdf | district_landing
    score: int = 0
    note: str = ""


# --------------------------------------------------------------------------
# Search backend  —  REPLACE search() with your provider.
# --------------------------------------------------------------------------
def search(query: str, num: int = 8) -> list[str]:
    """Return a list of result URLs for `query`.

    Default implementation uses Google Programmable Search Engine (PSE).
    Swap for Serper/SerpAPI/Bing as you prefer; just return list[str] of URLs.
    """
    if not (SEARCH_API_KEY and SEARCH_CX):
        raise RuntimeError("Set SEARCH_API_KEY and SEARCH_CX (or replace search()).")
    r = requests.get(
        "https://www.googleapis.com/customsearch/v1",
        params={"key": SEARCH_API_KEY, "cx": SEARCH_CX, "q": query, "num": min(num, 10)},
        timeout=REQUEST_TIMEOUT, headers={"User-Agent": UA},
    )
    r.raise_for_status()
    return [item["link"] for item in r.json().get("items", [])]


# --------------------------------------------------------------------------
# Scoring / classification
# --------------------------------------------------------------------------
def domain_of(url: str) -> str:
    return urllib.parse.urlparse(url).netloc.lower().lstrip("www.")


def classify_and_score(url: str, district_domain: str) -> Optional[Candidate]:
    u = url.lower()
    if any(bad in u for bad in NEGATIVE_DOMAINS):
        return None

    is_pdf      = u.endswith(".pdf") or any(h in u for h in HANDLER_SIGNATURES)
    on_district = district_domain in u
    is_union    = any(s in u for s in UNION_HOST_SIGNATURES)
    has_hint    = any(h in u for h in POSITIVE_URL_HINTS)

    if not (on_district or is_union):
        return None

    score = 0
    score += 40 if is_pdf else 0
    score += 25 if has_hint else 0
    score += 20 if on_district else 0
    score += 15 if is_union else 0     # union copy is valid and often the only one

    if is_union and is_pdf:
        htype, note = "union_pdf", "Union-hosted (district-domain crawler blind spot)."
    elif on_district and is_pdf:
        htype, note = "district_pdf", "Direct district PDF (may be a CMS handler URL)."
    elif on_district:
        htype, note = "district_page", "District page; fetch to extract embedded PDF link."
    else:
        htype, note = "district_landing", "Landing/index page."
    return Candidate(url=url, host_type=htype, score=score, note=note)


def best_candidate(urls: list[str], district_domain: str) -> Optional[Candidate]:
    cands = [c for c in (classify_and_score(u, district_domain) for u in urls) if c]
    if not cands:
        return None
    return max(cands, key=lambda c: c.score)


# CMS fingerprints whose document lists are JS-injected and thus invisible to a
# static HTML crawl OR to a search index. When detected, the CBA links must be
# pulled via a headless render or the platform's documents API, NOT by parsing
# the served HTML. This is the Elmhurst failure mode (Apptegy).
JS_CMS_FINGERPRINTS = {
    "apptegy":   ["apptegy.net", "5il.co", "thrillshare"],
    "finalsite": ["finalsite.com", "fs-cdn", "composer.finalsite"],
    "blackboard":["blackboard.com", "web-community-manager"],
    "edlio":     ["edlio", "schooldesk"],
}


def detect_js_cms(html: str) -> Optional[str]:
    """Return the CMS name if the page is a JS-rendered platform, else None."""
    h = html.lower()
    for cms, sigs in JS_CMS_FINGERPRINTS.items():
        if any(s in h for s in sigs):
            return cms
    return None


def fetch_html(url: str) -> str:
    try:
        r = requests.get(url, timeout=REQUEST_TIMEOUT, headers={"User-Agent": UA})
        return r.text if r.status_code == 200 else ""
    except requests.RequestException:
        return ""


def extract_cba_links_from_html(html: str, base: str) -> list[str]:
    """Static-HTML extraction: find anchors whose TEXT names a bargaining unit
    even when the URL/text lacks the words 'collective bargaining'. This catches
    'ETC Contract', 'PSRP Contract', 'SEIU Contract', 'BEA Agreement', etc."""
    unit_tokens = re.compile(
        r"\b(contract|agreement|cba|"
        r"ea|cea|bea|cft|etc|psrp|seiu|iea|ift|aft|uea|esp|negotiat)",
        re.I)
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for a in soup.find_all("a", href=True):
        text = a.get_text(" ", strip=True)
        if unit_tokens.search(text) or unit_tokens.search(a["href"]):
            out.append(urllib.parse.urljoin(base, a["href"]))
    return out


def probe(url: str) -> bool:
    """Cheap existence check for Stage C direct probing."""
    try:
        resp = requests.head(url, timeout=REQUEST_TIMEOUT, allow_redirects=True,
                             headers={"User-Agent": UA})
        if resp.status_code == 405:   # some servers reject HEAD
            resp = requests.get(url, timeout=REQUEST_TIMEOUT, stream=True,
                                headers={"User-Agent": UA})
        return resp.status_code == 200
    except requests.RequestException:
        return False


# --------------------------------------------------------------------------
# Per-district pipeline
# --------------------------------------------------------------------------
def find_for_district(name: str, website_url: str) -> Candidate:
    domain = domain_of(website_url) if website_url else ""
    if not domain:
        return Candidate("", "none_found", 0, "No website_url on record.")

    # Stage A: domain-restricted search
    qA = f'{CBA_TERMS[0]} OR "{CBA_TERMS[1]}" filetype:pdf site:{domain}'
    try:
        a = search(qA)
        best = best_candidate(a, domain)
        if best and best.score >= 60:
            return best
    except Exception as e:
        a = []
        sys.stderr.write(f"[A] {name}: {e}\n")

    # Stage B: open search to catch union-hosted copies
    qB = f'"{name}" Illinois collective bargaining agreement teacher contract'
    try:
        b = search(qB)
        best = best_candidate((a + b), domain)
        if best and best.score >= 55:
            return best
    except Exception as e:
        sys.stderr.write(f"[B] {name}: {e}\n")

    # Stage C: fetch likely host pages, extract CBA links by ANCHOR TEXT
    # (catches 'ETC Contract', 'SEIU Contract' etc.), and detect JS-CMS pages.
    base = website_url.rstrip("/")
    for path in COMMON_PATHS:
        url = base + path
        html = fetch_html(url)
        if not html:
            continue

        links = extract_cba_links_from_html(html, url)
        best = best_candidate(links, domain) if links else None
        if best and best.score >= 40:
            best.note = f"Extracted from {path} by anchor text. " + best.note
            return best

        cms = detect_js_cms(html)
        if cms and not links:
            # Document list is JS-injected; static crawl + search index both miss it.
            return Candidate(
                url=url, host_type="district_page", score=35,
                note=(f"{cms.upper()} CMS detected: CBA links are JS-rendered and "
                      f"NOT in served HTML. Route to headless render or {cms} "
                      f"documents API to extract direct PDF hrefs."))

        # Last resort: the path itself exists and looks CBA-ish.
        if probe(url) and any(h in url.lower() for h in POSITIVE_URL_HINTS):
            return Candidate(url, "district_page", 20,
                             "Path exists and matches a CBA slug; verify contents.")

    return Candidate("", "none_found", 0,
                     "Unresolved by A/B/C. Candidate for FOIA or manual review.")


def main(infile: str, outfile: str):
    with open(infile, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    with open(outfile, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["district_name", "cba_url", "host_type", "confidence", "notes"])
        for i, row in enumerate(rows, 1):
            name = row["district_name"].strip()
            site = (row.get("website_url") or "").strip()
            res = find_for_district(name, site)
            confidence = ("high" if res.score >= 70 else
                          "medium" if res.score >= 50 else
                          "low" if res.url else "none")
            w.writerow([name, res.url, res.host_type, confidence, res.note])
            f.flush()
            print(f"[{i}/{len(rows)}] {name:45.45} -> {res.host_type:16} {res.url[:80]}")
            time.sleep(POLITE_DELAY)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python find_cba_urls.py <unfound.csv> <found.csv>")
    main(sys.argv[1], sys.argv[2])
