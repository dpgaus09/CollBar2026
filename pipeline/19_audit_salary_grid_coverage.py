#!/usr/bin/env python3
"""Diagnose salary-grid coverage gaps for IL teacher contracts (READ-ONLY).

The salary-grid feature is correct but low-recall: only ~a third of IL teacher
contracts show a real grid. This script measures the gap precisely so effort
targets the largest *recoverable* buckets rather than rare edge cases.

For every IL ``teachers`` contract backed by a ``cba_pdf`` that does NOT already
have a real stored grid (a lane_grid/single_column with cells and no
implausible-magnitude flag), it resolves the PDF, inspects the text layer, and
re-parses it with ``lib_salary_grid`` to bucket the failure cause:

  * no_pdf                — the source PDF could not be resolved on disk.
  * scanned_no_text       — image-only PDF (no usable text layer); needs OCR.
  * parsed_implausible    — a teacher grid parsed but failed the magnitude
                            sanity check (correctly withheld).
  * parsed_unattributed   — schedules parsed but none route to the teachers unit.
  * recoverable_now       — the parser DOES find a teacher grid now (stale row;
                            a re-extract would store it).
  * no_candidate_table    — readable text layer but the parser finds no grid.
                            THIS is the prime recoverable bucket; for these the
                            report records text signals (money tokens, education
                            lanes, bare-digit step rows, textual "Step N" rows,
                            punctuated step rows like "1.") so the missed layout
                            families are visible.

Strictly read-only: it never writes to the database. Emits a per-contract CSV
and a bucket summary.

Usage:
    python3 pipeline/19_audit_salary_grid_coverage.py
    python3 pipeline/19_audit_salary_grid_coverage.py --state IL --out data/x.csv
    python3 pipeline/19_audit_salary_grid_coverage.py --limit 20   # spot-check
"""
from __future__ import annotations

import argparse
import csv
import importlib
import logging
import re
from collections import Counter
from pathlib import Path
from typing import Optional

import common
import lib_salary_grid as grid

_extract = importlib.import_module("06_extract_contracts")
resolve_pdf_path = _extract.resolve_pdf_path

common.setup_logging()
log = logging.getLogger("salary_audit")

DEFAULT_OUT = common.DATA_DIR / "salary_grid_coverage_audit.csv"

# Textual "Step 1" style row: a step keyword + number leads the line.
_TEXT_STEP = re.compile(r"^(step|level|yr|year|exp)\s*\.?\s*\d{1,3}\b", re.I)
# Punctuated bare step, e.g. "1." / "1)" / "01" leading the line.
_PUNCT_STEP = re.compile(r"^\d{1,3}[.)]$")
_THREE_DIGIT_STEP = re.compile(r"^\d{3}$")


def fetch_missing(cur, state: str, limit: Optional[int]) -> list[dict]:
    """IL teacher contracts (cba_pdf) lacking a real stored grid."""
    sql = """
        WITH real_grid AS (
          SELECT DISTINCT s.contract_id
          FROM contract_salary_schedules s
          JOIN contract_salary_schedule_cells cc ON cc.schedule_id = s.id
          WHERE s.schedule_type IN ('lane_grid','single_column')
            AND (s.review_reason IS NULL
                 OR s.review_reason NOT LIKE '%%implausible_salary_magnitude%%')
        )
        SELECT c.id AS contract_id, c.district_id, c.source_doc_id,
               d.name AS district_name, sd.source_url, sd.storage_key
        FROM contracts c
        JOIN districts d ON d.id = c.district_id AND d.state = %s
        JOIN source_documents sd ON sd.id = c.source_doc_id
             AND sd.doc_type = 'cba_pdf'
        WHERE c.bargaining_unit = 'teachers'
          AND c.id NOT IN (SELECT contract_id FROM real_grid)
        ORDER BY c.id
    """
    params: list = [state]
    if limit:
        sql += " LIMIT %s"
        params.append(limit)
    cur.execute(sql, params)
    cols = [c.name for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def fetch_doc_units(cur, source_doc_id) -> set[str]:
    cur.execute(
        "SELECT DISTINCT COALESCE(bargaining_unit, 'teachers') "
        "FROM contracts WHERE source_doc_id = %s",
        (source_doc_id,),
    )
    return {r[0] for r in cur.fetchall()}


def _text_signals(pdf_path: Path) -> dict:
    """Scan the text layer for the layout signals the parser keys on, so a
    'no_candidate_table' miss can be attributed to a recognizable family."""
    import pdfplumber

    sig = Counter()
    sample_rows: list[str] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            words = page.extract_words(use_text_flow=False,
                                       keep_blank_chars=False)
            if not words:
                continue
            lines = grid._group_lines(words)
            for ln in lines:
                toks = ln["words"]
                if not toks:
                    continue
                first = toks[0]["text"]
                monies = [w for w in toks if grid._is_money(w["text"])]
                if grid._LANE.search(ln["text"]):
                    sig["lines_with_edu_lane"] += 1
                if not monies:
                    continue
                sig["lines_with_money"] += 1
                if grid._STEP.match(first):
                    sig["bare_step_rows"] += 1
                    if len(sample_rows) < 4:
                        sample_rows.append(ln["text"][:80])
                elif _PUNCT_STEP.match(first):
                    sig["punct_step_rows"] += 1
                    if len(sample_rows) < 4:
                        sample_rows.append(ln["text"][:80])
                elif _THREE_DIGIT_STEP.match(first):
                    sig["three_digit_step_rows"] += 1
                elif _TEXT_STEP.match(ln["text"]):
                    sig["text_step_rows"] += 1
                    if len(sample_rows) < 4:
                        sample_rows.append(ln["text"][:80])
    return {"sig": dict(sig), "sample": " || ".join(sample_rows)}


def classify(cur, t: dict) -> dict:
    pdf_path = resolve_pdf_path(t.get("source_url") or "",
                               t.get("storage_key") or "")
    out = {
        "contract_id": t["contract_id"],
        "district_id": t["district_id"],
        "district_name": t.get("district_name") or "",
        "source_doc_id": t["source_doc_id"],
        "bucket": "",
        "detail": "",
        "source_url": t.get("source_url") or "",
    }
    if pdf_path is None or not Path(pdf_path).exists():
        out["bucket"] = "no_pdf"
        return out

    try:
        wc, npages = grid.pdf_text_stats(str(pdf_path))
    except Exception as e:  # noqa: BLE001
        out["bucket"] = "no_pdf"
        out["detail"] = f"stats_error ({e})"
        return out
    if grid.is_scanned(wc, npages):
        out["bucket"] = "scanned_no_text"
        out["detail"] = f"words={wc} pages={npages}"
        return out

    try:
        schedules = grid.parse_pdf(str(pdf_path))
    except Exception as e:  # noqa: BLE001
        out["bucket"] = "parse_error"
        out["detail"] = str(e)[:120]
        return out

    if schedules:
        sib = fetch_doc_units(cur, t["source_doc_id"])
        routed, _unattr = grid_route(schedules, sib)
        teacher_scheds = routed.get("teachers", [])
        good = [s for s in teacher_scheds
                if s["cells"] and "implausible_salary_magnitude"
                not in (s["review_reason"] or "")]
        if good:
            out["bucket"] = "recoverable_now"
            out["detail"] = (f"{len(good)} teacher schedule(s); "
                             f"e.g. {good[0]['schedule_name']}")
        elif any("implausible_salary_magnitude" in (s["review_reason"] or "")
                 for s in teacher_scheds):
            out["bucket"] = "parsed_implausible"
        elif teacher_scheds:
            out["bucket"] = "parsed_no_cells"
        else:
            out["bucket"] = "parsed_unattributed"
            out["detail"] = (f"{len(schedules)} schedule(s), none teachers: "
                             + ",".join(sorted({s["schedule_name"]
                                                for s in schedules}))[:80])
        return out

    # Readable text layer but the parser found no grid — the prime bucket.
    out["bucket"] = "no_candidate_table"
    info = _text_signals(pdf_path)
    out["detail"] = (str(info["sig"]) +
                     (f" | sample: {info['sample']}" if info["sample"] else ""))
    return out


def grid_route(schedules, sib):
    extract18 = importlib.import_module("18_extract_salary_schedules")
    return extract18.route_schedules(schedules, sib)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", default="IL")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    conn = common.get_db_conn()
    try:
        with conn.cursor() as cur:
            targets = fetch_missing(cur, args.state, args.limit)
            log.info("Auditing %d %s teacher contract(s) without a real grid",
                     len(targets), args.state)
            rows = []
            buckets: Counter = Counter()
            for i, t in enumerate(targets, 1):
                r = classify(cur, t)
                rows.append(r)
                buckets[r["bucket"]] += 1
                if i % 10 == 0 or i == len(targets):
                    log.info("  %d/%d processed", i, len(targets))
    finally:
        conn.close()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    fields = ["contract_id", "district_id", "district_name", "source_doc_id",
              "bucket", "detail", "source_url"]
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    log.info("=" * 60)
    log.info("Coverage-gap buckets (%d contracts without a real grid):",
             len(rows))
    for b, n in buckets.most_common():
        log.info("  %-22s %d", b, n)
    log.info("Wrote %s", args.out)
    log.info("READ-ONLY: the database was not modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
