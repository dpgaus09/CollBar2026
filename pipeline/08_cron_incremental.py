#!/usr/bin/env python3
"""
Nightly incremental scraper — Phase 5 cron job.

# ============================================================
# OHIO DISABLED — product pivot to Illinois-only (2026-06-13)
# Steps 1 (SERB catalog fetch / new-doc detection) and
# Step 2 (OH extraction) are commented out below.
# To re-enable Ohio: search for "# OHIO DISABLED" and uncomment.
# ============================================================

Step 1 (OH — DISABLED): Fetches the SERB CBA catalog and:
  1. Detects NEW documents (URL not in source_documents) → 'new_doc' alert
  2. Detects CHANGED documents (URL known but file hash changed) → 'changed_doc' alert
     Uses HTTP HEAD to check Last-Modified before doing a full download.

Step 2 (OH — DISABLED): Runs LLM extraction on any unprocessed OH CBA PDFs (gated on count).

Step 3 (IL): Runs LLM extraction on any unprocessed IL CBA PDFs (gated on count).

Usage:
    python3 pipeline/08_cron_incremental.py [--dry-run] [--max-docs-per-state N]

Cron example (run at 3am daily):
    0 3 * * * /usr/bin/python3 /home/runner/workspace/pipeline/08_cron_incremental.py >> /var/log/collbar_cron.log 2>&1
"""
import argparse
import hashlib
import html
import logging
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))
import common

import requests

common.setup_logging()
log = logging.getLogger(__name__)

CBA_CATALOG_URL = (
    "https://serb.ohio.gov/wps/portal/gov/serb/view-document-archive"
    "/collective-bargaining-agreements"
)

SCHOOL_BU_CODES = {"T", "NT"}

# If HEAD returns no Last-Modified header, force a full hash check for any
# existing document whose last-retrieved timestamp is this many days old.
# Ensures hash changes are never silently missed on servers that omit the header.
REVERIFY_AFTER_DAYS = 90

ROW_RE = re.compile(
    r'\["([^"]+)","View","(https://serb\.ohio\.gov/static/PDF/Contracts/[^"]+\.pdf)"'
    r',"([^"]*)","([^"]*)","([^"]*)","([^"]*)"'
    r',"([^"]*)","([^"]*)","([^"]*)","(\d*)"'
    r',"([^"]*)","([^"]*)","([^"]*)","([^"]*)"\]'
)


def parse_cba_records(raw_html: str) -> list:
    """Extract school-sector CBA rows from the embedded JSON in the SERB page."""
    decoded = html.unescape(raw_html)
    records = []
    for m in ROW_RE.finditer(decoded):
        bu_code = m.group(8).strip().upper()
        if bu_code not in SCHOOL_BU_CODES:
            continue
        records.append({
            "case_number": m.group(1).strip(),
            "url": m.group(2).strip(),
            "employer": m.group(4).strip(),
            "union": m.group(5).strip(),
            "bu_code": bu_code,
            "effective_start": m.group(9).strip(),
            "effective_end": m.group(10).strip(),
        })
    return records


def get_known_docs(conn) -> dict:
    """Return {url: {file_hash, retrieved_at}} for the latest cba_pdf row per URL."""
    cur = conn.cursor()
    cur.execute("""
        SELECT DISTINCT ON (source_url) source_url, file_hash, retrieved_at
        FROM source_documents
        WHERE doc_type = 'cba_pdf'
        ORDER BY source_url, retrieved_at DESC
    """)
    rows = cur.fetchall()
    cur.close()
    return {r[0]: {"file_hash": r[1], "retrieved_at": r[2]} for r in rows}


def head_maybe_changed(session, url: str, retrieved_at) -> bool:
    """
    Issue a HEAD request and return True if Last-Modified > retrieved_at.
    Returns False if no Last-Modified header is present (conservative).
    Uses PDF_HEADERS (browser UA + Referer) because SERB rejects bot UAs for
    static PDF paths.
    """
    try:
        r = session.head(url, headers=common.PDF_HEADERS, timeout=20)
        lm_header = r.headers.get("Last-Modified")
        if not lm_header:
            return False
        last_modified = parsedate_to_datetime(lm_header)
        if last_modified.tzinfo is None:
            last_modified = last_modified.replace(tzinfo=timezone.utc)
        if retrieved_at is None:
            return True
        if retrieved_at.tzinfo is None:
            retrieved_at = retrieved_at.replace(tzinfo=timezone.utc)
        return last_modified > retrieved_at
    except Exception as e:
        log.warning("HEAD failed for %s: %s", url, e)
        return False


def fetch_file_hash(session, url: str) -> Optional[str]:
    """
    Fetch a PDF and return its SHA-256 hex digest, or None on error.
    Uses PDF_HEADERS (browser UA + Referer) because SERB rejects bot UAs for
    static PDF paths.
    """
    try:
        r = session.get(url, headers=common.PDF_HEADERS, timeout=90)
        if r.status_code != 200:
            log.warning("GET %s returned HTTP %s", url, r.status_code)
            return None
        return hashlib.sha256(r.content).hexdigest()
    except Exception as e:
        log.warning("Failed to fetch %s: %s", url, e)
        return None


def alert_already_pending(cur, source_url: str, alert_type: str) -> bool:
    """Return True if a pending alert already exists for this (url, type) pair."""
    cur.execute(
        "SELECT id FROM alerts WHERE source_url = %s AND alert_type = %s AND status = 'pending'",
        (source_url, alert_type),
    )
    return cur.fetchone() is not None


def insert_alert(cur, district_id, doc_name: str, source_url: str,
                 alert_type: str = "new_doc"):
    """Insert an alert row if no pending alert already exists for this URL."""
    if alert_already_pending(cur, source_url, alert_type):
        return False
    cur.execute(
        """
        INSERT INTO alerts
            (district_id, alert_type, doc_name, source_url, detected_at, status)
        VALUES (%s, %s, %s, %s, NOW(), 'pending')
        """,
        (district_id, alert_type, doc_name, source_url),
    )
    return True


def check_changed_docs(session, conn, records: list, known_docs: dict,
                       dist_index: dict, dry_run: bool = False) -> int:
    """
    For each catalog record whose URL is already in the DB, check whether
    the file content has changed via HEAD + hash comparison.

    Returns the number of changed_doc alerts inserted (or that would be).
    """
    existing = [r for r in records if r["url"] in known_docs]
    log.info("Checking %d existing URLs for content changes (HEAD first)…", len(existing))

    changed_alerts = 0
    cur = conn.cursor()

    for doc in existing:
        url = doc["url"]
        entry = known_docs[url]
        retrieved_at = entry["retrieved_at"]
        known_hash = entry["file_hash"]

        # Step 1: HEAD to see if the server reports a modification
        maybe_changed = head_maybe_changed(session, url, retrieved_at)
        time.sleep(common.POLITE_DELAY)

        # Fallback: if HEAD returned no Last-Modified header, still force a
        # hash check for docs that haven't been verified recently, so that
        # content changes are never silently missed on servers that omit the
        # header.
        if not maybe_changed and retrieved_at is not None:
            rt = (retrieved_at if retrieved_at.tzinfo
                  else retrieved_at.replace(tzinfo=timezone.utc))
            age_days = (datetime.now(timezone.utc) - rt).days
            if age_days >= REVERIFY_AFTER_DAYS:
                log.info(
                    "No Last-Modified for %s (age %d d ≥ %d d) — "
                    "scheduling periodic hash check",
                    url, age_days, REVERIFY_AFTER_DAYS,
                )
                maybe_changed = True

        if not maybe_changed:
            continue

        log.info("Possible change detected for %s — fetching for hash check…", url)

        # Step 2: Full GET + hash comparison
        new_hash = fetch_file_hash(session, url)
        time.sleep(common.POLITE_DELAY)

        if new_hash is None:
            log.warning("Could not fetch %s — skipping", url)
            continue

        if new_hash == known_hash:
            log.debug("Hash unchanged for %s (Last-Modified may be stale)", url)
            continue

        log.info(
            "Content CHANGED: %s (old=%.8s… new=%.8s…)",
            url, known_hash or "None", new_hash
        )

        employer = doc.get("employer", "")
        doc_name = employer or url.split("/")[-1]

        district_id = None
        if employer:
            district_id, status, _ = common.match_employer(employer, dist_index)
            if status != "auto":
                district_id = None

        if dry_run:
            log.info("[DRY RUN] Would insert changed_doc alert for %s", doc_name)
            changed_alerts += 1
            continue

        # Insert new source_documents row for the updated file
        cur.execute(
            """
            INSERT INTO source_documents
                (district_id, doc_type, source_url, file_hash, retrieved_at)
            VALUES (%s, 'cba_pdf', %s, %s, NOW())
            ON CONFLICT (source_url, file_hash) DO NOTHING
            """,
            (district_id, url, new_hash),
        )

        ok = insert_alert(cur, district_id, doc_name, url, "changed_doc")
        if ok:
            changed_alerts += 1
            log.info("changed_doc alert inserted: %s", doc_name)

    if not dry_run:
        conn.commit()
    cur.close()
    return changed_alerts


DEFAULT_MAX_DOCS_PER_STATE = 200
EXTRACT_SCRIPT = Path(__file__).parent / "06_extract_contracts.py"
# IL ELRB board-vs-union final-offer pipeline (scrape → extract → diff).
ELRB_SCRAPER_SCRIPT = Path(__file__).parent / "18_crawl_elrb_offers.py"
FINAL_OFFER_SCRIPT = Path(__file__).parent / "19_extract_final_offers.py"


def count_unprocessed_docs(conn, state: str) -> int:
    """Return the number of cba_pdf source_documents with no successful extraction_run for a state."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT COUNT(*)
        FROM source_documents sd
        LEFT JOIN districts d ON d.id = sd.district_id
        WHERE sd.doc_type = 'cba_pdf'
          AND COALESCE(d.state, 'OH') = %s
          AND sd.id NOT IN (
              SELECT er.source_doc_id
              FROM extraction_runs er
              WHERE er.status = 'success'
                AND er.source_doc_id IS NOT NULL
          )
        """,
        (state,),
    )
    row = cur.fetchone()
    cur.close()
    return int(row[0]) if row else 0


def run_extraction_for_state(state: str, max_docs: int, dry_run: bool) -> dict:
    """
    Invoke 06_extract_contracts.py --state STATE --max-docs N as a subprocess.
    Returns a dict with keys: state, returncode, stdout_tail, stderr_tail.
    """
    cmd = [
        sys.executable,
        str(EXTRACT_SCRIPT),
        "--state", state,
        "--max-docs", str(max_docs),
    ]
    if dry_run:
        cmd.append("--dry-run")

    log.info("Launching extraction: %s", " ".join(cmd))
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=3600,
        )
        stdout_tail = result.stdout[-3000:] if result.stdout else ""
        stderr_tail = result.stderr[-3000:] if result.stderr else ""
        if result.returncode != 0:
            log.error(
                "Extraction for %s exited %d.\nSTDERR tail:\n%s",
                state, result.returncode, stderr_tail,
            )
        else:
            log.info("Extraction for %s completed successfully.", state)
        return {
            "state": state,
            "returncode": result.returncode,
            "stdout_tail": stdout_tail,
            "stderr_tail": stderr_tail,
        }
    except subprocess.TimeoutExpired:
        log.error("Extraction for %s timed out after 3600 s", state)
        return {"state": state, "returncode": -1, "stdout_tail": "", "stderr_tail": "TIMEOUT"}
    except Exception as exc:
        log.error("Extraction for %s failed to launch: %s", state, exc)
        return {"state": state, "returncode": -1, "stdout_tail": "", "stderr_tail": str(exc)}


def run_subprocess(label: str, cmd: list, timeout: int = 3600) -> dict:
    """Run a pipeline subprocess, capturing tails of stdout/stderr.

    Returns a dict with keys: label, returncode, stdout_tail, stderr_tail.
    """
    log.info("Launching %s: %s", label, " ".join(cmd))
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        stdout_tail = result.stdout[-3000:] if result.stdout else ""
        stderr_tail = result.stderr[-3000:] if result.stderr else ""
        if result.returncode != 0:
            log.error("%s exited %d.\nSTDERR tail:\n%s", label, result.returncode, stderr_tail)
        else:
            log.info("%s completed successfully.", label)
        return {"label": label, "returncode": result.returncode,
                "stdout_tail": stdout_tail, "stderr_tail": stderr_tail}
    except subprocess.TimeoutExpired:
        log.error("%s timed out after %d s", label, timeout)
        return {"label": label, "returncode": -1, "stdout_tail": "", "stderr_tail": "TIMEOUT"}
    except Exception as exc:
        log.error("%s failed to launch: %s", label, exc)
        return {"label": label, "returncode": -1, "stdout_tail": "", "stderr_tail": str(exc)}


def count_pending_final_offers(conn) -> int:
    """Count matched ELRB postings still needing extraction or a diff.

    A posting is "pending" if it lacks extracted items for both sides, or has
    no comparison rows yet. The extractor itself is idempotent (it skips sides
    already extracted), so this only gates whether it is worth launching.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT COUNT(*)
        FROM final_offer_postings p
        WHERE p.district_id IS NOT NULL
          AND (
              (SELECT COUNT(DISTINCT i.side)
                 FROM final_offer_items i WHERE i.posting_id = p.id) < 2
              OR NOT EXISTS (
                  SELECT 1 FROM final_offer_comparisons c WHERE c.posting_id = p.id)
          )
        """
    )
    row = cur.fetchone()
    cur.close()
    return int(row[0]) if row else 0


def main():
    parser = argparse.ArgumentParser(description="Nightly incremental scraper")
    parser.add_argument("--dry-run", action="store_true",
                        help="Do not write to database")
    parser.add_argument(
        "--max-docs-per-state",
        type=int,
        default=DEFAULT_MAX_DOCS_PER_STATE,
        metavar="N",
        help=f"Max CBA docs to extract per state per nightly run (default: {DEFAULT_MAX_DOCS_PER_STATE})",
    )
    args = parser.parse_args()

    log.info("=== CollBar nightly incremental scraper ===")
    log.info("Mode: %s", "DRY RUN" if args.dry_run else "LIVE")

    # ── OHIO DISABLED ──────────────────────────────────────────────────────
    # The SERB catalog fetch, new-doc detection (Phase A), changed-doc
    # detection (Phase B), and OH LLM extraction (Phase C) are all disabled.
    # The product has pivoted to Illinois-only. To re-enable Ohio, uncomment
    # the block below (search for "# OHIO DISABLED RE-ENABLE START").
    # ──────────────────────────────────────────────────────────────────────
    log.info("Ohio pipelines DISABLED — skipping SERB catalog fetch, Phase A, B, and C.")

    # Variables kept so the summary printout below compiles unchanged.
    records = []
    known_urls: set = set()
    new_docs: list = []
    new_inserted = 0
    new_skipped_dupes = 0
    changed_alerts = 0
    oh_unprocessed = 0
    oh_result = None

    conn = common.get_db_conn()

    # # OHIO DISABLED RE-ENABLE START — uncomment everything below up to
    # # "OHIO DISABLED RE-ENABLE END" to restore Ohio pipelines.
    #
    # session = requests.Session()
    #
    # log.info("Fetching SERB CBA catalog (fresh, bypassing cache)…")
    # try:
    #     r = session.get(
    #         CBA_CATALOG_URL,
    #         headers=common.HEADERS,
    #         timeout=90,
    #         allow_redirects=True,
    #     )
    #     if r.status_code != 200:
    #         log.error("Failed to fetch catalog: HTTP %s", r.status_code)
    #         sys.exit(1)
    #     time.sleep(common.POLITE_DELAY)
    # except Exception as e:
    #     log.error("Request error fetching catalog: %s", e)
    #     sys.exit(1)
    #
    # records = parse_cba_records(r.text)
    # log.info("Found %d school-sector CBA records in catalog", len(records))
    #
    # if not records:
    #     log.warning("No records parsed — check ROW_RE pattern or SERB page structure")
    #     sys.exit(0)
    #
    # known_docs = get_known_docs(conn)
    # known_urls = set(known_docs.keys())
    # log.info("Found %d known CBA URLs in database", len(known_urls))
    #
    # dist_index = common.build_district_index(conn)
    #
    # # ── Phase A: new documents ─────────────────────────────────────────
    # new_docs = [rec for rec in records if rec["url"] not in known_urls]
    # log.info("New documents detected: %d", len(new_docs))
    #
    # if new_docs and not args.dry_run:
    #     cur = conn.cursor()
    #     for doc in new_docs:
    #         employer = doc.get("employer", "")
    #         district_id = None
    #         if employer:
    #             district_id, status, _ = common.match_employer(employer, dist_index)
    #             if status != "auto":
    #                 district_id = None
    #         eff_start = doc.get("effective_start", "")
    #         eff_end = doc.get("effective_end", "")
    #         union = doc.get("union", "")
    #         doc_name = (
    #             f"{employer or 'Unknown'} — {union}"
    #             f" ({eff_start}–{eff_end})"
    #         ).strip(" —")
    #         log.info("Fetching new doc for hash: %s", doc["url"])
    #         file_hash = fetch_file_hash(session, doc["url"])
    #         time.sleep(common.POLITE_DELAY)
    #         if file_hash is not None:
    #             cur.execute(
    #                 """
    #                 INSERT INTO source_documents
    #                     (district_id, doc_type, source_url, file_hash, retrieved_at)
    #                 VALUES (%s, 'cba_pdf', %s, %s, NOW())
    #                 ON CONFLICT (source_url, file_hash) DO NOTHING
    #                 """,
    #                 (district_id, doc["url"], file_hash),
    #             )
    #             ok = insert_alert(cur, district_id, doc_name, doc["url"], "new_doc")
    #             if ok:
    #                 new_inserted += 1
    #                 log.info("new_doc alert inserted: %s", doc_name)
    #             else:
    #                 new_skipped_dupes += 1
    #         else:
    #             log.warning(
    #                 "Could not fetch %s — source_documents row and alert skipped",
    #                 doc["url"],
    #             )
    #     conn.commit()
    #     cur.close()
    #     log.info("Inserted %d new alerts (%d skipped — already pending)",
    #              new_inserted, new_skipped_dupes)
    # elif new_docs and args.dry_run:
    #     log.info("[DRY RUN] Would insert up to %d new_doc alerts:", len(new_docs))
    #     for doc in new_docs[:10]:
    #         log.info("  - %s: %s", doc.get("employer", "?"), doc["url"])
    #     if len(new_docs) > 10:
    #         log.info("  … and %d more", len(new_docs) - 10)
    #     new_inserted = len(new_docs)
    #
    # # ── Phase B: changed documents ─────────────────────────────────────
    # changed_alerts = check_changed_docs(
    #     session, conn, records, known_docs, dist_index, dry_run=args.dry_run
    # )
    #
    # # ── Phase C: OH extraction ─────────────────────────────────────────
    # oh_unprocessed = count_unprocessed_docs(conn, "OH")
    # log.info("Unprocessed OH CBA docs: %d", oh_unprocessed)
    # if oh_unprocessed > 0:
    #     log.info("Running OH extraction (up to %d docs)…", args.max_docs_per_state)
    #     oh_result = run_extraction_for_state("OH", args.max_docs_per_state, args.dry_run)
    # else:
    #     log.info("No unprocessed OH CBA docs — skipping OH extraction.")
    # # OHIO DISABLED RE-ENABLE END

    # ── Phase D: IL extraction ─────────────────────────────────────────────
    il_unprocessed = count_unprocessed_docs(conn, "IL")
    log.info("Unprocessed IL CBA docs: %d", il_unprocessed)
    il_result = None
    if il_unprocessed > 0:
        log.info(
            "Running IL extraction (up to %d docs)…", args.max_docs_per_state
        )
        il_result = run_extraction_for_state(
            "IL", args.max_docs_per_state, args.dry_run
        )
    else:
        log.info("No unprocessed IL CBA docs — skipping IL extraction.")

    # ── Phase E: IL ELRB board-vs-union final offers ───────────────────────
    # 1) Scrape the ELRB public-posting pages (current year + lookahead) so new
    #    cases and the next year's page are picked up with no code change.
    # 2) Extract each side's per-article positions and recompute the diffs for
    #    any posting still missing items or comparisons.
    elrb_result = None
    final_offer_result = None
    elrb_cmd = [sys.executable, str(ELRB_SCRAPER_SCRIPT)]
    if args.dry_run:
        elrb_cmd.append("--dry-run")
    elrb_result = run_subprocess("ELRB final-offer scrape", elrb_cmd, timeout=1800)

    pending_final_offers = count_pending_final_offers(conn)
    log.info("ELRB postings pending extraction/diff: %d", pending_final_offers)
    if pending_final_offers > 0:
        fo_cmd = [sys.executable, str(FINAL_OFFER_SCRIPT)]
        if args.dry_run:
            fo_cmd.append("--dry-run")
        final_offer_result = run_subprocess(
            "ELRB final-offer extract+diff", fo_cmd, timeout=3600
        )
    else:
        log.info("No pending ELRB final offers — skipping extraction+diff.")

    conn.close()

    print()
    print("=" * 60)
    print("  CollBar Nightly Incremental Scraper")
    print("=" * 60)
    print(f"  Catalog records found   : {len(records):>8,}")
    print(f"  Known URLs in DB        : {len(known_urls):>8,}")
    print(f"  New documents detected  : {len(new_docs):>8,}")
    print(f"  Changed documents found : {changed_alerts:>8,}")
    if not args.dry_run:
        print(f"  New alerts inserted     : {new_inserted:>8,}")
        print(f"  New alerts skipped(dup) : {new_skipped_dupes:>8,}")
        print(f"  Changed alerts inserted : {changed_alerts:>8,}")
    else:
        print("  [DRY RUN — no DB writes]")
    print("-" * 60)
    print(f"  OH unprocessed docs     : {oh_unprocessed:>8,}")
    if oh_result is not None:
        status = "OK" if oh_result["returncode"] == 0 else f"ERR({oh_result['returncode']})"
        print(f"  OH extraction result    : {status:>8}")
    else:
        print(f"  OH extraction           : {'skipped':>8}")
    print(f"  IL unprocessed docs     : {il_unprocessed:>8,}")
    if il_result is not None:
        status = "OK" if il_result["returncode"] == 0 else f"ERR({il_result['returncode']})"
        print(f"  IL extraction result    : {status:>8}")
    else:
        print(f"  IL extraction           : {'skipped':>8}")
    print("-" * 60)
    if elrb_result is not None:
        status = "OK" if elrb_result["returncode"] == 0 else f"ERR({elrb_result['returncode']})"
        print(f"  ELRB final-offer scrape : {status:>8}")
    print(f"  ELRB pending postings   : {pending_final_offers:>8,}")
    if final_offer_result is not None:
        status = "OK" if final_offer_result["returncode"] == 0 else f"ERR({final_offer_result['returncode']})"
        print(f"  ELRB extract+diff result: {status:>8}")
    else:
        print(f"  ELRB extract+diff       : {'skipped':>8}")
    print("=" * 60)
    print()


if __name__ == "__main__":
    main()
