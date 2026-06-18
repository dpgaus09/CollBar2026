#!/usr/bin/env python3
"""
Clean up stored non-CBA documents flagged by the read-only audit (board agendas/
minutes/packets, handbooks, employment applications, parking/facilities-use
agreements, code-of-conduct policies, ...).

``14_audit_stored_cbas.py`` classifies every stored ``doc_type='cba_pdf'`` row and
writes ``stored_cba_audit.csv``. Many rows come back ``classification='not-CBA'``.
They were captured by early crawls before the content classifier existed and they
pollute downstream LLM extraction, the public dashboard, and comparables.

``15_purge_policy_manuals.py`` already owns the IASB PRESS *board-policy manual*
subset (rows whose classifier ``detail`` contains ``policy_manual``). THIS script
handles the rest -- and ONLY the rows it can confidently call non-contracts:

  CONFIDENT (acted on) -- has a positive non-contract signal:
    * a strong board-meeting signal (agenda phrase count >= AGENDA_MIN), or
    * a source_url / filename that unambiguously names a non-contract
      (agenda, minutes, board packet/report, handbook, calendar, newsletter,
       parking, facilities-use, code-of-conduct, employment application,
       enrollment/registration, lunch/menu/food-service, ...),
    ...AND whose filename does NOT name a collective-bargaining agreement.

  BORDERLINE (held for human review, NEVER auto-acted) -- everything else:
    * thin/opaque rows: an opaque viewer URL with no descriptive filename and no
      content signals (title=body=agenda=0). These could be a misclassified real
      CBA or a scanned doc; the task requires they be hand-checked, not bulk-
      deleted.
    * any row whose filename DOES name a CBA / collective-bargaining / negotiated
      / master agreement (e.g. "Lostant CBA 2025-2028.pdf") -- the single most
      likely classifier false positive.

Confident rows are re-labelled ``doc_type='non_cba'`` (the default -- reversible,
keeps provenance) or deleted with ``--delete``; the bogus downstream rows they
produced (``contracts`` + ``contract_provisions``, ``extraction_runs``,
``settlements``) are removed so they stop feeding extraction and benchmarks.
Borderline rows are written to a review CSV (default
``pipeline/data/non_cba_review.csv``) for a person to confirm before any action.

Safety:
  - Defaults to a dry run: prints exactly what it would change and writes only the
    (non-destructive) review CSV. Pass ``--apply`` to perform the change inside a
    single transaction.
  - Re-labelling is the default; ``--delete`` removes the source_documents rows.
  - Only rows still at ``doc_type='cba_pdf'`` are acted on (idempotent re-runs).

Usage:
    # See what would happen (no DB changes); writes the review CSV:
    python3 pipeline/16_purge_non_cbas.py

    # Re-label confident non-CBAs to doc_type='non_cba' and clean the bogus
    # contracts/extraction_runs they produced:
    python3 pipeline/16_purge_non_cbas.py --apply

    # Delete the rows entirely instead of re-labelling:
    python3 pipeline/16_purge_non_cbas.py --apply --delete
"""
import argparse
import csv
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

DEFAULT_CSV = common.DATA_DIR / "stored_cba_audit.csv"
DEFAULT_REVIEW_OUT = common.DATA_DIR / "non_cba_review.csv"

# Board-meeting phrase count (from the classifier ``detail``) at or above which a
# document is a confident agenda/minutes/packet rather than a contract.
AGENDA_MIN = 3

# Parses the classifier detail string, e.g.
#   "title=1 body=3 agenda=10 policy=0/9 kw=2 -> not-CBA"
_DETAIL_RE = re.compile(
    r"title=(\d+)\s+body=(\d+)\s+agenda=(\d+)\s+policy=(\d+)/(\d+)\s+kw=(\d+)")

# Filenames that unambiguously name a collective-bargaining agreement. A row whose
# URL matches is NEVER auto-acted: it is the most likely classifier false positive
# (a real CBA the content classifier missed), so it is held for human review.
_CONTRACT_NAME_RE = re.compile(
    r"\bcba\b"
    r"|collective[_\s%+-]*bargain"
    r"|negotiated[_\s%+-]*agreement"
    r"|master[_\s%+-]*agreement"
    r"|(teacher|education|support|custodial|secretar|paraprof)[a-z]*[_\s%+-]*assoc",
    re.IGNORECASE,
)

# Filenames that unambiguously name a NON-contract. Deliberately specific tokens --
# never a bare "contract"/"agreement" (cf. "Parking Contract", "Facilities-Use
# Agreement", which ARE non-contracts and are caught by their specific words).
_NON_CONTRACT_NAME_RE = re.compile(
    r"agenda"
    r"|minutes"
    r"|board[_\s%+-]*(meeting|packet|pkt|report|rpt|display|session)"
    r"|handbook"
    r"|calendar"
    r"|newsletter"
    r"|parking"
    r"|facilit"
    r"|code[_\s%+-]*of[_\s%+-]*conduct"
    r"|employment[_\s%+-]*application"
    r"|application[_\s%+-]*for[_\s%+-]*employment"
    r"|enrollment|registration"
    r"|lunch|menu|food[_\s%+-]*service"
    r"|for[_\s%+-]*new[_\s%+-]*teacher",
    re.IGNORECASE,
)

# Allowed doc_type values, kept in lockstep with the Drizzle schema CHECK in
# lib/db/src/schema/source_documents.ts. This repo applies schema via drizzle-kit
# push, which wants to TRUNCATE populated tables, so additive constraint changes
# are applied via raw SQL instead. ensure_doc_type_constraint makes the relabel
# reproducible on any environment whose constraint predates the 'non_cba' value.
_DOC_TYPES = (
    "cba_pdf", "mou", "factfinding_report", "wage_settlement_report",
    "cdss_extract", "directory", "stats", "policy_manual", "non_cba",
)


def ensure_doc_type_constraint(cur) -> None:
    """Idempotently widen the doc_type CHECK to include all _DOC_TYPES."""
    values = ",".join(f"'{v}'" for v in _DOC_TYPES)
    cur.execute("ALTER TABLE source_documents "
                "DROP CONSTRAINT IF EXISTS source_documents_doc_type_check")
    cur.execute("ALTER TABLE source_documents ADD CONSTRAINT "
                f"source_documents_doc_type_check CHECK (doc_type IN ({values}))")


def classify_row(detail: str, url: str) -> tuple[str, str]:
    """Bucket a not-CBA row. Returns (bucket, reason).

    bucket is 'confident' (safe to act on) or 'borderline' (hold for review).
    """
    detail = detail or ""
    url = url or ""
    if _CONTRACT_NAME_RE.search(url):
        return "borderline", "filename names a CBA (likely false positive)"
    m = _DETAIL_RE.search(detail)
    agenda = int(m.group(3)) if m else 0
    if agenda >= AGENDA_MIN:
        return "confident", f"board-meeting signal (agenda={agenda})"
    if _NON_CONTRACT_NAME_RE.search(url):
        return "confident", "filename names a non-contract"
    return "borderline", "no positive non-contract signal (thin/opaque)"


def select_from_csv(csv_path: Path) -> tuple[dict[int, dict], dict[int, dict]]:
    """Return (confident, borderline) maps: doc_id -> {row, reason}.

    Only ``classification='not-CBA'`` rows are considered. Rows whose ``detail``
    contains 'policy_manual' are skipped entirely -- they belong to
    15_purge_policy_manuals.py.
    """
    confident: dict[int, dict] = {}
    borderline: dict[int, dict] = {}
    with open(csv_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if (row.get("classification") or "") != "not-CBA":
                continue
            try:
                doc_id = int(row["doc_id"])
            except (KeyError, ValueError):
                continue
            detail = row.get("detail") or ""
            if "policy_manual" in detail:
                continue  # owned by 15_purge_policy_manuals.py
            bucket, reason = classify_row(detail, row.get("source_url") or "")
            entry = {"row": row, "reason": reason}
            (confident if bucket == "confident" else borderline)[doc_id] = entry
    return confident, borderline


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


def write_review_csv(path: Path, borderline: dict[int, dict]) -> None:
    """Write the held-for-review rows so a person can confirm before action."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = ["doc_id", "district_name", "state", "school_year",
              "bargaining_unit", "hold_reason", "detail", "source_url"]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for doc_id in sorted(borderline):
            row = borderline[doc_id]["row"]
            writer.writerow({
                "doc_id": doc_id,
                "district_name": row.get("district_name", ""),
                "state": row.get("state", ""),
                "school_year": row.get("school_year", ""),
                "bargaining_unit": row.get("bargaining_unit", ""),
                "hold_reason": borderline[doc_id]["reason"],
                "detail": row.get("detail", ""),
                "source_url": row.get("source_url", ""),
            })


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV,
                    help=f"Audit CSV from 14_audit_stored_cbas.py "
                         f"(default: {DEFAULT_CSV}).")
    ap.add_argument("--review-out", type=Path, default=DEFAULT_REVIEW_OUT,
                    help=f"Where to write the held-for-review CSV "
                         f"(default: {DEFAULT_REVIEW_OUT}).")
    ap.add_argument("--apply", action="store_true",
                    help="Perform the change. Without this it is a dry run.")
    ap.add_argument("--delete", action="store_true",
                    help="Delete source_documents rows instead of re-labelling "
                         "them to doc_type='non_cba'.")
    args = ap.parse_args()

    if not args.csv.exists():
        log.error("Audit CSV not found: %s. Run 14_audit_stored_cbas.py first.",
                  args.csv)
        return 1

    confident, borderline = select_from_csv(args.csv)

    # The held-for-review list is a (non-destructive) report; always write it.
    write_review_csv(args.review_out, borderline)
    log.info("Borderline (held for review): %d -> %s",
             len(borderline), args.review_out)

    if not confident:
        log.info("No confident non-CBA documents to act on. Nothing to do.")
        return 0

    conn = common.get_db_conn()
    try:
        cur = conn.cursor()
        # Only act on rows still labelled cba_pdf (idempotent).
        cur.execute(
            "SELECT sd.id, d.name, sd.bargaining_unit, sd.source_url, sd.doc_type "
            "FROM source_documents sd LEFT JOIN districts d ON d.id = sd.district_id "
            "WHERE sd.id = ANY(%s) ORDER BY sd.id", (list(confident),))
        live = cur.fetchall()
        cur.close()

        actionable = [r for r in live if r[4] == "cba_pdf"]
        already = [r for r in live if r[4] != "cba_pdf"]
        act_ids = [r[0] for r in actionable]

        log.info("Confident non-CBAs in CSV: %d", len(confident))
        if already:
            log.info("Skipping %d already re-labelled / removed earlier.",
                     len(already))
        if not act_ids:
            log.info("Nothing left to act on.")
            return 0

        ds = get_downstream(conn, act_ids)
        action = "DELETE" if args.delete else "RE-LABEL -> non_cba"
        log.info("=" * 70)
        log.info("%d documents to %s:", len(act_ids), action)
        for doc_id, name, _unit, url, _dt in actionable:
            reason = confident[doc_id]["reason"]
            log.info("  #%-5s %-26s %-34s %s", doc_id, reason[:26],
                     (name or "?")[:34], (url or "")[:70])
        log.info("Downstream to remove: %d contracts, %d contract_provisions, "
                 "%d extraction_runs", len(ds["contract_ids"]),
                 ds["n_provisions"], ds["n_runs"])
        if ds["n_settlements"]:
            log.warning("These docs have %d derived settlements -- they will be "
                        "removed too.", ds["n_settlements"])

        if not args.apply:
            log.info("-" * 70)
            log.info("DRY RUN -- nothing changed in the DB. Re-run with --apply.")
            return 0

        # --- apply, all-or-nothing in one transaction ---
        cur = conn.cursor()
        # Delete children before the rows they reference (FKs have no cascade):
        # settlements reference BOTH source_documents and contracts, so they go
        # before contracts; contract_provisions -> contracts last.
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
            cur.execute("UPDATE source_documents SET doc_type = 'non_cba' "
                        "WHERE id = ANY(%s) AND doc_type = 'cba_pdf'", (act_ids,))
            n_docs = cur.rowcount
        conn.commit()
        cur.close()

        log.info("=" * 70)
        log.info("Done. %s %d documents; removed %d contracts, %d "
                 "contract_provisions, %d extraction_runs. %d held for review.",
                 "Deleted" if args.delete else "Re-labelled", n_docs,
                 len(ds["contract_ids"]), ds["n_provisions"], ds["n_runs"],
                 len(borderline))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
