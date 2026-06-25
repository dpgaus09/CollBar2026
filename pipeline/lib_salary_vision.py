"""Claude-vision fallback for SCANNED salary schedules.

When the deterministic parser (lib_salary_grid) finds no grid AND the PDF has no
usable text layer (scanned / image-only), we render the salary pages to images
and ask Claude to read the grid(s) into structured rows. The returned dicts match
the shape ``lib_salary_grid.parse_pdf`` produces, so they flow through the
existing routing (``route_schedules``) and storage (``store_schedules``)
unchanged. Vision-extracted schedules are tagged ``extraction_method='claude_vision'``.

Strategy (bounded cost):
  1. Small docs (<= SMALL_DOC_PAGES): send every page straight to extraction.
  2. Large docs: a cheap low-resolution vision TRIAGE locates the page(s) that
     actually carry a salary schedule, then only those pages are re-rendered at
     higher resolution for the structured EXTRACTION call.

No DB access. Network only (Anthropic via the Replit AI integration proxy, the
same env vars 06_extract_contracts uses).
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from typing import Optional

import lib_salary_grid as grid

log = logging.getLogger("salary_vision")

MODEL = "claude-haiku-4-5"

# Triage: low-res thumbnails are enough to tell "is there a grid of dollars here".
TRIAGE_DPI = 60
TRIAGE_MAX_PX = 900
TRIAGE_BATCH = 12            # pages per triage request

# Extraction: higher-res so digits read cleanly.
EXTRACT_DPI = 150
EXTRACT_MAX_PX = 1600
EXTRACT_MAX_TOKENS = 12000

DEFAULT_MAX_PAGES = 12       # hard cap on pages sent for high-res extraction
SMALL_DOC_PAGES = 6          # docs this small skip triage (extract every page)

_EXTRACT_PROMPT = (
    "You are reading scanned pages from a school-district collective bargaining "
    "agreement. Each image is one PDF page, labeled '=== PDF page N ===' just "
    "before it.\n\n"
    "Extract EVERY base salary schedule shown across these pages. A salary "
    "schedule is a table of experience STEPS (rows) by pay LANES (columns) with "
    "dollar amounts, or a single step->salary column. If the same schedule "
    "repeats for multiple SCHOOL YEARS (e.g. 2024-2025, 2025-2026), output a "
    "SEPARATE element per school year.\n\n"
    "Return ONLY a JSON array. Each element represents ONE schedule for ONE "
    "school year:\n"
    '{"schedule_name": str, "school_year": "YYYY-YYYY" or null, '
    '"schedule_type": "lane_grid" or "single_column", '
    '"lane_labels": [str, ...], "page": int, '
    '"rows": [[step, v1, v2, ...], ...]}\n\n'
    "Rules:\n"
    "- lane_labels are the column headers, left-to-right, EXACTLY as printed.\n"
    "- Each row is [step_number, then ONE value per lane in lane_labels order].\n"
    "- Use null for a blank/empty cell. NEVER invent or carry a value into a "
    "blank cell.\n"
    "- step_number is an integer; salary values are integers with no $ or commas "
    "(ignore any cents).\n"
    "- Use the EXACT column headers and step numbers as printed.\n"
    "- single_column schedule: lane_labels [\"Salary\"], each row [step, salary].\n"
    "- Do NOT include stipend, extra-duty, longevity, or index tables — only base "
    "salary schedules.\n"
    "- 'page' is the PDF page number (from the label) where the schedule appears.\n"
    "- If no salary schedule is present, return [].\n"
    "Output only the JSON array, no prose."
)


def _client():
    import anthropic
    base_url = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "")
    api_key = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "dummy")
    kwargs: dict = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    return anthropic.Anthropic(**kwargs)


def _render_b64(doc, i: int, dpi: int, max_px: int) -> str:
    """Render page ``i`` to a base64 PNG, downscaled so the long edge <= max_px."""
    pil = doc[i].render(scale=dpi / 72).to_pil().convert("RGB")
    w, h = pil.size
    longest = max(w, h)
    if longest > max_px:
        s = max_px / longest
        pil = pil.resize((max(1, int(w * s)), max(1, int(h * s))))
    buf = io.BytesIO()
    pil.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _img_block(b64: str) -> dict:
    return {"type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": b64}}


def _extract_json_array(raw: str) -> Optional[list]:
    """Pull the first balanced JSON array out of a model response (tolerates code
    fences and surrounding prose)."""
    if not raw:
        return None
    raw = raw.strip()
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        data = json.loads(raw[start:end + 1])
        return data if isinstance(data, list) else None
    except Exception:  # noqa: BLE001
        return None


def _to_int_money(v) -> Optional[int]:
    if v is None:
        return None
    s = str(v).strip().replace("$", "").replace(",", "")
    if not s or s.lower() in ("null", "none", "-"):
        return None
    try:
        n = int(round(float(s)))
    except Exception:  # noqa: BLE001
        return None
    return n if n > 0 else None


def _canon_lane(label: str) -> str:
    """Canonicalize an education-lane header to the abbreviation the router
    recognizes (lib_salary_grid._LANE: BA/BS/MA/MS[+N], PhD, EdD).

    The model is told to copy headers exactly, but a scanned page may spell them
    out ("Bachelors", "Master's + 30", "M.A."). Left as-is those evade
    ``is_education_schedule`` and an education grid could be misrouted onto a
    non-teacher unit. Degree words are mapped to canonical abbreviations;
    anything that is not clearly a degree is returned unchanged (so non-education
    columns like "Salary" or "Grade 1" are never falsely marked as education)."""
    s = re.sub(r"\s+", " ", str(label).strip())
    if not s:
        return s
    if grid._LANE.search(s):              # already recognized -> just tidy spacing
        return grid._norm_lane(s)
    low = s.lower()
    inc_m = re.search(r"(?:\+\s*|\bor\s+)(\d{1,3})\b", low)
    inc = "+" + inc_m.group(1) if inc_m else ""
    if re.search(r"\bph\.?\s?d\b|\bdoctor", low):
        return "PhD"
    if re.search(r"\bed\.?\s?d\b", low):
        return "EdD"
    if re.search(r"\bmaster|\bm\.\s?ed\b|\bm\.\s?a\b|\bm\.\s?s\b", low):
        base = "MS" if re.search(r"\bm\.\s?s\b|master of science", low) else "MA"
        return base + inc
    if re.search(r"\bbachelor|\bb\.\s?a\b|\bb\.\s?s\b", low):
        base = "BS" if re.search(r"\bb\.\s?s\b|bachelor of science", low) else "BA"
        return base + inc
    return s


def locate_salary_pages(doc, npages: int, *, max_pages: int) -> list[int]:
    """Cheap, low-res vision triage: return 0-based page indexes that show a
    salary schedule. Batched so request bodies stay small; a failing batch is
    skipped rather than aborting the whole locate."""
    client = _client()
    found: list[int] = []
    for batch_start in range(0, npages, TRIAGE_BATCH):
        batch = list(range(batch_start, min(batch_start + TRIAGE_BATCH, npages)))
        blocks: list = []
        for i in batch:
            blocks.append({"type": "text", "text": f"=== PDF page {i + 1} ==="})
            blocks.append(_img_block(_render_b64(doc, i, TRIAGE_DPI, TRIAGE_MAX_PX)))
        blocks.append({"type": "text", "text": (
            "Which of the labeled pages show a SALARY SCHEDULE (a table of "
            "experience steps and dollar salary amounts, or a step->salary "
            "column)? Return ONLY a JSON array of the page numbers, e.g. "
            "[48,49,50]. If none, return [].")})
        try:
            resp = client.messages.create(
                model=MODEL, max_tokens=256,
                messages=[{"role": "user", "content": blocks}])
            arr = _extract_json_array(resp.content[0].text) or []
        except Exception as e:  # noqa: BLE001
            log.warning("triage batch %s failed: %s", batch, e)
            continue
        for x in arr:
            try:
                p = int(x)
            except Exception:  # noqa: BLE001
                continue
            if 1 <= p <= npages:
                found.append(p - 1)
    found = sorted(set(found))
    if len(found) > max_pages:
        log.info("vision: %d candidate pages > cap %d; keeping first %d",
                 len(found), max_pages, max_pages)
        found = found[:max_pages]
    return found


def _normalize(data: list) -> list[dict]:
    """Turn the model's compact row JSON into schedule dicts matching
    lib_salary_grid.parse_pdf's shape."""
    out: list[dict] = []
    for s in data:
        if not isinstance(s, dict):
            continue
        lane_labels = [_canon_lane(x) for x in (s.get("lane_labels") or []) if str(x).strip()]
        page = None
        try:
            page = int(s.get("page")) if s.get("page") is not None else None
        except Exception:  # noqa: BLE001
            page = None
        page = page or 1

        stype = s.get("schedule_type")
        if stype not in ("lane_grid", "single_column"):
            stype = "lane_grid" if len(lane_labels) > 1 else "single_column"
        is_lane_grid = stype == "lane_grid" and len(lane_labels) >= 2

        cells: list[dict] = []
        salaries: list[int] = []
        steps: set[int] = set()
        bad_shape = False
        for row in (s.get("rows") or []):
            if not isinstance(row, (list, tuple)) or len(row) < 2:
                continue
            try:
                step = int(row[0])
            except Exception:  # noqa: BLE001
                continue
            values = list(row[1:])
            if is_lane_grid and len(values) != len(lane_labels):
                # The model dropped the null placeholders for blank cells (or
                # added stray columns), so cell->lane alignment is no longer
                # reliable and salaries could be silently shifted into the wrong
                # education lane. Fail closed: drop the whole schedule rather
                # than store mis-mapped pay.
                bad_shape = True
                break
            if is_lane_grid:
                for li, v in enumerate(values):
                    salary = _to_int_money(v)
                    if salary is None:
                        continue
                    cells.append({
                        "step_label": str(step), "step_order": step,
                        "lane_label": lane_labels[li], "lane_order": li,
                        "salary_amount": salary, "page_ref": page,
                    })
                    salaries.append(salary)
                    steps.add(step)
            else:
                # single column: the first non-null value is the salary.
                salary = next((m for m in (_to_int_money(v) for v in values)
                               if m is not None), None)
                if salary is None:
                    continue
                cells.append({
                    "step_label": str(step), "step_order": step,
                    "lane_label": lane_labels[0] if lane_labels else "Salary",
                    "lane_order": 0, "salary_amount": salary, "page_ref": page,
                })
                salaries.append(salary)
                steps.add(step)
        if bad_shape:
            log.warning("vision: dropping schedule %r — row width != %d lane(s)",
                        s.get("schedule_name"), len(lane_labels))
            continue
        if not cells:
            continue

        school_year = s.get("school_year")
        school_year = str(school_year).strip() if school_year else None
        if school_year and not re.match(r"\d{4}\s*[-\u2013]\s*\d{2,4}", school_year):
            school_year = None
        start_year = None
        if school_year:
            m = re.match(r"(\d{4})", school_year)
            if m:
                start_year = int(m.group(1))

        sched = {
            "schedule_name": (str(s.get("schedule_name") or "Salary Schedule").strip())[:200],
            "school_year": school_year,
            "start_year": start_year,
            "schedule_type": "lane_grid" if is_lane_grid else "single_column",
            "lane_labels": lane_labels or None,
            "step_count": len(steps),
            "lane_count": len(lane_labels) if is_lane_grid else 1,
            "page_start": page,
            "page_end": page,
            "min_salary": min(salaries),
            "max_salary": max(salaries),
            # Vision results surface in the customer view the same way the
            # deterministic parser's do — salary schedules have no separate
            # human-review queue — so they are tagged extraction_method=
            # 'claude_vision' to stay auditable. Obvious failures are still
            # withheld by the magnitude sanity check below, and lane-shifted
            # grids were dropped above, so what remains is safe to display.
            "confidence": 0.85,
            "needs_review": False,
            "review_reason": None,
            "extraction_method": "claude_vision",
            "cells": cells,
        }
        _apply_sanity(sched)
        out.append(sched)
    return out


def _apply_sanity(sched: dict) -> None:
    """Conservative checks: education grids must fall within plausible base-salary
    bounds, and a schedule needs enough step rows. Failures are flagged for review
    (and confidence lowered), never silently trusted."""
    reasons: set[str] = set()
    if grid.is_education_schedule(sched):
        if sched["min_salary"] is not None and sched["min_salary"] < grid.EDU_SALARY_FLOOR:
            reasons.add("salary_below_floor")
        if sched["max_salary"] is not None and sched["max_salary"] > grid.EDU_SALARY_CEILING:
            reasons.add("salary_above_ceiling")
    if sched["step_count"] < grid.MIN_ROWS:
        reasons.add("too_few_steps")
    if reasons:
        sched["needs_review"] = True
        sched["confidence"] = 0.5
        sched["review_reason"] = ";".join(sorted(reasons))


def extract_schedules(pdf_path, npages: int, *,
                      max_pages: int = DEFAULT_MAX_PAGES) -> list[dict]:
    """Vision-extract salary schedules from a scanned PDF. Returns schedule dicts
    (possibly empty). Raises on hard failures; the caller is expected to wrap this
    and fall back to a scanned placeholder."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        if npages <= SMALL_DOC_PAGES:
            pages = list(range(npages))
        else:
            pages = locate_salary_pages(doc, npages, max_pages=max_pages)
        if not pages:
            log.info("vision: no salary pages located in %s", pdf_path)
            return []
        log.info("vision: extracting from %d page(s): %s",
                 len(pages), [p + 1 for p in pages])

        client = _client()
        blocks: list = []
        for i in pages:
            blocks.append({"type": "text", "text": f"=== PDF page {i + 1} ==="})
            blocks.append(_img_block(_render_b64(doc, i, EXTRACT_DPI, EXTRACT_MAX_PX)))
        blocks.append({"type": "text", "text": _EXTRACT_PROMPT})

        resp = client.messages.create(
            model=MODEL, max_tokens=EXTRACT_MAX_TOKENS,
            messages=[{"role": "user", "content": blocks}])
        if resp.stop_reason == "max_tokens":
            # A truncated response yields partial/last-schedule-clipped JSON; do
            # not store any of it. Fail closed so the caller records a scanned
            # placeholder and the doc lands in review instead of half-extracted.
            log.warning("vision: extraction truncated (max_tokens); discarding output")
            return []
        data = _extract_json_array(resp.content[0].text)
        if not data:
            log.warning("vision: no JSON array parsed from extraction response")
            return []
        return _normalize(data)
    finally:
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass
