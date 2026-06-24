#!/usr/bin/env python3
"""Extract salary-schedule grids from CBA PDFs into the
contract_salary_schedules / contract_salary_schedule_cells tables.

Parsing lives in lib_salary_grid (pure, unit-tested). This script owns
selection (which contracts/PDFs), PDF resolution, bargaining-unit provenance,
and idempotent storage.

INVARIANT: a schedule's bargaining_unit always comes from its contract row
(never inferred from the appendix). The appendix heading only distinguishes job
families *within* that unit (e.g. the teachers unit may contain "Teachers",
"Counselors/Social Workers", "Psychologist/Speech Pathologist" sub-schedules).

Idempotency: every run replaces all schedules for a contract atomically
(delete-then-insert in one transaction), so re-running never duplicates rows.

Examples:
    python3 18_extract_salary_schedules.py --contract 123 --pdf /path/to.pdf
    python3 18_extract_salary_schedules.py --district "Joliet" --state IL
    python3 18_extract_salary_schedules.py --state IL --limit 25
"""
from __future__ import annotations

import argparse
import importlib
import json
import logging
from pathlib import Path

import psycopg2.extras

import common
import lib_salary_grid as grid

# resolve_pdf_path lives in 06_extract_contracts (module name starts with a
# digit, so it must be imported via importlib).
_extract = importlib.import_module("06_extract_contracts")
resolve_pdf_path = _extract.resolve_pdf_path

log = logging.getLogger("salary_grid")


def fetch_targets(cur, args) -> list[dict]:
    where = ["sd.doc_type = 'cba_pdf'"]
    params: list = []
    if args.contract:
        where.append("c.id = %s")
        params.append(args.contract)
    if args.district:
        where.append("(d.state_district_id = %s OR d.name ILIKE %s)")
        params.extend([args.district, f"%{args.district}%"])
    if args.state:
        where.append("d.state = %s")
        params.append(args.state)
    if getattr(args, "only_missing", False):
        where.append(
            "NOT EXISTS (SELECT 1 FROM contract_salary_schedules s "
            "WHERE s.contract_id = c.id)"
        )
    sql = f"""
        SELECT c.id              AS contract_id,
               c.district_id     AS district_id,
               c.source_doc_id   AS source_doc_id,
               COALESCE(c.bargaining_unit, 'teachers') AS bargaining_unit,
               sd.source_url     AS source_url,
               sd.storage_key    AS storage_key,
               d.name            AS district_name
        FROM contracts c
        JOIN source_documents sd ON sd.id = c.source_doc_id
        JOIN districts d ON d.id = c.district_id
        WHERE {' AND '.join(where)}
        ORDER BY c.id
    """
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"
    cur.execute(sql, params)
    cols = [c.name for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def store_schedules(conn, target: dict, schedules: list[dict],
                    dry_run: bool = False) -> tuple[int, int]:
    """Replace all salary schedules for a contract. Returns (n_schedules,
    n_cells) written."""
    contract_id = target["contract_id"]
    n_sched = n_cells = 0
    with conn.cursor() as cur:
        if not dry_run:
            cur.execute(
                "DELETE FROM contract_salary_schedules WHERE contract_id = %s",
                (contract_id,),
            )
        for s in schedules:
            school_year = s["school_year"]
            needs_review = s["needs_review"]
            review_reason = s["review_reason"]
            # school_year is NOT NULL and part of the unique key. If the parser
            # could not detect a year, synthesize a stable placeholder and flag
            # for review rather than dropping the schedule.
            if not school_year:
                school_year = f"unknown-p{s['page_start']}"
                needs_review = True
                review_reason = ";".join(
                    sorted(set((review_reason or "").split(";")) | {"missing_year"})
                ).strip(";")

            raw = {k: v for k, v in s.items() if k != "cells"}
            if dry_run:
                n_sched += 1
                n_cells += len(s["cells"])
                continue

            cur.execute(
                """
                INSERT INTO contract_salary_schedules
                  (contract_id, district_id, bargaining_unit, source_doc_id,
                   schedule_name, school_year, start_year, schedule_type,
                   lane_labels, step_count, lane_count, page_start, page_end,
                   min_salary, max_salary, confidence, needs_review,
                   review_reason, extraction_method, raw_json)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
                """,
                (
                    contract_id, target["district_id"],
                    target["bargaining_unit"], target["source_doc_id"],
                    s["schedule_name"], school_year, s["start_year"],
                    s["schedule_type"],
                    json.dumps(s["lane_labels"]) if s["lane_labels"] else None,
                    s["step_count"], s["lane_count"], s["page_start"],
                    s["page_end"], s["min_salary"], s["max_salary"],
                    s["confidence"], needs_review, review_reason,
                    s["extraction_method"], json.dumps(raw),
                ),
            )
            sid = cur.fetchone()[0]
            cell_rows = [
                (sid, c["step_label"], c["step_order"], c["lane_label"],
                 c["lane_order"], c["salary_amount"], c["page_ref"])
                for c in s["cells"]
            ]
            if cell_rows:  # scanned/placeholder schedules carry no cells
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO contract_salary_schedule_cells
                      (schedule_id, step_label, step_order, lane_label, lane_order,
                       salary_amount, page_ref)
                    VALUES %s
                    """,
                    cell_rows,
                )
            n_sched += 1
            n_cells += len(cell_rows)
    if not dry_run:
        conn.commit()
    return n_sched, n_cells


def process_target(conn, target: dict, pdf_override: str | None,
                   dry_run: bool) -> dict:
    pdf_path = (
        Path(pdf_override) if pdf_override
        else resolve_pdf_path(target["source_url"], target["storage_key"])
    )
    if not pdf_path or not Path(pdf_path).exists():
        log.warning("contract %s (%s): PDF not found (%s)",
                    target["contract_id"], target["district_name"],
                    pdf_override or target["storage_key"])
        return {"contract_id": target["contract_id"], "status": "no_pdf",
                "schedules": 0, "cells": 0}
    try:
        schedules = grid.parse_pdf(str(pdf_path))
    except Exception as e:  # noqa: BLE001 - record, don't crash the batch
        log.exception("contract %s parse failed: %s",
                      target["contract_id"], e)
        return {"contract_id": target["contract_id"], "status": "parse_error",
                "schedules": 0, "cells": 0}

    # No schedules parsed: if the PDF has no usable text layer it is scanned —
    # flag-and-defer with a placeholder (deterministic grid parsing needs word
    # boxes that text-only OCR cannot provide; real OCR/vision is a follow-up).
    if not schedules:
        try:
            wc, npages = grid.pdf_text_stats(str(pdf_path))
        except Exception:  # noqa: BLE001
            wc, npages = 0, 1
        if grid.is_scanned(wc, npages):
            log.info("contract %s (%s): scanned/no-text PDF — flagging for review",
                     target["contract_id"], target["district_name"])
            schedules = [grid.scanned_placeholder(npages)]

    try:
        n_sched, n_cells = store_schedules(conn, target, schedules, dry_run)
    except Exception as e:  # noqa: BLE001 - one bad contract must not poison the batch
        conn.rollback()
        log.exception("contract %s store failed: %s", target["contract_id"], e)
        return {"contract_id": target["contract_id"], "status": "store_error",
                "schedules": 0, "cells": 0}
    flagged = sum(1 for s in schedules if s["needs_review"])
    log.info("contract %s (%s): %d schedules, %d cells, %d flagged%s",
             target["contract_id"], target["district_name"], n_sched, n_cells,
             flagged, " [dry-run]" if dry_run else "")
    return {"contract_id": target["contract_id"], "status": "ok",
            "schedules": n_sched, "cells": n_cells, "flagged": flagged}


def extract_for_contract(conn, *, contract_id: int, pdf_path,
                         dry_run: bool = False) -> dict:
    """Parse + store salary grids for a single already-upserted contract.

    Intended to be called from the load pipeline (06_extract_contracts.main)
    immediately after upsert_contract, reusing the already-resolved PDF path.
    The contract row is the authoritative bargaining-unit source (never the
    appendix), so we look it up here rather than trusting the caller.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT c.district_id, c.source_doc_id,
                   COALESCE(c.bargaining_unit, 'teachers'), d.name
            FROM contracts c JOIN districts d ON d.id = c.district_id
            WHERE c.id = %s
            """,
            (contract_id,),
        )
        row = cur.fetchone()
    if not row:
        return {"contract_id": contract_id, "status": "no_contract",
                "schedules": 0, "cells": 0}
    district_id, source_doc_id, unit, dname = row
    target = {
        "contract_id": contract_id, "district_id": district_id,
        "source_doc_id": source_doc_id, "bargaining_unit": unit,
        "source_url": None, "storage_key": None, "district_name": dname,
    }
    return process_target(conn, target, str(pdf_path), dry_run)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--contract", type=int, help="single contract id")
    ap.add_argument("--district", help="state_district_id or name substring")
    ap.add_argument("--state", help="two-letter state filter, e.g. IL")
    ap.add_argument("--pdf", help="explicit PDF path (single-contract override)")
    ap.add_argument("--limit", type=int, help="max contracts to process")
    ap.add_argument("--only-missing", action="store_true",
                    help="skip contracts that already have salary schedules "
                         "(resumable backfill)")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse and report without writing")
    args = ap.parse_args()

    common.setup_logging()
    if args.pdf and not args.contract:
        ap.error("--pdf requires --contract")

    conn = common.get_db_conn()
    try:
        with conn.cursor() as cur:
            targets = fetch_targets(cur, args)
        if not targets:
            log.warning("no matching contracts")
            return
        log.info("processing %d contract(s)%s", len(targets),
                 " [dry-run]" if args.dry_run else "")
        totals = {"ok": 0, "no_pdf": 0, "parse_error": 0, "store_error": 0,
                  "schedules": 0, "cells": 0, "flagged": 0}
        for t in targets:
            r = process_target(conn, t, args.pdf, args.dry_run)
            totals[r["status"]] = totals.get(r["status"], 0) + 1
            totals["schedules"] += r["schedules"]
            totals["cells"] += r["cells"]
            totals["flagged"] += r.get("flagged", 0)
        log.info(
            "DONE: %d ok, %d no_pdf, %d parse_error, %d store_error | "
            "%d schedules, %d cells, %d flagged",
            totals["ok"], totals["no_pdf"], totals["parse_error"],
            totals["store_error"], totals["schedules"], totals["cells"],
            totals["flagged"],
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
