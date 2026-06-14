"""Shared utilities for CollBar pipeline scripts."""
import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path

import psycopg2
import psycopg2.extras

CRAWL_STATE_FILE = Path(__file__).parent / "state" / "crawl_state.json"
DATA_DIR = Path(__file__).parent / "data"
LOG_FORMAT = "%(asctime)s %(levelname)s %(message)s"


def setup_logging(level=logging.INFO):
    logging.basicConfig(level=level, format=LOG_FORMAT)


def get_db_conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable not set")
    return psycopg2.connect(url)


def load_crawl_state() -> dict:
    if CRAWL_STATE_FILE.exists():
        with open(CRAWL_STATE_FILE) as f:
            return json.load(f)
    return {
        "districts_loaded": 0,
        "cba_docs_found": 0,
        "cba_docs_downloaded": 0,
        "cba_docs_skipped": 0,
        "cba_docs_failed": 0,
        "cba_district_matched": 0,
        "cba_district_unmatched": 0,
        "ff_proposals_loaded": 0,
        "ff_page_accessible": False,
        "wage_settlement_downloaded": 0,
        "wage_settlement_failed_urls": [],
        "last_updated": None,
        "downloaded_urls": {},
        "manual_review": [],
        "unmatched_employers": [],
    }


def save_crawl_state(state: dict):
    CRAWL_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state["last_updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(CRAWL_STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


_OBJ_STORAGE_WARNED = False

def upload_to_object_storage(local_path: Path, storage_key: str) -> str:
    """Upload a file to Replit Object Storage. Returns the storage_key (or local: path)."""
    global _OBJ_STORAGE_WARNED
    try:
        from replit.object_storage import Client  # type: ignore
        client = Client()
        with open(local_path, "rb") as f:
            client.upload_from_file(storage_key, f)
        return storage_key
    except ModuleNotFoundError:
        if not _OBJ_STORAGE_WARNED:
            logging.info("Object storage module not available — PDFs stored locally under pipeline/data/cba/")
            _OBJ_STORAGE_WARNED = True
        return f"local:{local_path}"
    except Exception as e:
        logging.warning("Object storage upload failed for %s: %s", storage_key, e)
        return f"local:{local_path}"


BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Bot UA used for HTML catalog page scraping
BOT_UA = "CollBarBot/1.0 (hello@collbar.com; Ohio K-12 CB research)"

HEADERS = {
    "User-Agent": BOT_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# PDF downloads require a browser UA — SERB rejects bot UAs for static PDF paths
PDF_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "application/pdf,*/*",
    "Referer": (
        "https://serb.ohio.gov/wps/portal/gov/serb/"
        "view-document-archive/collective-bargaining-agreements"
    ),
}

POLITE_DELAY = 2.0  # seconds between requests

# ---------------------------------------------------------------------------
# Shared employer → district matching
# ---------------------------------------------------------------------------

# Strip ONLY terminal institutional-type markers.
# Keep type qualifiers (city, local, exempted village, etc.) as part of the
# name because the districts DB stores them (e.g. "Akron City",
# "Ada Exempted Village").
_STRIP_SUFFIXES = [
    " board of education",
    " joint vocational school district",
    " career center",
    " stem school",
    " school district",
    " schools",
    " school",
]


def normalise_employer(name: str) -> str:
    """Normalise a SERB employer name for fuzzy matching against districts.

    Expands common abbreviations and strips trailing institutional markers
    so that e.g. "Adams Co/Ohio Valley Local School District" →
    "adams county ohio valley local" which matches the DB row
    "Adams County Ohio Valley Local".
    """
    n = name.lower().strip()
    n = re.sub(r"\bco\b\.?(?=/)", "county", n)  # "Adams Co/Ohio" → "Adams County/Ohio"
    n = re.sub(r"\bco\b\.?\s+", "county ", n)   # "Adams Co Ohio" → "Adams County Ohio"
    n = n.replace("/", " ")                       # "county/ohio" → "county ohio"
    n = re.sub(r"\bst\b\.?\s+", "saint ", n)     # "St Mary" → "Saint Mary"
    n = re.sub(r"\s+", " ", n).strip()
    for suffix in _STRIP_SUFFIXES:
        if n.endswith(suffix):
            n = n[: -len(suffix)].strip()
            break
    return re.sub(r"[,\.]+$", "", n).strip()


def build_district_index(conn) -> dict:
    """Return {normalised_name: (district_id, original_name)} for OH districts."""
    cur = conn.cursor()
    cur.execute("SELECT id, name FROM districts WHERE state = 'OH'")
    rows = cur.fetchall()
    cur.close()
    return {normalise_employer(name): (int(did), name) for did, name in rows}


def match_employer(
    employer: str,
    dist_index: dict,
    threshold_auto: int = 92,
    threshold_review: int = 80,
) -> tuple:
    """Match an employer name to a district.

    Returns (district_id | None, match_status, matched_name).
    match_status: 'auto' | 'review' | 'unmatched'
    """
    try:
        from rapidfuzz import fuzz, process  # type: ignore
    except ImportError:
        logging.warning("rapidfuzz not installed — falling back to exact match only")
        norm = normalise_employer(employer)
        if norm in dist_index:
            did, orig = dist_index[norm]
            return did, "auto", orig
        return None, "unmatched", ""

    norm = normalise_employer(employer)
    if norm in dist_index:
        did, orig = dist_index[norm]
        return did, "auto", orig

    keys = list(dist_index.keys())
    results = process.extract(norm, keys, scorer=fuzz.token_sort_ratio, limit=1)
    if results:
        best_key, score, _ = results[0]
        did, orig = dist_index[best_key]
        if score >= threshold_auto:
            return did, "auto", orig
        if score >= threshold_review:
            return None, "review", orig
    return None, "unmatched", ""


def polite_get(session, url: str, retries: int = 3, timeout: int = 60,
               headers: dict | None = None, **kwargs):
    """GET with retry/backoff and polite delay. Returns response or None."""
    delay = POLITE_DELAY
    req_headers = headers if headers is not None else HEADERS
    for attempt in range(retries):
        try:
            r = session.get(url, headers=req_headers, timeout=timeout,
                            allow_redirects=True, **kwargs)
            if r.status_code == 429 or r.status_code >= 500:
                wait = delay * (2 ** attempt)
                logging.warning("HTTP %s for %s — waiting %.0fs", r.status_code, url, wait)
                time.sleep(wait)
                continue
            time.sleep(delay)
            return r
        except Exception as e:
            if attempt == retries - 1:
                logging.warning("Request failed after %d retries for %s: %s", retries, url, e)
                return None
            logging.warning("Request error for %s: %s — retrying", url, e)
            time.sleep(delay * (2 ** attempt))
    return None


# ---------------------------------------------------------------------------
# Bargaining-unit classification (shared by crawler + extraction)
# ---------------------------------------------------------------------------
#
# CollBar benchmarks must never mix bargaining units (a teacher % settlement is
# not comparable to a custodian % settlement). Every source document, contract,
# and settlement carries a canonical `bargaining_unit`. This module is the single
# source of truth for mapping noisy free text (filenames, link text, LLM-extracted
# unit_scope strings, union names/affiliations) to that controlled vocabulary.
#
# Kept in sync with the SQL CHECK constraint (db/migrations/0008_*) and the TS
# vocabulary in lib/db/src/schema/bargaining-units.ts.

BARGAINING_UNITS = (
    "teachers",
    "paraprofessionals",
    "custodial_maintenance",
    "transportation",
    "secretarial_clerical",
    "food_service",
    "nurses",
    "administrators",
    "support_staff",
    "other",
)

# Specific, single-category keyword sets. Keep keywords precise to minimise
# cross-category false positives (e.g. avoid bare "aide", which appears in both
# "teacher aide" and "bus aide").
_BU_CATEGORY_KEYWORDS = {
    "paraprofessionals": (
        "paraprofessional", "parapro", "para-professional", "para professional",
        "teacher aide", "teacher's aide", "teachers aide", "teaching assistant",
        "instructional aide", "classroom aide", "educational assistant",
    ),
    "custodial_maintenance": (
        "custodial", "custodian", "maintenance", "groundskeeper", "grounds crew",
        "buildings and grounds", "building and grounds",
    ),
    "transportation": (
        "transportation", "bus driver", "bus drivers", "school bus", "bus aide",
        "bus monitor", "bus mechanic",
    ),
    "secretarial_clerical": (
        "secretary", "secretaries", "secretarial", "clerical", "clerk",
        "office personnel", "office staff", "data processing", "bookkeeper",
        "administrative assistant",
    ),
    "food_service": (
        "food service", "child nutrition", "nutrition services", "cafeteria",
        "lunchroom", "cook", "cooks", "kitchen staff",
    ),
    "nurses": (
        "school nurse", "school nurses", "registered nurse", "rn/lpn",
        "health aide", "nurse", "nurses",
    ),
}

_BU_ADMIN_KEYWORDS = (
    "administrator", "administrators", "administrative", "principal",
    "assistant principal", "superintendent", "supervisor", "dean of students",
    "central office administrator",
)

# Teacher / certificated signals. "certificated" is teacher-specific in IL;
# teacher union affiliations (IEA/IFT/NEA/AFT) also indicate a teacher unit.
_BU_TEACHER_KEYWORDS = (
    "teacher", "teachers", "certificated", "teaching staff", "faculty",
    "instructional staff", "licensed teacher", "education association",
    "federation of teachers", "iea-nea", "ift-aft", " iea ", " ift ",
    " nea ", " aft ",
)

# Broad / mixed non-certified indicators → support_staff (a combined unit).
# Includes non-teacher union affiliations that, on their own, signal a generic
# non-certified bargaining unit.
_BU_SUPPORT_BROAD_KEYWORDS = (
    "educational support personnel", "education support personnel", " esp ",
    "(esp)", "support staff", "support personnel", "support employees",
    "classified", "non-certificated", "noncertificated", "non-certified",
    "noncertified", "non-teaching", "nonteaching", "non-instructional",
    "noninstructional", "non-professional", "auxiliary personnel",
    "seiu", "afscme", "teamster", "operating engineers", "iuoe",
)


def _bu_normalize(text) -> str:
    """Lowercase + pad with spaces so word-boundary tokens like ' iea ' match."""
    if not text:
        return ""
    import re as _re
    s = str(text).lower()
    s = s.replace("_", " ").replace("/", " / ").replace("-", "-")
    s = _re.sub(r"\s+", " ", s).strip()
    return f" {s} "


def classify_bargaining_unit(*parts, default: str = "other") -> str:
    """Map free-text signals to a canonical bargaining unit.

    Pass any combination of filename, link text, LLM unit_scope, union name and
    affiliation. Returns one of ``BARGAINING_UNITS``; returns ``default`` when no
    signal is found. This is a *hint* at crawl time and is overridden by the
    extraction LLM when it reads document content with strong evidence.

    Precedence (first satisfied wins):
      1. Broad/combined non-certified language with 0 or >1 specific categories
         → ``support_staff``.
      2. Multiple distinct specific non-cert categories → ``support_staff``.
      3. Exactly one specific non-cert category → that category (but a teacher
         CBA that merely mentions aides/nurses in passing stays ``teachers``).
      4. Administrators-only → ``administrators``.
      5. Teacher/certificated signal → ``teachers``.
      6. Otherwise → ``default``.
    """
    s = " ".join(_bu_normalize(p) for p in parts if p)
    if not s.strip():
        return default

    hits = {
        unit
        for unit, kws in _BU_CATEGORY_KEYWORDS.items()
        if any(kw in s for kw in kws)
    }
    teacher = any(kw in s for kw in _BU_TEACHER_KEYWORDS)
    admin = any(kw in s for kw in _BU_ADMIN_KEYWORDS)
    broad = any(kw in s for kw in _BU_SUPPORT_BROAD_KEYWORDS)

    noncert = sorted(hits)  # specific non-certified categories (incl. nurses)

    # 1 & 2 — combined / mixed non-certified unit.
    if broad and len(noncert) != 1:
        return "support_staff"
    if len(noncert) > 1:
        return "support_staff"

    # 3 — exactly one specific non-cert category.
    if len(noncert) == 1:
        only = noncert[0]
        # A teacher CBA may mention nurses/aides; teacher language wins unless
        # the doc is explicitly a combined non-cert unit (handled above).
        if teacher and not broad:
            return "teachers"
        return only

    # 4 — administrators (only when not a teacher unit).
    if admin and not teacher:
        return "administrators"

    # 5 — teacher / certificated.
    if teacher:
        return "teachers"

    # 6 — broad with zero categories already returned support_staff above.
    return default
