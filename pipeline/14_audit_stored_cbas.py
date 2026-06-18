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
    args = ap.parse_args()

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
