#!/usr/bin/env python3
"""
Remove board-policy manuals that were previously saved as ``cba_pdf`` documents.

Earlier crawls (before the classifier learned to reject IASB PRESS board-policy
manuals) captured policy manuals as ``doc_type='cba_pdf'`` rows. They share a lot
of contract vocabulary (insurance, retirement, grievance, personnel) so they sail
past simple keyword gates, but they are board policy -- not negotiated union
contracts -- and they pollute downstream LLM extraction, the public dashboard, and
comparables.

The read-only auditor (``14_audit_stored_cbas.py``) re-classifies every stored
``cba_pdf`` with ``classify_cba_text`` and writes a CSV. This script ACTS on that
report: it selects the rows the classifier flagged as ``policy_manual`` and either
re-labels them (``doc_type='policy_manual'``, the default -- reversible, keeps
provenance) or deletes them outright. It also removes the bogus rows those
manuals already produced downstream (``contracts`` + their ``contract_provisions``
and ``extraction_runs``) so they stop feeding extraction and benchmarks.

Two sources of flagged docs are combined:
  1. Rows whose classifier ``detail`` contains ``policy_manual`` (the digital
     PRESS manuals -- detected from the embedded text layer).
  2. Scanned/unreadable rows (``needs-OCR`` / ``unreadable``) whose ``source_url``
     filename unambiguously names a board-policy / PRESS document. Full-corpus OCR
     is impractical (a single scanned PRESS manual can take minutes), so these are
     caught from the URL instead -- a deliberately tight pattern, board policy /
     PRESS only, never generic "handbook"/"manual".

Safety:
  - Defaults to ``--dry-run``: it prints exactly what it would change and touches
    nothing. Pass ``--apply`` to perform the change inside a single transaction.
  - Re-labelling is the default; ``--delete`` removes the source_documents rows.
  - Only rows still at ``doc_type='cba_pdf'`` are acted on (idempotent re-runs).

Usage:
    # See what would happen (no changes):
    python3 pipeline/15_purge_policy_manuals.py

    # Re-label flagged policy manuals to doc_type='policy_manual' and clean the
    # bogus contracts/extraction_runs they produced:
    python3 pipeline/15_purge_policy_manuals.py --apply

    # Delete the rows entirely instead of re-labelling:
    python3 pipeline/15_purge_policy_manuals.py --apply --delete
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

DEFAULT_CSV = common.DATA_DIR / "stored_cba_audit.csv"

# Tight board-policy / PRESS filename signals for scanned (needs-OCR/unreadable)
# rows that the text-layer classifier could not read. Deliberately narrow: it
# matches "board policy", "board_policy_manual", "policy manual/reference", and
# the IASB PRESS product -- never a bare "handbook" or "manual".
_URL_POLICY_RE = re.compile(
    r"board[_%\s-]*policy"
    r"|policy[_%\s-]*(manual|reference)"
    r"|press[_%\s\d]"
    r"|press\.pdf",
    re.IGNORECASE,
)
_INCONCLUSIVE = {"needs-OCR", "unreadable"}

# Allowed doc_type values, kept in lockstep with the Drizzle schema CHECK in
# lib/db/src/schema/source_documents.ts. This repo applies schema via
# drizzle-kit push, which wants to TRUNCATE populated tables, so additive
# constraint changes are applied via raw SQL instead. ensure_doc_type_constraint
# makes the relabel reproducible on any environment whose constraint predates
# the 'policy_manual' value.
_DOC_TYPES = (
    "cba_pdf", "mou", "factfinding_report", "wage_settlement_report",
    "cdss_extract", "directory", "stats", "policy_manual",
)


def ensure_doc_type_constraint(cur) -> None:
    """Idempotently widen the doc_type CHECK to include all _DOC_TYPES."""
    values = ",".join(f"'{v}'" for v in _DOC_TYPES)
    cur.execute("ALTER TABLE source_documents "
                "DROP CONSTRAINT IF EXISTS source_documents_doc_type_check")
    cur.execute("ALTER TABLE source_documents ADD CONSTRAINT "
                f"source_documents_doc_type_check CHECK (doc_type IN ({values}))")


def select_from_csv(csv_path: Path) -> tuple[dict[int, dict], dict[int, dict]]:
    """Return (text_layer_flagged, url_flagged) maps: doc_id -> csv row.

    text_layer_flagged: classifier ``detail`` contains 'policy_manual'.
    url_flagged: an inconclusive (scanned) row whose source_url names a
        board-policy / PRESS document.
    """
    text_flagged: dict[int, dict] = {}
    url_flagged: dict[int, dict] = {}
    with open(csv_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            try:
                doc_id = int(row["doc_id"])
            except (KeyError, ValueError):
                continue
            detail = (row.get("detail") or "")
            classification = (row.get("classification") or "")
            url = (row.get("source_url") or "")
            if "policy_manual" in detail:
                text_flagged[doc_id] = row
            elif classification in _INCONCLUSIVE and _URL_POLICY_RE.search(url):
                url_flagged[doc_id] = row
    return text_flagged, url_flagged


def get_downstream(conn, ids: list[int]) -> dict:
    """Count/collect the derived rows that reference these documents."""
    cur = conn.cursor()
    cur.execute("SELECT id FROM contracts WHERE source_doc_id = ANY(%s)", (ids,))
    contract_ids = [r[0] for r in cur.fetchall()]
    n_provisions = 0
    if contract_ids:
        cur.execute(
            "SELECT count(*) FROM contract_provisions WHERE contract_id = ANY(%s)",
            (contract_ids,))
        n_provisions = cur.fetchone()[0]
    cur.execute(
        "SELECT count(*) FROM extraction_runs WHERE source_doc_id = ANY(%s)", (ids,))
    n_runs = cur.fetchone()[0]
    # Anything we would orphan/leave behind that we are NOT cleaning -- surface it
    # so a human notices rather than silently corrupting referential meaning.
    cur.execute(
        "SELECT count(*) FROM settlements WHERE source_doc_id = ANY(%s)", (ids,))
    n_settlements = cur.fetchone()[0]
    cur.close()
    return {
        "contract_ids": contract_ids,
        "n_provisions": n_provisions,
        "n_runs": n_runs,
        "n_settlements": n_settlements,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV,
                    help=f"Audit CSV from 14_audit_stored_cbas.py "
                         f"(default: {DEFAULT_CSV}).")
    ap.add_argument("--apply", action="store_true",
                    help="Perform the change. Without this it is a dry run.")
    ap.add_argument("--delete", action="store_true",
                    help="Delete source_documents rows instead of re-labelling "
                         "them to doc_type='policy_manual'.")
    args = ap.parse_args()

    if not args.csv.exists():
        log.error("Audit CSV not found: %s. Run 14_audit_stored_cbas.py first.",
                  args.csv)
        return 1

    text_flagged, url_flagged = select_from_csv(args.csv)
    all_ids = sorted(set(text_flagged) | set(url_flagged))
    if not all_ids:
        log.info("No policy-manual documents flagged in %s. Nothing to do.",
                 args.csv)
        return 0

    conn = common.get_db_conn()
    try:
        cur = conn.cursor()
        # Only act on rows still labelled cba_pdf (idempotent).
        cur.execute(
            "SELECT sd.id, d.name, sd.bargaining_unit, sd.source_url, sd.doc_type "
            "FROM source_documents sd LEFT JOIN districts d ON d.id = sd.district_id "
            "WHERE sd.id = ANY(%s) ORDER BY sd.id", (all_ids,))
        live = cur.fetchall()
        cur.close()

        actionable = [r for r in live if r[4] == "cba_pdf"]
        already = [r for r in live if r[4] != "cba_pdf"]
        act_ids = [r[0] for r in actionable]

        log.info("Flagged in CSV: %d (text-layer=%d, scanned-URL=%d)",
                 len(all_ids), len(text_flagged), len(url_flagged))
        if already:
            log.info("Skipping %d already re-labelled / removed earlier.",
                     len(already))
        if not act_ids:
            log.info("Nothing left to act on.")
            return 0

        ds = get_downstream(conn, act_ids)
        action = "DELETE" if args.delete else "RE-LABEL -> policy_manual"
        log.info("=" * 70)
        log.info("%d documents to %s:", len(act_ids), action)
        for doc_id, name, unit, url, _dt in actionable:
            src = "text" if doc_id in text_flagged else "url"
            log.info("  #%-5s [%s] %-32s %s", doc_id, src,
                     (name or "?")[:32], (url or "")[:70])
        log.info("Downstream to remove: %d contracts, %d contract_provisions, "
                 "%d extraction_runs", len(ds["contract_ids"]),
                 ds["n_provisions"], ds["n_runs"])
        if ds["n_settlements"]:
            log.warning("These docs have %d derived settlements -- review before "
                        "deleting; they will be removed too.", ds["n_settlements"])

        if not args.apply:
            log.info("-" * 70)
            log.info("DRY RUN -- nothing changed. Re-run with --apply to act.")
            return 0

        # --- apply, all-or-nothing (the connection is already in a single
        # transaction; commit() at the end makes it all-or-nothing) ---
        cur = conn.cursor()
        # Delete children before the rows they reference (FKs have no cascade):
        # settlements reference BOTH source_documents and contracts, so they must
        # go before contracts, not after. contract_provisions -> contracts last.
        cur.execute("DELETE FROM settlements WHERE source_doc_id = ANY(%s)",
                    (act_ids,))
        if ds["contract_ids"]:
            cur.execute("DELETE FROM settlements WHERE contract_id = ANY(%s)",
                        (ds["contract_ids"],))
            cur.execute(
                "DELETE FROM contract_provisions WHERE contract_id = ANY(%s)",
                (ds["contract_ids"],))
            cur.execute("DELETE FROM contracts WHERE id = ANY(%s)",
                        (ds["contract_ids"],))
        cur.execute("DELETE FROM extraction_runs WHERE source_doc_id = ANY(%s)",
                    (act_ids,))
        if args.delete:
            cur.execute("DELETE FROM source_documents WHERE id = ANY(%s) "
                        "AND doc_type = 'cba_pdf'", (act_ids,))
            n_docs = cur.rowcount
        else:
            ensure_doc_type_constraint(cur)  # reproducible on stale environments
            cur.execute("UPDATE source_documents SET doc_type = 'policy_manual' "
                        "WHERE id = ANY(%s) AND doc_type = 'cba_pdf'", (act_ids,))
            n_docs = cur.rowcount
        conn.commit()
        cur.close()

        log.info("=" * 70)
        log.info("Done. %s %d documents; removed %d contracts, %d "
                 "contract_provisions, %d extraction_runs.",
                 "Deleted" if args.delete else "Re-labelled", n_docs,
                 len(ds["contract_ids"]), ds["n_provisions"], ds["n_runs"])
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
