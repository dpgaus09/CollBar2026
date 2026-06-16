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
  4. Download, verify the ``%PDF`` header, dedupe by hash, store the bytes in
     object storage, and upsert a proper ``cba_pdf`` ``source_documents`` row —
     exactly the contract the LLM extractor (``06_extract_contracts.py``) expects.

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
                      bargaining_unit: str, dry_run: bool) -> tuple[str, str]:
    """Validate, store, and upsert one PDF. Returns (status, detail)."""
    if len(pdf_bytes) < MIN_PDF_BYTES:
        return "failed", f"too_small ({len(pdf_bytes)} bytes)"
    if b"%PDF" not in pdf_bytes[:1024]:
        return "failed", "not_a_pdf (no %PDF header)"

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

    stats = {"found": 0, "skip": 0, "failed": 0, "no_district": 0,
             "unresolved": 0}
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
        for cand in candidates:
            pdf_bytes = _download_pdf(session, cand)
            if pdf_bytes is None:
                continue
            status, detail = _ingest_pdf_bytes(
                conn, district_id, viewer_url, pdf_bytes, unit, args.dry_run)
            log.info("  [%s] %s → %s :: %s", status, host, dname, detail)
            stats[status] = stats.get(status, 0) + 1
            if status in ("found", "skip"):
                ingested = True
                break
        if not ingested and host:
            if not any(m.get("url") == viewer_url for m in manual_needed):
                stats["failed"] += 1
                log.info("  [failed %s] could not download a PDF for %s", host, dname)
                manual_needed.append({**row, "recover_status": "download_failed",
                                      "district": dname})

    conn.close()

    log.info("=" * 60)
    log.info("Recovery summary%s:", "  [DRY RUN]" if args.dry_run else "")
    for k in ("found", "skip", "failed", "unresolved", "no_district"):
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
    status, detail = _ingest_pdf_bytes(
        conn, district_id, source_url, pdf_bytes, unit, args.dry_run)
    conn.close()
    log.info("[%s] %s (%s) :: %s", status, dname, args.rcdts, detail)
    if status == "failed":
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
    args = parser.parse_args()

    if args.pdf:
        ingest_manual(args)
    else:
        recover_from_csv(args)
