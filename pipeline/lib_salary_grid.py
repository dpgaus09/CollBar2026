"""Deterministic salary-schedule grid parser for CBA PDFs.

Parses Appendix-style salary schedules out of collective bargaining agreements:

  * lane_grid     — teachers: experience steps (rows) x education lanes
                    (columns: BA, BA+15, MA or 36, MA+30, ...). Grids are
                    *ragged* (lanes stop at different steps).
  * single_column — other job families (counselors, psychologists): a single
                    step -> salary column, one table per school year.

The core trick for ragged grids: dollar amounts are *right-aligned* within
their column, so the right edge (``x1``) of a token is the stable per-column
coordinate. We derive the column right-edges from the widest data rows (which
have a value in every lane), then assign every dollar amount to the nearest
column by right edge. This maps a row like ``16  $79,097  $82,416`` to the
correct trailing lanes even though the leading lanes are blank.

Pure parsing only — no DB access. The caller supplies the contract /
bargaining-unit context and persists the returned dicts.
"""
from __future__ import annotations

import re
from typing import Optional

# A money token: optional $, then digits/commas (>=3 chars), optional cents.
_MONEY = re.compile(r"^\$?[\d,]{3,}(?:\.\d{2})?$")
# A school-year span, e.g. "2025-2026" or "2025 - 2026".
_YEAR = re.compile(r"(19|20)(\d{2})\s*[-\u2013\u2014]\s*((?:19|20)?\d{2})")
# A bare 1-2 digit experience step at the start of a row.
_STEP = re.compile(r"^\d{1,2}$")
# Education-lane labels. Longer alternatives first so "BA + 15" wins over "BA".
_LANE = re.compile(
    r"(?:BA|BS|MA|MS)\s*\+\s*\d+"          # BA+15, MA+30
    r"|(?:BA|BS|MA|MS)\s*or\s*\d+"          # MA or 36
    r"|Ph\.?\s?D\.?|Ed\.?\s?D\.?|Doctorate"
    r"|\bBA\b|\bBS\b|\bMA\b|\bMS\b",
    re.IGNORECASE,
)
# Keywords that mark a job-family title line.
_FAMILY_KW = (
    "COUNSEL", "WORKER", "PSYCHOLOG", "PATHOLOG", "TEACHER", "NURSE",
    "AIDE", "CUSTOD", "SECRETAR", "THERAPIST", "LIBRARI", "PARAPROF",
)

MIN_ROWS = 3  # a real schedule has at least this many step rows

# Review reasons that are informational only (the extraction is still usable and
# should NOT be forced into the human-review queue). Everything else is a problem.
_INFO_REASONS = {"non_education_lanes", "lane_labels_recovered_from_sibling"}


def _is_money(t: str) -> bool:
    if not _MONEY.match(t):
        return False
    if "$" in t or "," in t:
        return True
    if re.match(r"^(19|20)\d{2}$", t):  # bare year, not a salary
        return False
    return len(t.replace(".", "")) >= 4


def _money_to_float(t: str) -> float:
    return float(t.replace("$", "").replace(",", ""))


def _norm_lane(s: str) -> str:
    s = re.sub(r"\s*\+\s*", "+", s.strip())
    s = re.sub(r"\s+", " ", s)
    # Normalize degree casing (ba -> BA) while leaving "or" lowercase.
    s = re.sub(r"\b(ba|bs|ma|ms|phd|edd)\b",
               lambda m: m.group(1).upper(), s, flags=re.IGNORECASE)
    return s


def _titlecase(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().title()


def _group_lines(words: list, ytol: float = 4.0) -> list[dict]:
    """Group words into visual lines by vertical position."""
    lines: list[dict] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        placed = False
        for ln in lines:
            if abs(ln["top"] - w["top"]) <= ytol:
                ln["words"].append(w)
                ln["top"] = (ln["top"] * ln["n"] + w["top"]) / (ln["n"] + 1)
                ln["n"] += 1
                placed = True
                break
        if not placed:
            lines.append({"top": w["top"], "n": 1, "words": [w]})
    for ln in lines:
        ln["words"].sort(key=lambda w: w["x0"])
        ln["text"] = " ".join(w["text"] for w in ln["words"])
    lines.sort(key=lambda ln: ln["top"])
    return lines


def _detect_family(lines: list[dict]) -> Optional[str]:
    """Detect the job-family / schedule name from title lines on a page."""
    # Prefer an ALL-CAPS job-family heading (cleanest).
    for ln in lines:
        t = ln["text"].strip()
        if (
            len(t) >= 4
            and t == t.upper()
            and any(c.isalpha() for c in t)
            and "APPENDIX" not in t
            and not _YEAR.search(t)
            and any(kw in t for kw in _FAMILY_KW)
        ):
            return _titlecase(t)
    # Fall back to "Compensation Schedule(s) for X".
    for ln in lines:
        m = re.search(r"Compensation Schedules?\s+for\s+(.+)", ln["text"],
                      re.IGNORECASE)
        if m:
            name = _YEAR.sub("", m.group(1)).strip(" .,-")
            name = re.sub(r"\bSchool\b", "", name)
            name = re.sub(r"\s+and\s+", " / ", name)
            name = re.sub(r"\s{2,}", " ", name).strip()
            if name:
                return _titlecase(name)
    return None


def _detect_year(lines: list[dict]) -> tuple[Optional[str], Optional[int]]:
    for ln in lines:
        toks = ln["words"]
        if toks and _STEP.match(toks[0]["text"]):
            continue  # skip data rows
        m = _YEAR.search(ln["text"])
        if m:
            y1 = int(m.group(1) + m.group(2))
            y2raw = m.group(3)
            y2 = int(y2raw) if len(y2raw) == 4 else int(str(y1)[:2] + y2raw)
            return f"{y1}-{y2}", y1
    return None, None


def _detect_lanes(lines: list[dict], first_data_top: float,
                  ncols: int) -> Optional[list[str]]:
    """Parse lane labels from the header line above the first data row."""
    candidates = [
        ln for ln in lines
        if ln["top"] < first_data_top and _LANE.search(ln["text"])
    ]
    if not candidates:
        return None
    hdr = candidates[-1]["text"]
    labels = [_norm_lane(m.group(0)) for m in _LANE.finditer(hdr)]
    return labels or None


def _capture_columns(lines: list[dict], first_data_top: float,
                     col_lefts: list[float],
                     col_rights: list[float]) -> Optional[list[str]]:
    """Capture *generic* column headers for a non-education lane grid (e.g. a
    custodial grid keyed by job class: Custodian, Maintenance, Engineer A/B).

    Header text often wraps across two short lines, so we align every alphabetic
    header word above the first data row to the money column whose x-span it sits
    over, then join per column top-to-bottom / left-to-right. Returns a list of
    labels (len == ncols) only if *every* column got text, else None.
    """
    ncols = len(col_rights)
    # Restrict to the *header band*: the tightly-spaced lines immediately above
    # the data. Walking up from the first data row and stopping at the first big
    # vertical gap keeps title / "EXHIBIT" / school-year lines (which sit higher,
    # past a gap) from leaking their words into columns.
    above = sorted((ln for ln in lines if ln["top"] < first_data_top),
                   key=lambda ln: ln["top"])
    band: list[dict] = []
    prev_top = first_data_top
    for ln in reversed(above):
        if band and prev_top - ln["top"] > 22:
            break
        band.append(ln)
        prev_top = ln["top"]
    buckets: list[list[tuple[float, float, str]]] = [[] for _ in range(ncols)]
    for ln in band:
        if _YEAR.search(ln["text"]):
            continue  # a school-year line, not column headers
        for w in ln["words"]:
            t = w["text"].strip()
            if not t or _is_money(t) or not any(c.isalpha() for c in t):
                continue
            cx = (w["x0"] + w["x1"]) / 2.0
            best, best_d = 0, None
            for i in range(ncols):
                lo, hi = col_lefts[i], col_rights[i]
                d = 0.0 if lo - 8 <= cx <= hi + 8 else min(abs(cx - lo),
                                                           abs(cx - hi))
                if best_d is None or d < best_d:
                    best_d, best = d, i
            if best_d is not None and best_d <= 40:  # ignore far-away titles
                buckets[best].append((ln["top"], w["x0"], t))
    labels: list[str] = []
    for b in buckets:
        if not b:
            return None
        b.sort(key=lambda x: (x[0], x[1]))
        labels.append(re.sub(r"\s+", " ", " ".join(t for _, _, t in b)).strip())
    return labels if all(labels) else None


def _recover_sibling_lanes(schedules: list[dict]) -> None:
    """For lane grids whose header was garbled, borrow lane labels from another
    year of the same job family that parsed cleanly (lane structure is constant
    across years)."""
    by_name: dict[str, list[dict]] = {}
    for s in schedules:
        if s["schedule_type"] == "lane_grid":
            by_name.setdefault(s["schedule_name"], []).append(s)
    for group in by_name.values():
        good = next(
            (s for s in group
             if s["lane_labels"] and len(s["lane_labels"]) == s["lane_count"]),
            None,
        )
        if not good:
            continue
        for s in group:
            if s["lane_labels"] and len(s["lane_labels"]) == s["lane_count"]:
                continue
            if s["lane_count"] != good["lane_count"]:
                continue
            s["lane_labels"] = list(good["lane_labels"])
            for c in s["cells"]:
                c["lane_label"] = good["lane_labels"][c["lane_order"]]
            reasons = set((s["review_reason"] or "").split(";")) - {""}
            reasons.discard("lane_label_mismatch")
            reasons.add("lane_labels_recovered_from_sibling")
            s["review_reason"] = ";".join(sorted(reasons)) or None
            s["needs_review"] = bool(reasons - {"lane_labels_recovered_from_sibling"})


def _parse_page(pageno: int, lines: list[dict],
                family: Optional[str]) -> Optional[dict]:
    # Collect data rows: lead token is a step int and the row has >=1 money.
    data_rows = []
    for ln in lines:
        toks = ln["words"]
        if not toks or not _STEP.match(toks[0]["text"]):
            continue
        monies = [w for w in toks if _is_money(w["text"])]
        if monies:
            data_rows.append((int(toks[0]["text"]), toks[0]["text"], monies, ln))
    if len(data_rows) < MIN_ROWS:
        return None

    first_data_top = data_rows[0][3]["top"]
    year_text, start_year = _detect_year(lines)
    maxc = max(len(m) for _, _, m, _ in data_rows)
    full = [m for _, _, m, _ in data_rows if len(m) == maxc]
    col_rights = [sum(f[i]["x1"] for f in full) / len(full) for i in range(maxc)]
    col_lefts = [sum(f[i]["x0"] for f in full) / len(full) for i in range(maxc)]

    schedule_type = "lane_grid" if maxc >= 2 else "single_column"
    review: set[str] = set()
    lane_labels = None
    if schedule_type == "lane_grid":
        lane_labels = _detect_lanes(lines, first_data_top, maxc)
        if not lane_labels or len(lane_labels) != maxc:
            # Not an education (BA/MA) header. Try capturing generic column
            # headers (e.g. a custodial grid keyed by job class). Only accept
            # them when they do NOT look like education lanes, so we never
            # fabricate BA/MA for a non-teacher unit.
            generic = _capture_columns(lines, first_data_top, col_lefts,
                                       col_rights)
            if (generic and len(generic) == maxc
                    and not any(_LANE.search(g) for g in generic)):
                lane_labels = generic
                review.add("non_education_lanes")
            else:
                lane_labels = None
                review.add("lane_label_mismatch")
    if year_text is None:
        review.add("missing_year")

    labels_ok = bool(lane_labels) and len(lane_labels) == maxc
    cells = []
    amounts: list[float] = []
    seen: set[tuple[int, int]] = set()
    for step_i, step_label, monies, _ln in data_rows:
        used: set[int] = set()
        for w in monies:
            col = min(range(maxc), key=lambda i: abs(col_rights[i] - w["x1"]))
            if col in used:
                review.add("multiple_values_in_one_column")
                continue
            used.add(col)
            amt = _money_to_float(w["text"])
            key = (step_i, col)
            if key in seen:
                continue
            seen.add(key)
            amounts.append(amt)
            cells.append({
                "step_label": step_label,
                "step_order": step_i,
                "lane_label": lane_labels[col] if labels_ok else None,
                "lane_order": col,
                "salary_amount": amt,
                "page_ref": pageno,
            })
    if not cells:
        return None

    steps = sorted({c["step_order"] for c in cells})
    problems = review - _INFO_REASONS
    if problems:
        confidence = 0.6
    elif review:  # only informational reasons (e.g. non-education columns)
        confidence = 0.85
    else:
        confidence = 0.95
    return {
        "schedule_name": family or "Unknown",
        "school_year": year_text,
        "start_year": start_year,
        "schedule_type": schedule_type,
        "lane_labels": lane_labels,
        "step_count": len(steps),
        "lane_count": maxc,
        "page_start": pageno,
        "page_end": pageno,
        "min_salary": min(amounts) if amounts else None,
        "max_salary": max(amounts) if amounts else None,
        "confidence": confidence,
        "needs_review": bool(problems),
        "review_reason": ";".join(sorted(review)) or None,
        "extraction_method": "pdfplumber",
        "cells": cells,
    }


def parse_pdf(pdf_path) -> list[dict]:
    """Parse all salary schedules from a CBA PDF. Returns a list of schedule
    dicts, each with a nested ``cells`` list."""
    import pdfplumber

    schedules: list[dict] = []
    cur_family: Optional[str] = None
    with pdfplumber.open(pdf_path) as pdf:
        for pidx, page in enumerate(pdf.pages):
            words = page.extract_words(use_text_flow=False,
                                       keep_blank_chars=False)
            if not words:
                continue
            lines = _group_lines(words)
            fam = _detect_family(lines)
            if fam:
                cur_family = fam
            sched = _parse_page(pidx + 1, lines, cur_family)
            if sched:
                schedules.append(sched)
    _recover_sibling_lanes(schedules)
    return schedules


def pdf_text_stats(pdf_path) -> tuple[int, int]:
    """Return (total_word_count, n_pages) from the PDF's text layer. Used to
    distinguish a scanned/image-only PDF (≈0 words) from a digital one."""
    import pdfplumber

    total = n_pages = 0
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            n_pages += 1
            total += len(page.extract_words(use_text_flow=False,
                                            keep_blank_chars=False))
    return total, n_pages


def is_scanned(total_words: int, n_pages: int) -> bool:
    """A digital CBA has hundreds of words/page; an image-only (scanned) PDF
    has essentially none. Treat <5 words/page as 'no usable text layer'."""
    return total_words < 5 * max(1, n_pages)


def scanned_placeholder(n_pages: int = 1) -> dict:
    """A flag-and-defer placeholder schedule for a scanned PDF with no text
    layer. Carries no cells; deterministic grid parsing is impossible without
    OCR word boxes, so it is queued for review instead of dropped silently."""
    return {
        "schedule_name": "Unknown (scanned)",
        "school_year": None,
        "start_year": None,
        "schedule_type": "unknown",
        "lane_labels": None,
        "step_count": 0,
        "lane_count": 0,
        "page_start": 1,
        "page_end": max(1, n_pages),
        "min_salary": None,
        "max_salary": None,
        "confidence": 0.0,
        "needs_review": True,
        "review_reason": "scanned_no_text",
        "extraction_method": "pdfplumber",
        "cells": [],
    }
