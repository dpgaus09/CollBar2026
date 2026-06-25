#!/usr/bin/env python3
"""Extract salary-schedule grids from CBA PDFs into the
contract_salary_schedules / contract_salary_schedule_cells tables.

Parsing lives in lib_salary_grid (pure, unit-tested). This script owns
selection (which contracts/PDFs), PDF resolution, bargaining-unit provenance,
and idempotent storage.

SHARED-PDF ROUTING: one CBA PDF often backs several contract rows (one per
bargaining unit: teachers, support_staff, secretarial_clerical). We parse the
PDF once and ROUTE each parsed schedule to the contract whose unit it actually
belongs to (by content), instead of stamping every schedule onto every sibling.
Education/teacher schedules go ONLY to the teachers contract — they are never
attributed to a non-teacher unit (which would show BA/MA grids to, say,
custodians). A schedule whose unit has no matching contract on the PDF is left
unattributed (counted, not stored). Within a unit, the appendix heading still
only distinguishes job families (e.g. the teachers unit may contain "Teachers",
"Counselors/Social Workers", "Psychologist/Speech Pathologist" sub-schedules).

Idempotency: every run replaces all schedules for a contract atomically
(delete-then-insert in one transaction), so re-running never duplicates rows.
Every contract in a processed source-doc group is rewritten — INCLUDING those
that now route to zero schedules — so stale/leaked rows are always cleared.

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
import lib_salary_vision as vision

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


def fetch_doc_units(cur, source_doc_id) -> set[str]:
    """All bargaining units whose contracts reference this source_doc. Routing
    needs the FULL sibling set (not just the selected targets) so it can decide
    e.g. whether a teachers contract exists to receive the education grid."""
    cur.execute(
        "SELECT DISTINCT COALESCE(bargaining_unit, 'teachers') "
        "FROM contracts WHERE source_doc_id = %s",
        (source_doc_id,),
    )
    return {r[0] for r in cur.fetchall()}


def route_schedules(schedules: list[dict],
                    sibling_units: set[str]) -> tuple[dict[str, list[dict]],
                                                      list[dict]]:
    """Partition parsed schedules by the bargaining unit they belong to, given
    the units whose contracts share this PDF.

    - Education/teacher schedules go ONLY to 'teachers'; with no teachers
      contract on the PDF they are unattributed (never stamped on another unit).
    - A schedule that names a specific non-teacher family goes to that unit when
      a sibling contract has it.
    - Anything else (ambiguous, or a family with no sibling) goes to the PDF's
      primary unit — teachers if present, else the lexically-first sibling — but
      an education schedule is never routed to a non-teacher primary.

    Returns ({unit: [schedules]}, [unattributed schedules])."""
    primary = ("teachers" if "teachers" in sibling_units
               else (sorted(sibling_units)[0] if sibling_units else None))
    routed: dict[str, list[dict]] = {}
    unattributed: list[dict] = []
    for s in schedules:
        unit = grid.classify_schedule_unit(s)
        if unit == "teachers":
            if "teachers" in sibling_units:
                routed.setdefault("teachers", []).append(s)
            else:
                unattributed.append(s)
        elif unit is not None and unit in sibling_units:
            routed.setdefault(unit, []).append(s)
        elif primary is not None and not grid.is_education_schedule(s):
            routed.setdefault(primary, []).append(s)
        else:
            unattributed.append(s)
    return routed, unattributed


def _resolve_pdf(target: dict, pdf_override: str | None):
    return (
        Path(pdf_override) if pdf_override
        else resolve_pdf_path(target["source_url"], target["storage_key"])
    )


def _parse_pdf_with_fallback(pdf_path, *, use_vision: bool = True,
                             vision_max_pages: int = vision.DEFAULT_MAX_PAGES) -> list[dict]:
    """Parse all schedules. If none are found and the PDF has no usable text
    layer it is scanned — deterministic grid parsing needs word boxes OCR-text
    cannot give, so try Claude vision (render pages -> read the grid). If vision
    is disabled, finds nothing, or errors, fall back to a flag-and-defer
    placeholder so the doc lands in review instead of being dropped silently."""
    schedules = grid.parse_pdf(str(pdf_path))
    if schedules:
        return schedules

    try:
        wc, npages = grid.pdf_text_stats(str(pdf_path))
    except Exception:  # noqa: BLE001
        wc, npages = 0, 1
    if not grid.is_scanned(wc, npages):
        return schedules  # digital PDF with no detectable grid — nothing to add

    if use_vision:
        try:
            vsched = vision.extract_schedules(str(pdf_path), npages,
                                              max_pages=vision_max_pages)
            if vsched:
                return vsched
        except Exception as e:  # noqa: BLE001 - vision must never crash the batch
            log.warning("vision extraction failed for %s: %s", pdf_path, e)
    return [grid.scanned_placeholder(npages)]


def store_schedules(conn, target: dict, schedules: list[dict],
                    dry_run: bool = False) -> tuple[int, int]:
    """Replace all salary schedules for a contract. Returns (n_schedules,
    n_cells) written."""
    contract_id = target["contract_id"]
    n_sched = n_cells = 0

    # Dedupe by the DB unique key (schedule_name, school_year) BEFORE inserting.
    # A single PDF can yield two schedules that collapse to the same (name, year)
    # — e.g. the same grid detected on two pages, or a duplicated appendix. Two
    # such rows violate contract_salary_schedules_uniq, and because the whole
    # contract is one delete-then-insert transaction the collision would roll
    # back ALL of the contract's schedules (leaving it empty). Keep only the
    # richest of each colliding group: most cells, then confidence, then steps.
    def _effective_year(s: dict) -> str:
        return s["school_year"] or f"unknown-p{s['page_start']}"

    def _richness(s: dict) -> tuple:
        return (len(s["cells"]), s.get("confidence") or 0, s.get("step_count") or 0)

    deduped: dict[tuple[str, str], dict] = {}
    for s in schedules:
        key = (s["schedule_name"], _effective_year(s))
        prev = deduped.get(key)
        if prev is None or _richness(s) > _richness(prev):
            deduped[key] = s
    schedules = list(deduped.values())

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


def _store_routed(conn, group: list[dict], routed: dict[str, list[dict]],
                  dry_run: bool) -> list[dict]:
    """Store each target's routed subset. Every target is rewritten (delete +
    insert) even when it routes to ZERO schedules, so stale/leaked rows clear."""
    results = []
    for t in group:
        subset = routed.get(t["bargaining_unit"], [])
        try:
            n_sched, n_cells = store_schedules(conn, t, subset, dry_run)
        except Exception as e:  # noqa: BLE001 - one bad contract must not poison the batch
            conn.rollback()
            log.exception("contract %s store failed: %s", t["contract_id"], e)
            results.append({"contract_id": t["contract_id"],
                            "status": "store_error",
                            "schedules": 0, "cells": 0, "flagged": 0})
            continue
        flagged = sum(1 for s in subset if s["needs_review"])
        log.info("contract %s (%s) [%s]: %d schedules, %d cells, %d flagged%s",
                 t["contract_id"], t.get("district_name", "?"),
                 t["bargaining_unit"], n_sched, n_cells, flagged,
                 " [dry-run]" if dry_run else "")
        results.append({"contract_id": t["contract_id"], "status": "ok",
                        "schedules": n_sched, "cells": n_cells,
                        "flagged": flagged})
    return results


def process_doc_group(conn, group: list[dict], sibling_units: set[str],
                      pdf_override: str | None,
                      dry_run: bool, *, use_vision: bool = True,
                      vision_max_pages: int = vision.DEFAULT_MAX_PAGES,
                      ) -> tuple[list[dict], int]:
    """Parse one shared PDF once and route its schedules to the right contract.

    ``group`` are the target contracts to write (all sharing one source_doc);
    ``sibling_units`` is every unit on that doc (for routing). Returns
    (per-contract results, count of unattributed schedules)."""
    rep = group[0]
    pdf_path = _resolve_pdf(rep, pdf_override)
    if not pdf_path or not Path(pdf_path).exists():
        log.warning("source_doc %s (%s): PDF not found (%s)",
                    rep["source_doc_id"], rep.get("district_name", "?"),
                    pdf_override or rep.get("storage_key"))
        return ([{"contract_id": t["contract_id"], "status": "no_pdf",
                  "schedules": 0, "cells": 0, "flagged": 0} for t in group], 0)
    try:
        schedules = _parse_pdf_with_fallback(
            pdf_path, use_vision=use_vision, vision_max_pages=vision_max_pages)
    except Exception as e:  # noqa: BLE001 - record, don't crash the batch
        log.exception("source_doc %s parse failed: %s", rep["source_doc_id"], e)
        return ([{"contract_id": t["contract_id"], "status": "parse_error",
                  "schedules": 0, "cells": 0, "flagged": 0} for t in group], 0)

    routed, unattributed = route_schedules(schedules, sibling_units)
    if unattributed:
        log.info("source_doc %s (%s): %d schedule(s) unattributed — no matching "
                 "unit contract on this PDF; not stored",
                 rep["source_doc_id"], rep.get("district_name", "?"),
                 len(unattributed))
    return _store_routed(conn, group, routed, dry_run), len(unattributed)


def extract_for_contract(conn, *, contract_id: int, pdf_path,
                         dry_run: bool = False) -> dict:
    """Parse + store salary grids for a single already-upserted contract.

    Intended to be called from the load pipeline (06_extract_contracts.main)
    immediately after upsert_contract, reusing the already-resolved PDF path.
    The contract row is the authoritative bargaining-unit source. We look up the
    full sibling set on this PDF and ROUTE by content so this contract receives
    only the schedules that belong to its unit — a teacher grid is never stored
    under a non-teacher contract even when they share the PDF.
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
        sibling_units = fetch_doc_units(cur, source_doc_id)
    target = {
        "contract_id": contract_id, "district_id": district_id,
        "source_doc_id": source_doc_id, "bargaining_unit": unit,
        "source_url": None, "storage_key": None, "district_name": dname,
    }
    # Store only THIS contract (group of one), but route using the full sibling
    # set so an education grid on a non-teacher contract is withheld, not leaked.
    results, _ = process_doc_group(conn, [target], sibling_units,
                                   str(pdf_path), dry_run)
    return results[0]


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
    ap.add_argument("--no-vision", action="store_true",
                    help="disable the Claude-vision fallback for scanned PDFs "
                         "(scanned docs then defer to review as before)")
    ap.add_argument("--vision-max-pages", type=int,
                    default=vision.DEFAULT_MAX_PAGES,
                    help="cap on pages sent to vision for high-res extraction "
                         f"(default {vision.DEFAULT_MAX_PAGES})")
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

        # Group targets by the PDF they share so each PDF is parsed ONCE and its
        # schedules routed to the correct unit contract (no cross-unit leak).
        groups: dict = {}
        for t in targets:
            groups.setdefault(t["source_doc_id"], []).append(t)
        log.info("processing %d contract(s) across %d source doc(s)%s",
                 len(targets), len(groups),
                 " [dry-run]" if args.dry_run else "")

        totals = {"ok": 0, "no_pdf": 0, "parse_error": 0, "store_error": 0,
                  "schedules": 0, "cells": 0, "flagged": 0, "unattributed": 0}
        with conn.cursor() as scur:
            for source_doc_id, group in groups.items():
                sibling_units = fetch_doc_units(scur, source_doc_id)
                results, n_unattr = process_doc_group(
                    conn, group, sibling_units, args.pdf, args.dry_run,
                    use_vision=not args.no_vision,
                    vision_max_pages=args.vision_max_pages)
                for r in results:
                    totals[r["status"]] = totals.get(r["status"], 0) + 1
                    totals["schedules"] += r["schedules"]
                    totals["cells"] += r["cells"]
                    totals["flagged"] += r.get("flagged", 0)
                totals["unattributed"] += n_unattr
        log.info(
            "DONE: %d ok, %d no_pdf, %d parse_error, %d store_error | "
            "%d schedules, %d cells, %d flagged, %d unattributed",
            totals["ok"], totals["no_pdf"], totals["parse_error"],
            totals["store_error"], totals["schedules"], totals["cells"],
            totals["flagged"], totals["unattributed"],
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
