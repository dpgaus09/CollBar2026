"""Shared utilities for CollBar pipeline scripts."""
import hashlib
import json
import logging
import os
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
