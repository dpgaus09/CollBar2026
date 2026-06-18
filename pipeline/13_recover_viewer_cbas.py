#!/usr/bin/env python3
"""
Recover CBAs stuck behind embedded document viewers.

Some districts publish their collective-bargaining agreement inside an embedded
viewer (Box, Issuu, Scribd, AnyFlip, Flipsnack, Yumpu) or a Google Drive folder
rather than as a plain ``.pdf`` link. The crawler (``11_crawl_il_cbas.py``)
cannot resolve these programmatically during a fast link-scan, so it logs them
to ``data/il_cba_manual_review.csv`` instead of silently dropping them.

This script turns those logged viewer URLs into real ``source_documents`` rows:

  1. Read the manual-review CSV.
  2. Map each row back to a district (via the ``rcdts`` column the crawler now
     writes, or by matching the source ``page`` host to ``districts.website_url``).
  3. Attempt a host-specific resolver to obtain a direct PDF download:
       - Box           ``app.box.com/s/<id>`` / ``/shared/static/...``
       - Google Drive  ``/file/d/<id>``, ``open?id=``, and public folders
       - Issuu         ``reader3.isu.pub`` original-document download (when allowed)
       - Yumpu         ``/document/download/<id>``
       - AnyFlip       book-config ``downloadUrl``
       - Flipsnack     ``/download``
  4. Download, verify the ``%PDF`` header, then **classify the content**: the
     document's text is read (reusing ``06_extract_contracts.py``) and only docs
     that actually look like a collective-bargaining agreement are kept. Board
     agendas, minutes, handbooks, and plans are rejected (status ``not_cba``) so
     casting a wider net at the crawler (``11 --log-all-viewers``) cannot pollute
     the database. Genuine CBAs are deduped by hash, stored in object storage,
     and upserted as a proper ``cba_pdf`` ``source_documents`` row — exactly the
     contract the LLM extractor (``06_extract_contracts.py``) expects.

The content check is ON by default for CSV recovery (disable with
``--no-content-check``); ``--fast`` skips OCR and inspects only the embedded
text layer. Hand-downloaded ``--pdf`` ingests skip the check (human-curated)
unless ``--content-check`` is passed.

Anything a resolver cannot crack is reported as "needs manual download". For
those, download the PDF by hand from the viewer and ingest it directly:

    # Ingest a hand-downloaded PDF for one district:
    python3 pipeline/13_recover_viewer_cbas.py \\
        --pdf /path/to/contract.pdf \\
        --rcdts 19022004002 \\
        --url   https://app.box.com/s/abc123 \\
        --unit  teachers

Usage:
    # Process every row in the manual-review CSV (best-effort auto-resolve):
    python3 pipeline/13_recover_viewer_cbas.py

    # Preview what would happen without writing anything:
    python3 pipeline/13_recover_viewer_cbas.py --dry-run

    # Limit work / restrict to one host or district:
    python3 pipeline/13_recover_viewer_cbas.py --limit 10 --host box.com
    python3 pipeline/13_recover_viewer_cbas.py --rcdts 19022004002

After recovering documents, re-run extraction so the recovered districts produce
contracts:

    python3 pipeline/06_extract_contracts.py --state IL
"""
import argparse
import csv
import logging
import re
import sys
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin, urlparse, parse_qs

import requests

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

MANUAL_REVIEW_CSV = common.DATA_DIR / "il_cba_manual_review.csv"
IL_CBA_DATA_DIR   = common.DATA_DIR / "il_cba"

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT = 45
MIN_PDF_BYTES   = 1024


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _get(session: requests.Session, url: str, *, referer: str = "",
         stream: bool = False) -> Optional[requests.Response]:
    """GET with a browser UA. Returns the response or None on hard failure."""
    headers = {"User-Agent": BROWSER_UA,
               "Accept": "text/html,application/pdf,*/*"}
    if referer:
        headers["Referer"] = referer
    try:
        return session.get(url, headers=headers, timeout=REQUEST_TIMEOUT,
                           allow_redirects=True, stream=stream)
    except Exception as e:  # noqa: BLE001 — best-effort recovery, log and move on
        log.info("  GET failed for %s: %s", url, e)
        return None


def _host_of(url: str) -> str:
    try:
        h = urlparse(url).netloc.lower()
    except Exception:
        return ""
    return h[4:] if h.startswith("www.") else h


# ---------------------------------------------------------------------------
# Content-aware CBA classification
#
# Embedded viewers (Google Drive, Box, Issuu, ...) on district sites mostly host
# board-meeting agendas, minutes, and plans — NOT union contracts. A probe of 80
# high-enrollment IL districts (see .agents/memory/il-viewer-recovery.md) found
# 136 embeds, zero of which were CBAs. To cast a wider net without polluting the
# database, we download each candidate and read its text before storing: only a
# document whose *content* looks like a collective-bargaining agreement is kept
# as a cba_pdf. Board agendas/minutes/handbooks are rejected.
#
# Text extraction reuses 06_extract_contracts.py (pdfplumber/pypdfium2 text layer
# with an OCR fallback for scanned PDFs). Keyword scoring reuses the crawler's
# _score_pdf_text (11_crawl_il_cbas.py) as a supporting positive signal.
# ---------------------------------------------------------------------------

# Title-page phrases that name the document a collective-bargaining agreement.
_CBA_TITLE_PHRASES = (
    "collective bargaining agreement",
    "collective bargaining contract",
    "negotiated agreement",
    "negotiations agreement",
    "master agreement",
    "professional negotiation agreement",
    "professional negotiations agreement",
    "agreement between the board",
    "agreement by and between",
    "articles of agreement",
)

# Body phrases typical of a contract's articles / table of contents. A real CBA
# accumulates many of these; an agenda that merely *mentions* a contract will not.
_CBA_BODY_PHRASES = (
    "grievance",
    "salary schedule",
    "bargaining unit",
    "just cause",
    "duration of this agreement",
    "this agreement shall",
    "sick leave",
    "personal leave",
    "reduction in force",
    "arbitration",
    "education association",
    "federation of teachers",
    "fair share",
    "extra duty",
    "extra-duty",
    "hereinafter",
    "recognition",
    "seniority",
    "tenure",
    "probationary",
    "sabbatical",
    "workday",
    "work year",
    "prep period",
    "retirement",
    "insurance",
    "negotiat",
)

# Phrases that mark a board-meeting agenda or minutes — the documents we must
# reject. These almost never appear in the body of a union contract.
_AGENDA_PHRASES = (
    "call to order",
    "roll call",
    "pledge of allegiance",
    "consent agenda",
    "approval of minutes",
    "approval of the minutes",
    "motion to approve",
    "moved by",
    "seconded by",
    "public participation",
    "public comment",
    "minutes of the",
    "regular meeting",
    "old business",
    "new business",
    "superintendent's report",
    "treasurer's report",
    "board recessed",
    "agenda item",
    "call to the meeting",
    "return to learn",
    "notice of",
)

# How many leading characters of the document to inspect. A CBA's table of
# contents + opening articles (rich in body phrases) fall well within this.
CLASSIFY_TEXT_CHARS = 40_000
MIN_CLASSIFY_CHARS  = 200

_extractor_mod = None
_crawler_mod = None


def _load_pipeline_module(filename: str, modname: str):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        modname, Path(__file__).parent / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _get_extractor():
    """Lazily load 06_extract_contracts.py (text extraction with OCR fallback)."""
    global _extractor_mod
    if _extractor_mod is None:
        _extractor_mod = _load_pipeline_module(
            "06_extract_contracts.py", "extract_contracts")
    return _extractor_mod


def _crawler_keyword_score(text: str) -> int:
    """Reuse the crawler's PDF keyword scoring as a supporting positive signal.

    Best-effort: if the crawler module can't be imported, return 0 so content
    classification still works from the phrase signals alone.
    """
    global _crawler_mod
    try:
        if _crawler_mod is None:
            _crawler_mod = _load_pipeline_module(
                "11_crawl_il_cbas.py", "crawl_il_cbas")
        return _crawler_mod._score_pdf_text(text)
    except Exception as e:  # noqa: BLE001
        log.debug("crawler keyword score unavailable: %s", e)
        return 0


def classify_cba_text(text: str) -> tuple[bool, str]:
    """Classify document text as a CBA (True) or not (False).

    Returns (is_cba, detail). The decision balances three signals:
      - title : explicit "collective bargaining agreement" style title phrases
      - body  : article/TOC phrases a real contract accumulates
      - agenda: board-meeting / minutes phrases that mark a non-contract doc
    plus the crawler's keyword score as supporting evidence. A doc dominated by
    agenda signals with a weak contract body is rejected even if it *mentions* a
    contract (e.g. a board agenda item "approve the collective bargaining
    agreement").
    """
    tl = (text or "").lower()
    if len(tl.strip()) < MIN_CLASSIFY_CHARS:
        return False, f"insufficient_text ({len(tl.strip())} chars)"
    head = tl[:CLASSIFY_TEXT_CHARS]

    title  = sum(1 for p in _CBA_TITLE_PHRASES if p in head)
    body   = sum(1 for p in _CBA_BODY_PHRASES if p in head)
    agenda = sum(1 for p in _AGENDA_PHRASES if p in head)
    kw     = _crawler_keyword_score(head[:8000])

    decision = False
    # Agenda / minutes dominate and the contract body is thin -> reject.
    if agenda >= 4 and body < max(6, agenda):
        decision = False
    elif agenda >= 3 and body <= 2 and title == 0:
        decision = False
    # Rich contract body -> accept.
    elif body >= 6:
        decision = True
    # Titled as an agreement with a real (if shorter) body -> accept.
    elif title >= 1 and body >= 3 and agenda <= 3:
        decision = True
    elif body >= 4 and agenda <= 1:
        decision = True
    # Very strong crawler keyword signal with a real body and no agenda signal —
    # rescues a contract whose exact title/body phrasing we didn't enumerate.
    elif kw >= 8 and body >= 3 and agenda <= 1:
        decision = True

    detail = (f"title={title} body={body} agenda={agenda} kw={kw} "
              f"-> {'CBA' if decision else 'not-CBA'}")
    return decision, detail


def classify_cba_bytes(pdf_bytes: bytes, *, use_ocr: bool = True) -> tuple[bool, str]:
    """Download-ready content check: extract text from PDF bytes and classify.

    use_ocr=True falls back to OCR for scanned/image-only PDFs (slower but
    catches scanned CBAs). use_ocr=False inspects only the embedded text layer
    (fast); scanned docs then classify as "insufficient_text".
    """
    import tempfile
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as fh:
            fh.write(pdf_bytes)
            tmp = Path(fh.name)
        extractor = _get_extractor()
        if use_ocr:
            text, _used_ocr, reason, _conf = extractor.extract_pdf_text(tmp)
            if not text and reason:
                return False, f"unreadable ({reason})"
        else:
            text, readable = extractor._text_layer(tmp)
            if not readable:
                return False, "unreadable (PDF_CORRUPT_OR_UNREADABLE)"
        return classify_cba_text(text)
    except Exception as e:  # noqa: BLE001 — best-effort, never crash recovery
        log.info("  content classification error: %s", e)
        return False, f"classify_error ({e})"
    finally:
        if tmp is not None:
            try:
                tmp.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Host-specific resolvers — each returns a list of candidate direct-download URLs
# (most-likely first). An empty list means "could not resolve; needs manual".
# ---------------------------------------------------------------------------

def resolve_box(url: str, session: requests.Session) -> list[str]:
    """Resolve a Box shared link to a direct file download.

    ``/shared/static/<id>`` URLs are already direct downloads. ``/s/<id>`` and
    ``/embed/s/<id>`` share pages embed the file id + shared name in a JSON
    blob, from which Box's ``box_download_shared_file`` endpoint can be built.
    """
    parts = urlparse(url)
    path = parts.path

    # Already a direct static download.
    if "/shared/static/" in path:
        return [url]

    m = re.search(r"/(?:embed/)?s/([A-Za-z0-9]+)", path)
    if not m:
        return []
    shared_name = m.group(1)
    page_url = f"https://app.box.com/s/{shared_name}"
    r = _get(session, page_url)
    if r is None or not r.ok:
        return []
    html = r.text
    out: list[str] = []

    # 1. Direct static link embedded in the page (cleanest).
    for sm in re.finditer(r'https://[^"\'\\]*\.app\.box\.com/shared/static/[A-Za-z0-9._-]+', html):
        out.append(sm.group(0))
    for sm in re.finditer(r'/shared/static/[A-Za-z0-9._-]+', html):
        out.append(urljoin("https://app.box.com", sm.group(0)))

    # 2. Build the download endpoint from the embedded file id.
    fm = re.search(r'"(?:file_?[Ii]d|itemID|typedID)"\s*:\s*"?(?:f_)?(\d{5,})', html)
    if fm:
        fid = fm.group(1)
        out.append(
            "https://app.box.com/index.php?rm=box_download_shared_file"
            f"&shared_name={shared_name}&file_id=f_{fid}"
        )

    # 3. Any explicit download URL in the page JSON.
    for sm in re.finditer(r'"download_?[Uu]rl"\s*:\s*"([^"]+)"', html):
        out.append(sm.group(1).replace("\\/", "/"))

    # De-dupe, preserve order.
    seen: set[str] = set()
    return [u for u in out if not (u in seen or seen.add(u))]


def resolve_drive(url: str, session: requests.Session) -> list[str]:
    """Resolve a Google Drive file or public folder to direct download URL(s)."""
    parts = urlparse(url)
    # Single file: /file/d/<id> or ?id=<id>
    m = re.search(r"/file/d/([A-Za-z0-9_-]+)", parts.path)
    fid = m.group(1) if m else parse_qs(parts.query).get("id", [None])[0]
    if fid and "/folders/" not in parts.path:
        return [f"https://drive.google.com/uc?export=download&id={fid}"]

    # Public folder: scrape the embedded file-id list.
    fm = re.search(r"/folders/([A-Za-z0-9_-]+)", parts.path)
    folder_id = fm.group(1) if fm else None
    if not folder_id:
        return []
    r = _get(session, f"https://drive.google.com/drive/folders/{folder_id}")
    if r is None or not r.ok:
        return []
    ids: list[str] = []
    seen: set[str] = set()
    # Drive file ids start with an alphanumeric char; Google's inline config
    # tokens (e.g. ``_F_toggles_default_...``) start with ``_`` -- exclude them.
    for fid in re.findall(r'\["([A-Za-z0-9][A-Za-z0-9_-]{24,})"', r.text):
        if fid != folder_id and fid not in seen:
            seen.add(fid)
            ids.append(fid)
    return [f"https://drive.google.com/uc?export=download&id={fid}" for fid in ids]


def resolve_issuu(url: str, session: requests.Session) -> list[str]:
    """Resolve an Issuu document to its original PDF (only when downloadable)."""
    m = re.search(r"issuu\.com/([^/]+)/docs/([^/?#]+)", url)
    if not m:
        return []
    user, doc = m.group(1), m.group(2)
    api = f"https://reader3.isu.pub/{user}/{doc}/reader3_4.json"
    r = _get(session, api, referer="https://issuu.com/")
    if r is None or not r.ok:
        return []
    try:
        data = r.json()
    except Exception:
        return []
    document = data.get("document", data) if isinstance(data, dict) else {}
    if not document.get("downloadable"):
        return []
    pub_id = document.get("publicationId") or document.get("id")
    rev_id = document.get("revisionId")
    out = []
    if pub_id and rev_id:
        out.append(
            f"https://issuu.com/{user}/docs/{doc}/download"
        )
        out.append(
            f"https://document.issuu.com/{pub_id}/original/{rev_id}.pdf"
        )
    out.append(f"https://issuu.com/{user}/docs/{doc}/download")
    seen: set[str] = set()
    return [u for u in out if not (u in seen or seen.add(u))]


def resolve_yumpu(url: str, session: requests.Session) -> list[str]:
    """Resolve a Yumpu document to its download endpoint (when enabled)."""
    m = re.search(r"/document/(?:view|download)/(\d+)", url)
    if not m:
        return []
    doc_id = m.group(1)
    return [f"https://www.yumpu.com/en/document/download/{doc_id}"]


def resolve_anyflip(url: str, session: requests.Session) -> list[str]:
    """Resolve an AnyFlip book to a download URL from its book config."""
    r = _get(session, url)
    if r is None or not r.ok:
        return []
    out = []
    for sm in re.finditer(r'"downloadURL"\s*:\s*"([^"]+\.pdf)"', r.text):
        out.append(sm.group(1).replace("\\/", "/"))
    return out


def resolve_flipsnack(url: str, session: requests.Session) -> list[str]:
    """Best-effort Flipsnack download endpoint."""
    m = re.search(r"flipsnack\.com/[^/]*/([A-Za-z0-9_-]+)\.html", url)
    if not m:
        return []
    return [url.rstrip("/").replace(".html", "") + "/download"]


HOST_RESOLVERS = [
    ("box.com",      resolve_box),
    ("drive.google.com", resolve_drive),
    ("docs.google.com",  resolve_drive),
    ("issuu.com",    resolve_issuu),
    ("yumpu.com",    resolve_yumpu),
    ("anyflip.com",  resolve_anyflip),
    ("flipsnack.com", resolve_flipsnack),
]


def resolve_viewer(url: str, session: requests.Session) -> list[str]:
    """Dispatch to the resolver for the URL's host. [] = unresolvable."""
    host = _host_of(url)
    for needle, fn in HOST_RESOLVERS:
        if host == needle or host.endswith("." + needle):
            try:
                return fn(url, session)
            except Exception as e:  # noqa: BLE001
                log.info("  resolver error (%s): %s", needle, e)
                return []
    return []


# ---------------------------------------------------------------------------
# District mapping
# ---------------------------------------------------------------------------

def _load_district_by_host(conn) -> dict:
    """{normalised_host: (district_id, name)} for IL districts with a website."""
    cur = conn.cursor()
    cur.execute(
        "SELECT id, name, website_url FROM districts "
        "WHERE state='IL' AND website_url IS NOT NULL"
    )
    out: dict[str, tuple] = {}
    for did, name, url in cur.fetchall():
        h = _host_of(url)
        if h and h not in out:
            out[h] = (int(did), name)
    cur.close()
    return out


def _district_by_rcdts(conn, rcdts: str) -> Optional[tuple]:
    cur = conn.cursor()
    cur.execute(
        "SELECT id, name FROM districts WHERE state='IL' AND state_district_id=%s",
        (rcdts,),
    )
    row = cur.fetchone()
    cur.close()
    return (int(row[0]), row[1]) if row else None


def _resolve_district(conn, row: dict, host_index: dict) -> Optional[tuple]:
    """Map a manual-review row to (district_id, name)."""
    rcdts = (row.get("rcdts") or "").strip()
    if rcdts:
        d = _district_by_rcdts(conn, rcdts)
        if d:
            return d
    # Fall back to matching the source page host to a district website.
    for key in ("page", "url"):
        h = _host_of(row.get(key) or "")
        if h in host_index:
            return host_index[h]
    return None


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------

def _hash_already_stored(cur, district_id: int, file_hash: str) -> bool:
    cur.execute(
        "SELECT 1 FROM source_documents "
        "WHERE district_id=%s AND file_hash=%s AND doc_type='cba_pdf'",
        (district_id, file_hash),
    )
    return cur.fetchone() is not None


def _upsert_source_document(cur, district_id: int, source_url: str,
                            file_hash: str, storage_key: str,
                            bargaining_unit: str) -> Optional[int]:
    cur.execute(
        """
        INSERT INTO source_documents
            (district_id, doc_type, source_url, file_hash, storage_key,
             bargaining_unit, source_type)
        VALUES (%s, 'cba_pdf', %s, %s, %s, %s, 'pdf')
        ON CONFLICT (source_url, file_hash) DO UPDATE SET
            district_id     = COALESCE(EXCLUDED.district_id, source_documents.district_id),
            storage_key     = COALESCE(EXCLUDED.storage_key, source_documents.storage_key),
            bargaining_unit = EXCLUDED.bargaining_unit,
            source_type     = EXCLUDED.source_type
        RETURNING id
        """,
        (district_id, source_url, file_hash, storage_key, bargaining_unit),
    )
    r = cur.fetchone()
    return r[0] if r else None


def _ingest_pdf_bytes(conn, district_id: int, source_url: str, pdf_bytes: bytes,
                      bargaining_unit: str, dry_run: bool,
                      content_check: bool = True,
                      use_ocr: bool = True) -> tuple[str, str]:
    """Validate, store, and upsert one PDF. Returns (status, detail).

    When content_check is True (default), the PDF's text is read and classified
    before storing: documents that don't look like a collective-bargaining
    agreement (board agendas, minutes, handbooks, plans) are rejected with
    status 'not_cba' instead of polluting source_documents.
    """
    if len(pdf_bytes) < MIN_PDF_BYTES:
        return "failed", f"too_small ({len(pdf_bytes)} bytes)"
    if b"%PDF" not in pdf_bytes[:1024]:
        return "failed", "not_a_pdf (no %PDF header)"

    if content_check:
        is_cba, detail = classify_cba_bytes(pdf_bytes, use_ocr=use_ocr)
        if not is_cba:
            return "not_cba", detail

    file_hash   = common.sha256_bytes(pdf_bytes)
    storage_key = f"il/cba/{file_hash}.pdf"

    cur = conn.cursor()
    if _hash_already_stored(cur, district_id, file_hash):
        cur.close()
        return "skip", "duplicate (hash already stored for district)"

    if dry_run:
        cur.close()
        return "found", f"[DRY-RUN] would store {len(pdf_bytes)/1024:.0f} KB → {storage_key}"

    IL_CBA_DATA_DIR.mkdir(parents=True, exist_ok=True)
    local_path = IL_CBA_DATA_DIR / f"{file_hash}.pdf"
    local_path.write_bytes(pdf_bytes)
    stored_key = common.upload_to_object_storage(local_path, storage_key)
    doc_id = _upsert_source_document(cur, district_id, source_url, file_hash,
                                     stored_key, bargaining_unit)
    conn.commit()
    cur.close()
    return "found", f"source_documents id={doc_id} ({len(pdf_bytes)/1024:.0f} KB)"


def _download_pdf(session: requests.Session, url: str) -> Optional[bytes]:
    r = _get(session, url, stream=True)
    if r is None or not r.ok:
        return None
    ctype = r.headers.get("Content-Type", "").lower()
    if "html" in ctype:
        # Confirmation interstitial (e.g. Drive virus-scan page) — not a PDF.
        return None
    try:
        data = r.content
    except Exception:
        return None
    if b"%PDF" not in data[:1024]:
        return None
    return data


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _read_csv_rows() -> list[dict]:
    if not MANUAL_REVIEW_CSV.exists():
        log.error("Manual-review CSV not found: %s", MANUAL_REVIEW_CSV)
        log.error("Run the crawler first: python3 pipeline/11_crawl_il_cbas.py --retry-failed")
        return []
    with open(MANUAL_REVIEW_CSV, newline="") as f:
        return list(csv.DictReader(f))


def recover_from_csv(args) -> None:
    conn = common.get_db_conn()
    host_index = _load_district_by_host(conn)
    session = requests.Session()

    rows = _read_csv_rows()
    if args.host:
        rows = [r for r in rows if args.host in _host_of(r.get("url") or "")]
    if args.rcdts:
        rows = [r for r in rows
                if (r.get("rcdts") or "").strip() == args.rcdts]
    if args.limit:
        rows = rows[: args.limit]

    log.info("Processing %d manual-review row(s) from %s",
             len(rows), MANUAL_REVIEW_CSV.name)

    content_check = not args.no_content_check
    use_ocr = not args.fast
    log.info("Content classification: %s%s",
             "ON" if content_check else "OFF (storing every resolved PDF)",
             "" if use_ocr else " (text-layer only, no OCR)")

    stats = {"found": 0, "skip": 0, "failed": 0, "no_district": 0,
             "unresolved": 0, "not_cba": 0}
    manual_needed: list[dict] = []

    for row in rows:
        viewer_url = (row.get("url") or "").strip()
        if not viewer_url:
            continue
        host = _host_of(viewer_url)
        dist = _resolve_district(conn, row, host_index)
        if not dist:
            stats["no_district"] += 1
            log.warning("  [no district] %s (page=%s)", viewer_url, row.get("page"))
            manual_needed.append({**row, "recover_status": "no_district"})
            continue
        district_id, dname = dist
        unit = (row.get("bargaining_unit") or "teachers").strip() or "teachers"

        candidates = resolve_viewer(viewer_url, session)
        if not candidates:
            stats["unresolved"] += 1
            log.info("  [unresolved %s] %s → %s", host, viewer_url, dname)
            manual_needed.append({**row, "recover_status": "needs_manual_download",
                                  "district": dname})
            continue

        ingested = False
        rejected_not_cba = False
        for cand in candidates:
            pdf_bytes = _download_pdf(session, cand)
            if pdf_bytes is None:
                continue
            status, detail = _ingest_pdf_bytes(
                conn, district_id, viewer_url, pdf_bytes, unit, args.dry_run,
                content_check=content_check, use_ocr=use_ocr)
            log.info("  [%s] %s → %s :: %s", status, host, dname, detail)
            stats[status] = stats.get(status, 0) + 1
            if status in ("found", "skip"):
                ingested = True
                break
            if status == "not_cba":
                rejected_not_cba = True
        if rejected_not_cba and not ingested:
            # Downloaded fine but the content isn't a contract — record it so a
            # human can confirm, but do NOT treat it as a download failure.
            manual_needed.append({**row, "recover_status": "not_cba",
                                  "district": dname})
            continue
        if not ingested and host:
            if not any(m.get("url") == viewer_url for m in manual_needed):
                stats["failed"] += 1
                log.info("  [failed %s] could not download a PDF for %s", host, dname)
                manual_needed.append({**row, "recover_status": "download_failed",
                                      "district": dname})

    conn.close()

    log.info("=" * 60)
    log.info("Recovery summary%s:", "  [DRY RUN]" if args.dry_run else "")
    for k in ("found", "skip", "not_cba", "failed", "unresolved", "no_district"):
        log.info("  %-13s %d", k, stats.get(k, 0))
    log.info("=" * 60)

    if manual_needed:
        out_csv = common.DATA_DIR / "il_cba_manual_review_remaining.csv"
        fields = sorted({k for m in manual_needed for k in m.keys()})
        with open(out_csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            for m in manual_needed:
                w.writerow(m)
        log.info("%d row(s) still need a manual download → %s",
                 len(manual_needed), out_csv.name)
        log.info("Ingest each by hand with:")
        log.info("  python3 pipeline/13_recover_viewer_cbas.py "
                 "--pdf <file.pdf> --rcdts <code> --url <viewer_url>")


def ingest_manual(args) -> None:
    """Ingest a hand-downloaded PDF for one district."""
    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        log.error("PDF not found: %s", pdf_path)
        sys.exit(1)
    if not args.rcdts:
        log.error("--rcdts is required when ingesting a manual PDF")
        sys.exit(1)
    conn = common.get_db_conn()
    dist = _district_by_rcdts(conn, args.rcdts)
    if not dist:
        log.error("No IL district with RCDTS %s", args.rcdts)
        sys.exit(1)
    district_id, dname = dist
    source_url = args.url or f"manual:{pdf_path.name}"
    unit = args.unit or "teachers"
    pdf_bytes = pdf_path.read_bytes()
    # A hand-downloaded PDF is human-curated, so content classification is OFF by
    # default here; pass --content-check to run it anyway (e.g. batch ingest).
    status, detail = _ingest_pdf_bytes(
        conn, district_id, source_url, pdf_bytes, unit, args.dry_run,
        content_check=args.content_check, use_ocr=not args.fast)
    conn.close()
    log.info("[%s] %s (%s) :: %s", status, dname, args.rcdts, detail)
    if status in ("failed", "not_cba"):
        sys.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Recover CBAs stuck behind embedded document viewers")
    parser.add_argument("--dry-run", action="store_true",
                        help="Resolve/validate but don't store or write DB rows")
    parser.add_argument("--limit", type=int, default=None,
                        help="Process at most N rows from the CSV")
    parser.add_argument("--host", type=str, default=None,
                        help="Only process rows whose viewer URL is on this host")
    parser.add_argument("--rcdts", type=str, default=None,
                        help="Restrict CSV processing to / target manual ingest "
                             "for this district (11-digit RCDTS)")
    parser.add_argument("--pdf", type=str, default=None,
                        help="Manual ingest: path to a hand-downloaded PDF")
    parser.add_argument("--url", type=str, default=None,
                        help="Manual ingest: original viewer URL (recorded as source_url)")
    parser.add_argument("--unit", type=str, default=None,
                        help="Manual ingest: bargaining unit (default: teachers)")
    parser.add_argument("--no-content-check", action="store_true",
                        help="CSV recovery: skip the content-aware CBA classifier "
                             "and store every resolved PDF (not recommended — lets "
                             "agendas/minutes through)")
    parser.add_argument("--content-check", action="store_true",
                        help="Manual ingest: run the content-aware CBA classifier "
                             "on the hand-downloaded PDF before storing")
    parser.add_argument("--fast", action="store_true",
                        help="Content check: inspect only the embedded text layer "
                             "(skip OCR; scanned PDFs classify as insufficient_text)")
    args = parser.parse_args()

    if args.pdf:
        ingest_manual(args)
    else:
        recover_from_csv(args)
