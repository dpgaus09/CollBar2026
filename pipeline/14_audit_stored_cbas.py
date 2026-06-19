#!/usr/bin/env python3
"""
Audit already-stored documents for non-CBAs (read-only).

Earlier crawls captured files as ``doc_type='cba_pdf'`` that are not actually
collective-bargaining agreements: board-meeting agendas/minutes, IASB PRESS
board-policy manuals, student handbooks, even a "STUDENT PARKING CONTRACT".
These pollute downstream LLM extraction, the public dashboard, and comparables.

Task #77 added a content-aware CBA classifier to the viewer-recovery step
(``13_recover_viewer_cbas.py``), but it only runs on *newly recovered* viewer
documents — never on the corpus already in ``source_documents``. This script
closes that gap: it runs the same classifier over every existing ``cba_pdf``
row and reports the ones that do not look like real contracts.

It is strictly READ-ONLY. It never deletes, updates, or re-classifies anything
in the database — it only emits a CSV report for human review. Acting on the
report (deleting / re-labelling) is intentionally left to a person.

How it works:
  1. Query ``source_documents`` for ``doc_type='cba_pdf'`` rows, joined with
     ``districts`` for name/state.
  2. Resolve each row's local PDF (reusing ``06_extract_contracts.py``'s
     ``resolve_pdf_path``) and extract its text (``extract_pdf_text``, with OCR
     fallback for scanned docs; ``--fast`` inspects only the embedded text
     layer and skips OCR).
  3. Classify the text with ``classify_cba_text`` from
     ``13_recover_viewer_cbas.py`` (title vs. contract-body vs. agenda/minutes
     vs. board-policy signals).
  4. Write a CSV of likely non-CBAs (or every doc with ``--all``) including the
     district, source_url, classification, and the classifier's detail string
     (title/body/agenda/policy/kw counts) so a reviewer can judge each call.

Usage:
    # Audit every stored cba_pdf, report likely non-CBAs:
    python3 pipeline/14_audit_stored_cbas.py

    # Restrict to Illinois, skip OCR (text layer only), custom output path:
    python3 pipeline/14_audit_stored_cbas.py --state IL --fast --out data/audit.csv

    # Include the docs that DO classify as CBAs in the report too:
    python3 pipeline/14_audit_stored_cbas.py --all

    # Limit work while spot-checking:
    python3 pipeline/14_audit_stored_cbas.py --limit 25
"""
import argparse
import csv
import logging
import re
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

DEFAULT_OUT = common.DATA_DIR / "stored_cba_audit.csv"

_extractor_mod = None
_recovery_mod = None


def _load_pipeline_module(filename: str, modname: str):
    """Import a sibling pipeline module by path (filenames start with digits)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        modname, Path(__file__).parent / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _get_extractor():
    global _extractor_mod
    if _extractor_mod is None:
        _extractor_mod = _load_pipeline_module(
            "06_extract_contracts.py", "extract_contracts")
    return _extractor_mod


def _get_recovery():
    global _recovery_mod
    if _recovery_mod is None:
        _recovery_mod = _load_pipeline_module(
            "13_recover_viewer_cbas.py", "recover_viewer_cbas")
    return _recovery_mod


def get_stored_cba_docs(conn, state: Optional[str] = None,
                        limit: Optional[int] = None):
    """Return stored cba_pdf rows joined with district metadata.

    Tuples: (id, district_id, district_name, state, school_year,
             bargaining_unit, source_url, storage_key, source_type)
    """
    cur = conn.cursor()
    state_filter = "AND d.state = %s" if state else ""
    params: list = [state] if state else []
    limit_clause = "LIMIT %s" if limit else ""
    if limit:
        params.append(limit)
    cur.execute(
        f"""
        SELECT sd.id, sd.district_id, d.name, d.state, sd.school_year,
               sd.bargaining_unit, sd.source_url, sd.storage_key, sd.source_type
        FROM source_documents sd
        LEFT JOIN districts d ON d.id = sd.district_id
        WHERE sd.doc_type = 'cba_pdf'
          {state_filter}
        ORDER BY sd.id
        {limit_clause}
        """,
        tuple(params),
    )
    rows = cur.fetchall()
    cur.close()
    return rows


def _classify_doc(pdf_path: Path, *, use_ocr: bool) -> tuple[Optional[bool], str]:
    """Extract text from a local PDF and classify it. (is_cba, detail).

    is_cba is None when the document could not be read at all.
    """
    extractor = _get_extractor()
    recovery = _get_recovery()
    try:
        if use_ocr:
            text, _used_ocr, reason, _conf = extractor.extract_pdf_text(pdf_path)
            if not text and reason:
                return None, f"unreadable ({reason})"
        else:
            text, readable = extractor._text_layer(pdf_path)
            if not readable:
                return None, "unreadable (PDF_CORRUPT_OR_UNREADABLE)"
        return recovery.classify_cba_text(text)
    except Exception as e:  # noqa: BLE001 — best-effort, never crash the audit
        return None, f"classify_error ({e})"


def get_stored_cba_docs_by_ids(conn, ids):
    """Return current cba_pdf rows for the given doc ids (joined with district).

    Filters ``doc_type='cba_pdf'`` so ids that were re-labelled (e.g. to
    ``non_cba`` / ``policy_manual``) or removed since the prior audit are simply
    absent from the result — the caller drops those stale rows.

    Tuples match get_stored_cba_docs():
        (id, district_id, district_name, state, school_year,
         bargaining_unit, source_url, storage_key, source_type)
    """
    if not ids:
        return []
    cur = conn.cursor()
    cur.execute(
        """
        SELECT sd.id, sd.district_id, d.name, d.state, sd.school_year,
               sd.bargaining_unit, sd.source_url, sd.storage_key, sd.source_type
        FROM source_documents sd
        LEFT JOIN districts d ON d.id = sd.district_id
        WHERE sd.doc_type = 'cba_pdf'
          AND sd.id = ANY(%s)
        ORDER BY sd.id
        """,
        (list(ids),),
    )
    rows = cur.fetchall()
    cur.close()
    return rows


def _parse_body(detail: str) -> Optional[int]:
    """Pull the ``body=N`` signal count out of a classifier detail string."""
    m = re.search(r"\bbody=(\d+)", detail or "")
    return int(m.group(1)) if m else None


def _select_recheck_ids(prior_rows: list[dict], thin_body: int) -> set[int]:
    """Doc ids worth a forced-OCR re-read: the inconclusive 'needs-OCR' bucket
    plus the 'thin-text trap' — 'not-CBA' rows whose contract body signal is so
    thin (body<=thin_body) that a tiny embedded text layer, not real content,
    drove the call. Confident policy-manual non-CBAs (strong policy signal) are
    left alone; re-OCR'ing a 100-page PRESS manual wastes hours and that purge
    is owned elsewhere.
    """
    ids: set[int] = set()
    for r in prior_rows:
        cls = r.get("classification", "")
        try:
            did = int(r["doc_id"])
        except (KeyError, ValueError, TypeError):
            continue
        if cls == "needs-OCR":
            ids.add(did)
        elif cls == "not-CBA":
            detail = r.get("detail", "")
            if "policy_manual" in detail:
                continue
            body = _parse_body(detail)
            if body is not None and body <= thin_body:
                ids.add(did)
    return ids


def _recheck_classify(pdf_path: Path, extractor, recovery) -> tuple[str, str]:
    """Force-OCR re-read of one PDF. Returns (label, detail).

    Reads the embedded text layer AND a forced raster-OCR pass (``_ocr_pdf``,
    cached by file hash), classifies each, and prefers the OCR result only when
    it is substantive (>= MIN_CLASSIFY_CHARS) and either the text layer was
    insufficient or the OCR text is materially longer (avoids letting a few
    noisy OCR chars override a clean text layer). Provenance — which source won,
    char counts, OCR confidence and any OCR failure reason — is appended to the
    detail so a reviewer can judge each flip.

    A doc that is still unreadable after a forced OCR attempt is labelled
    ``unreadable`` (we tried), never silently downgraded to a confirmed
    ``not-CBA``.
    """
    min_chars = getattr(recovery, "MIN_CLASSIFY_CHARS", 200)
    try:
        text_layer, _readable = extractor._text_layer(pdf_path)
    except Exception as e:  # noqa: BLE001
        text_layer = ""
        log.debug("text-layer read failed for %s: %s", pdf_path, e)
    tl = (text_layer or "").strip()
    tl_is_cba, tl_detail = recovery.classify_cba_text(tl)

    try:
        ocr_text, ocr_reason, ocr_conf = extractor._ocr_pdf(pdf_path)
    except Exception as e:  # noqa: BLE001
        ocr_text, ocr_reason, ocr_conf = "", f"OCR_ERROR ({e})", None
    ot = (ocr_text or "").strip()

    tl_insufficient = tl_detail.startswith("insufficient_text")
    use_ocr = len(ot) >= min_chars and (tl_insufficient or len(ot) >= len(tl) + 100)
    if use_ocr:
        is_cba, base_detail = recovery.classify_cba_text(ot)
        source = "ocr"
    else:
        is_cba, base_detail = tl_is_cba, tl_detail
        source = "text_layer"

    if is_cba is True:
        label = "CBA"
    elif base_detail.startswith("insufficient_text"):
        # Could not read enough text even after a forced OCR attempt. This is
        # INCONCLUSIVE, not a confirmed non-CBA.
        label = "unreadable"
    else:
        label = "not-CBA"

    conf_str = (f"{ocr_conf:.1f}" if isinstance(ocr_conf, (int, float))
                else "na")
    detail = (f"{base_detail} [recheck source={source} text_chars={len(tl)} "
              f"ocr_chars={len(ot)} ocr_conf={conf_str} "
              f"ocr_reason={ocr_reason or '-'}]")
    return label, detail


def run_recheck(args) -> int:
    """OCR-recheck mode: force-OCR the inconclusive subset of a prior fast audit
    and merge the resolutions back into a single report (read-only)."""
    extractor = _get_extractor()
    recovery = _get_recovery()

    with open(args.recheck_from, newline="", encoding="utf-8") as fh:
        prior_rows = list(csv.DictReader(fh))
    if not prior_rows:
        log.error("Prior audit CSV %s is empty — nothing to recheck.",
                  args.recheck_from)
        return 1

    candidates = _select_recheck_ids(prior_rows, args.thin_body)
    log.info("Loaded %d prior rows from %s; %d candidate(s) to OCR-recheck "
             "(needs-OCR + thin not-CBA body<=%d, excluding policy_manual)",
             len(prior_rows), args.recheck_from, len(candidates),
             args.thin_body)

    conn = common.get_db_conn()
    try:
        db_rows = get_stored_cba_docs_by_ids(conn, candidates)
    finally:
        conn.close()
    db_map = {r[0]: r for r in db_rows}
    n_stale = len(candidates) - len(db_map)
    log.info("%d/%d candidate(s) are still doc_type='cba_pdf'; %d stale "
             "(re-labelled/removed) and will be dropped from the report",
             len(db_map), len(candidates), n_stale)

    merged: list[dict] = []
    n_recheck = n_cba = n_not = n_unreadable = 0
    for row in prior_rows:
        try:
            did = int(row["doc_id"])
        except (KeyError, ValueError, TypeError):
            merged.append(row)
            continue
        if did not in candidates:
            merged.append(row)               # untouched (confident prior call)
            continue
        if did not in db_map:
            continue                          # stale: drop from merged report

        (_id, district_id, dname, state, sy, unit,
         source_url, storage_key, _stype) = db_map[did]
        pdf_path = extractor.resolve_pdf_path(source_url or "", storage_key or "")
        if pdf_path is None:
            label, detail = "unreadable", "file_not_found"
        else:
            try:
                label, detail = _recheck_classify(pdf_path, extractor, recovery)
            except Exception as e:  # noqa: BLE001 — never crash the audit
                label, detail = "unreadable", f"recheck_error ({e})"

        new_row = dict(row)
        new_row["classification"] = label
        new_row["detail"] = detail
        merged.append(new_row)

        n_recheck += 1
        if label == "CBA":
            n_cba += 1
        elif label == "not-CBA":
            n_not += 1
        else:
            n_unreadable += 1
        if n_recheck % 10 == 0 or n_recheck == len(db_map):
            log.info("  OCR-rechecked %d/%d (resolved cba=%d not-cba=%d "
                     "unreadable=%d)", n_recheck, len(db_map), n_cba, n_not,
                     n_unreadable)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["doc_id", "district_id", "district_name", "state", "school_year",
              "bargaining_unit", "classification", "detail", "source_url"]
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(merged)

    log.info("=" * 60)
    log.info("OCR-recheck complete: %d rechecked → %d CBA, %d not-CBA, "
             "%d unreadable; %d stale dropped", n_recheck, n_cba, n_not,
             n_unreadable, n_stale)
    log.info("Wrote %d merged rows to %s", len(merged), args.out)
    log.info("This audit is read-only — nothing in the database was changed.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", help="Restrict to one district state (e.g. IL).")
    ap.add_argument("--limit", type=int,
                    help="Audit at most N documents (spot-checking).")
    ap.add_argument("--fast", action="store_true",
                    help="Inspect only the embedded text layer; skip OCR "
                         "(scanned PDFs then report as unreadable).")
    ap.add_argument("--all", action="store_true",
                    help="Include docs that classify AS CBAs in the report too "
                         "(default: report only likely non-CBAs).")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help=f"CSV output path (default: {DEFAULT_OUT}).")
    ap.add_argument("--recheck-from", type=Path, dest="recheck_from",
                    help="OCR-recheck mode: read a prior (fast) audit CSV, "
                         "force-OCR its inconclusive subset (needs-OCR + thin "
                         "not-CBA), and merge the resolutions into --out. "
                         "Forces OCR regardless of --fast.")
    ap.add_argument("--thin-body", type=int, default=1, dest="thin_body",
                    help="In --recheck-from mode, re-OCR 'not-CBA' rows whose "
                         "body signal is <= this (default 1: the thin-text "
                         "trap).")
    args = ap.parse_args()

    if args.recheck_from:
        return run_recheck(args)

    use_ocr = not args.fast
    extractor = _get_extractor()  # also exposes resolve_pdf_path

    conn = common.get_db_conn()
    try:
        docs = get_stored_cba_docs(conn, state=args.state, limit=args.limit)
    finally:
        conn.close()

    scope = f" (state={args.state})" if args.state else ""
    log.info("Auditing %d stored cba_pdf docs%s%s", len(docs), scope,
             " [text-layer only, no OCR]" if args.fast else "")

    flagged: list[dict] = []
    n_cba = n_not = n_needs_ocr = n_unreadable = n_missing = 0

    for i, row in enumerate(docs, 1):
        (doc_id, district_id, district_name, state, school_year,
         bargaining_unit, source_url, storage_key, _source_type) = row

        pdf_path = extractor.resolve_pdf_path(source_url or "", storage_key or "")
        if pdf_path is None:
            n_missing += 1
            is_cba, detail = None, "file_not_found"
        else:
            is_cba, detail = _classify_doc(pdf_path, use_ocr=use_ocr)

        if is_cba is True:
            n_cba += 1
            label = "CBA"
        elif is_cba is False and detail.startswith("insufficient_text"):
            # No readable text layer (likely a scanned PDF). In --fast mode we
            # skip OCR, so this is INCONCLUSIVE, not a confirmed non-CBA: a real
            # scanned CBA lands here too. Re-run without --fast to resolve these.
            n_needs_ocr += 1
            label = "needs-OCR"
        elif is_cba is False:
            n_not += 1
            label = "not-CBA"
        else:
            n_unreadable += 1
            label = "unreadable"

        if args.all or is_cba is not True:
            flagged.append({
                "doc_id": doc_id,
                "district_id": district_id if district_id is not None else "",
                "district_name": district_name or "",
                "state": state or "",
                "school_year": school_year or "",
                "bargaining_unit": bargaining_unit or "",
                "classification": label,
                "detail": detail,
                "source_url": source_url or "",
            })

        if i % 25 == 0 or i == len(docs):
            log.info("  %d/%d processed (cba=%d not-cba=%d needs-ocr=%d "
                     "unreadable=%d missing=%d)",
                     i, len(docs), n_cba, n_not, n_needs_ocr, n_unreadable,
                     n_missing)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["doc_id", "district_id", "district_name", "state", "school_year",
              "bargaining_unit", "classification", "detail", "source_url"]
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(flagged)

    log.info("=" * 60)
    log.info("Audited %d docs: %d CBA, %d not-CBA, %d needs-OCR, %d unreadable, "
             "%d missing-file", len(docs), n_cba, n_not, n_needs_ocr,
             n_unreadable, n_missing)
    report_kind = ("all docs" if args.all
                   else "non-CBAs + needs-OCR + unreadable/missing")
    log.info("Wrote %d rows (%s) to %s", len(flagged), report_kind, args.out)
    log.info("This audit is read-only — nothing in the database was changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
