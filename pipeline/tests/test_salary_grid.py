#!/usr/bin/env python3
"""Deterministic salary-schedule grid parser test.

Proves lib_salary_grid.parse_pdf extracts the full salary schedules from a real
CBA (Joliet District 86), including ragged teacher lane grids, garbled-header
recovery from a sibling year, and single-column non-teacher schedules.
"""
import importlib
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
import lib_salary_grid as L

# 18_extract_salary_schedules starts with a digit, so import via importlib.
extract18 = importlib.import_module("18_extract_salary_schedules")

FIXTURE = Path(__file__).parent / "fixtures" / "joliet_d86_salary.pdf"
TEACHER_LANES = ["BA", "BA+15", "MA or 36", "MA+30"]


class SalaryGridTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sch = L.parse_pdf(str(FIXTURE))

    def by(self, name, year):
        return next(
            (s for s in self.sch
             if s["schedule_name"] == name and s["school_year"] == year),
            None,
        )

    def test_all_schedules_found(self):
        # 3 job families x 3 school years.
        self.assertEqual(len(self.sch), 9)
        names = {s["schedule_name"] for s in self.sch}
        self.assertEqual(names, {
            "Teachers",
            "Counselors/Social Workers",
            "Psychologist/Speech Pathologist",
        })

    def test_no_unresolved_review(self):
        # Sibling recovery should clear the garbled-header flag.
        for s in self.sch:
            self.assertFalse(
                s["needs_review"],
                f"{s['schedule_name']} {s['school_year']} flagged: "
                f"{s['review_reason']}",
            )

    def test_teacher_lane_grid_structure(self):
        for yr in ("2025-2026", "2026-2027", "2027-2028"):
            s = self.by("Teachers", yr)
            self.assertIsNotNone(s, f"missing Teachers {yr}")
            self.assertEqual(s["schedule_type"], "lane_grid")
            self.assertEqual(s["lane_labels"], TEACHER_LANES)
            self.assertEqual(s["lane_count"], 4)
            self.assertEqual(s["step_count"], 36)

    def test_ragged_lane_cell_counts(self):
        # The crux: ragged columns mapped by right-edge position, not by count.
        s = self.by("Teachers", "2025-2026")
        counts = Counter(c["lane_label"] for c in s["cells"])
        self.assertEqual(dict(counts), {
            "BA": 11, "BA+15": 16, "MA or 36": 36, "MA+30": 36,
        })

    def test_teacher_spot_values(self):
        s = self.by("Teachers", "2025-2026")
        spot = {(c["step_order"], c["lane_label"]): c["salary_amount"]
                for c in s["cells"]}
        self.assertEqual(spot[(0, "BA")], 51676.0)
        self.assertEqual(spot[(0, "BA+15")], 54838.0)
        self.assertEqual(spot[(0, "MA or 36")], 56997.0)
        self.assertEqual(spot[(0, "MA+30")], 59171.0)
        # Ragged: BA stops at step 10, so step 11 has no BA cell.
        self.assertNotIn((11, "BA"), spot)
        self.assertEqual(spot[(11, "BA+15")], 68287.0)
        # Top steps only have the two MA lanes.
        self.assertEqual(spot[(16, "MA or 36")], 79097.0)
        self.assertEqual(spot[(16, "MA+30")], 82416.0)
        self.assertEqual(spot[(35, "MA or 36")], 118574.0)
        self.assertEqual(spot[(35, "MA+30")], 123765.0)

    def test_garbled_header_recovered(self):
        s = self.by("Teachers", "2027-2028")
        self.assertEqual(s["lane_labels"], TEACHER_LANES)
        self.assertIn("recovered", (s["review_reason"] or ""))

    def test_single_column_schedules(self):
        c = self.by("Counselors/Social Workers", "2025-2026")
        self.assertEqual(c["schedule_type"], "single_column")
        self.assertIsNone(c["lane_labels"])
        spot = {x["step_order"]: x["salary_amount"] for x in c["cells"]}
        self.assertEqual(spot[0], 59539.0)
        self.assertEqual(spot[35], 124533.0)
        p = self.by("Psychologist/Speech Pathologist", "2025-2026")
        self.assertEqual(p["schedule_type"], "single_column")
        spot_p = {x["step_order"]: x["salary_amount"] for x in p["cells"]}
        self.assertEqual(spot_p[0], 61531.0)

    def test_salary_plausibility(self):
        for s in self.sch:
            for c in s["cells"]:
                self.assertGreater(c["salary_amount"], 20000)
                self.assertLess(c["salary_amount"], 400000)


def _w(text, x0, x1):
    return {"text": text, "x0": x0, "x1": x1}


def _line(top, words):
    return {"top": top, "text": " ".join(w["text"] for w in words),
            "words": words}


class GenericColumnCaptureTest(unittest.TestCase):
    """_capture_columns binds wrapped job-class headers to money columns and
    excludes the title band (a non-teacher grid must never borrow BA/MA chrome)."""

    def test_binds_and_wraps_columns_excluding_title(self):
        # Two money columns: col0 ~[100,160], col1 ~[200,260].
        col_lefts, col_rights = [100.0, 200.0], [160.0, 260.0]
        first_data_top = 70.0
        lines = [
            # Title line far above the header band — its words sit over the
            # columns but must be excluded by the vertical-gap walk.
            _line(10.0, [_w("EXHIBIT", 105, 150), _w("SCHEDULE", 205, 255)]),
            # Wrapped header: "Senior" (col1) on its own line just above...
            _line(40.0, [_w("Senior", 210, 250)]),
            # ...and the rest of the header on the line nearest the data.
            _line(52.0, [_w("Custodian", 110, 150), _w("Engineer", 205, 255)]),
        ]
        labels = L._capture_columns(lines, first_data_top, col_lefts, col_rights)
        self.assertEqual(labels, ["Custodian", "Senior Engineer"])
        # Crucially, no education-lane token leaked in.
        self.assertFalse(any(L._LANE.search(x) for x in labels))

    def test_returns_none_when_a_column_is_empty(self):
        col_lefts, col_rights = [100.0, 200.0], [160.0, 260.0]
        lines = [_line(52.0, [_w("Custodian", 110, 150)])]  # nothing over col1
        self.assertIsNone(
            L._capture_columns(lines, 70.0, col_lefts, col_rights))


def _edu_page_lines(c0, c1):
    """Build the line dicts for a 2-lane (BA, MA) education grid whose two money
    columns top out at c0/c1 — used to exercise the magnitude sanity check."""
    return [
        _line(20.0, [_w("2025-2026", 100, 160)]),          # school-year line
        _line(40.0, [_w("BA", 100, 120), _w("MA", 200, 220)]),  # lane header
        _line(60.0, [_w("1", 80, 90), _w("3,000", 100, 120),
                     _w("3,200", 200, 220)]),
        _line(72.0, [_w("2", 80, 90), _w("4,000", 100, 120),
                     _w("4,200", 200, 220)]),
        _line(84.0, [_w("3", 80, 90),
                     _w(f"{c0:,}", 100, 120), _w(f"{c1:,}", 200, 220)]),
    ]


class EducationMagnitudeTest(unittest.TestCase):
    """An education (BA/MA) lane grid whose values are too small to be a base
    schedule (e.g. a stipend/index table) is flagged + withheld; a plausible
    one is not. The check must never fire on non-education grids."""

    def test_implausibly_small_education_grid_is_flagged(self):
        s = L._parse_page(1, _edu_page_lines(8000, 8500), "Teachers")
        self.assertIsNotNone(s)
        self.assertEqual(s["lane_labels"], ["BA", "MA"])
        self.assertTrue(s["needs_review"])
        self.assertIn("implausible_salary_magnitude", s["review_reason"])

    def test_plausible_education_grid_is_not_flagged(self):
        s = L._parse_page(1, _edu_page_lines(55000, 60000), "Teachers")
        self.assertIsNotNone(s)
        self.assertEqual(s["lane_labels"], ["BA", "MA"])
        self.assertFalse(s["needs_review"])
        self.assertNotIn("implausible_salary_magnitude", s["review_reason"] or "")

    def test_small_non_education_grid_is_not_flagged(self):
        # Same small magnitudes, but generic (job-class) columns: an hourly
        # custodial table legitimately has small numbers and must NOT be flagged.
        lines = [
            _line(40.0, [_w("Custodian", 100, 150), _w("Engineer", 200, 250)]),
            _line(60.0, [_w("1", 80, 90), _w("3,000", 100, 120),
                         _w("3,200", 200, 220)]),
            _line(72.0, [_w("2", 80, 90), _w("4,000", 100, 120),
                         _w("4,200", 200, 220)]),
            _line(84.0, [_w("3", 80, 90), _w("5,000", 100, 120),
                         _w("5,500", 200, 220)]),
        ]
        s = L._parse_page(1, lines, "Custodians")
        self.assertIsNotNone(s)
        self.assertEqual(s["lane_labels"], ["Custodian", "Engineer"])
        self.assertNotIn("implausible_salary_magnitude", s["review_reason"] or "")


def _sched(name, lanes=None):
    return {"schedule_name": name, "lane_labels": lanes}


class ScheduleClassificationTest(unittest.TestCase):
    def test_is_education_schedule(self):
        self.assertTrue(L.is_education_schedule(_sched("Teachers", ["BA", "MA"])))
        self.assertTrue(L.is_education_schedule(_sched("TEACHERS SALARY")))
        self.assertFalse(
            L.is_education_schedule(_sched("Custodians", ["Custodian", "Eng"])))
        self.assertFalse(L.is_education_schedule(_sched("Secretaries")))

    def test_classify_schedule_unit(self):
        self.assertEqual(
            L.classify_schedule_unit(_sched("Teachers", ["BA", "MA"])), "teachers")
        self.assertEqual(
            L.classify_schedule_unit(_sched("TEACHERS SALARY")), "teachers")
        self.assertEqual(
            L.classify_schedule_unit(_sched("Secretarial Salary Schedule")),
            "secretarial_clerical")
        self.assertEqual(
            L.classify_schedule_unit(_sched("Custodian/Maintenance Grid")),
            "support_staff")
        # Certified sub-families are part of the teachers unit -> ambiguous here,
        # so they resolve to the PDF primary, never to a non-teacher unit.
        self.assertIsNone(
            L.classify_schedule_unit(_sched("Counselors/Social Workers")))
        self.assertIsNone(L.classify_schedule_unit(_sched("Index Stipends")))


class RouteSchedulesTest(unittest.TestCase):
    """route_schedules is the cross-unit-leak fix: a teacher grid must reach the
    teachers contract only, and is withheld (unattributed) when no teachers
    contract shares the PDF — never stamped onto a non-teacher unit."""

    def test_teacher_grid_routes_to_teachers(self):
        routed, unattr = extract18.route_schedules(
            [_sched("Teachers", ["BA", "MA"])], {"teachers", "support_staff"})
        self.assertEqual(list(routed), ["teachers"])
        self.assertEqual(unattr, [])

    def test_teacher_grid_withheld_when_no_teachers_contract(self):
        teacher = _sched("Teachers", ["BA", "MA"])
        routed, unattr = extract18.route_schedules([teacher], {"support_staff"})
        self.assertNotIn("support_staff", routed)
        self.assertEqual(unattr, [teacher])

    def test_family_schedule_routes_to_its_unit(self):
        routed, _ = extract18.route_schedules(
            [_sched("Custodian Salary")], {"teachers", "support_staff"})
        self.assertEqual(list(routed), ["support_staff"])

    def test_ambiguous_routes_to_primary_teachers(self):
        routed, unattr = extract18.route_schedules(
            [_sched("Index Stipends")], {"teachers", "support_staff"})
        self.assertEqual(list(routed), ["teachers"])
        self.assertEqual(unattr, [])

    def test_mixed_pdf_no_education_leak_to_support(self):
        teacher = _sched("Teachers", ["BA", "MA"])
        cust = _sched("Custodian Salary")
        routed, unattr = extract18.route_schedules(
            [teacher, cust], {"teachers", "support_staff"})
        self.assertEqual(routed["teachers"], [teacher])
        self.assertEqual(routed["support_staff"], [cust])
        # The whole point: no education schedule under a non-teacher unit.
        self.assertFalse(
            any(L.is_education_schedule(s) for s in routed["support_staff"]))


class _FakeCur:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeConn:
    """Minimal conn for exercising store_schedules in dry_run (no DB)."""

    def cursor(self):
        return _FakeCur()

    def commit(self):
        pass


def _store_sched(name, year, ncells, conf=0.9, step_count=1, page_start=1):
    cell = {"step_label": "1", "step_order": 0, "lane_label": "BA",
            "lane_order": 0, "salary_amount": 50000, "page_ref": page_start}
    return {
        "schedule_name": name, "school_year": year, "start_year": None,
        "schedule_type": "lane_grid", "lane_labels": ["BA", "MA"],
        "step_count": step_count, "lane_count": 2, "page_start": page_start,
        "page_end": page_start, "min_salary": None, "max_salary": None,
        "confidence": conf, "needs_review": False, "review_reason": None,
        "extraction_method": "pdfplumber", "cells": [dict(cell)] * ncells,
    }


class StoreDedupeTest(unittest.TestCase):
    """store_schedules must collapse rows that share the DB unique key
    (schedule_name, school_year) so one PDF yielding the same grid twice does
    not abort the whole contract's delete-then-insert transaction."""

    def _store(self, schedules):
        return extract18.store_schedules(
            _FakeConn(), {"contract_id": 1}, schedules, dry_run=True)

    def test_collision_keeps_richest(self):
        # Same (name, year) twice — keep the one with more cells.
        thin = _store_sched("Teachers", "2025-2026", ncells=0, conf=0.6)
        rich = _store_sched("Teachers", "2025-2026", ncells=12, conf=0.9)
        n_sched, n_cells = self._store([thin, rich])
        self.assertEqual(n_sched, 1)
        self.assertEqual(n_cells, 12)

    def test_distinct_years_both_kept(self):
        a = _store_sched("Teachers", "2025-2026", ncells=4)
        b = _store_sched("Teachers", "2026-2027", ncells=4)
        n_sched, _ = self._store([a, b])
        self.assertEqual(n_sched, 2)

    def test_missing_year_disambiguated_by_page(self):
        # Two no-year schedules on different pages get distinct synthetic years.
        a = _store_sched("Stipends", None, ncells=2, page_start=5)
        b = _store_sched("Stipends", None, ncells=2, page_start=9)
        same = _store_sched("Stipends", None, ncells=2, page_start=5)
        self.assertEqual(self._store([a, b])[0], 2)
        self.assertEqual(self._store([a, same])[0], 1)


class RowStepTest(unittest.TestCase):
    """_row_step accepts bare-digit steps always and clean textual 'Step'/'Level'
    labels only when allowed; glued/noisy labels are never matched."""

    def test_bare_digit(self):
        self.assertEqual(L._row_step([_w("5", 0, 10), _w("$50,000", 20, 40)]),
                         (5, "5"))

    def test_clean_textual_step_and_level(self):
        self.assertEqual(L._row_step([_w("Step", 0, 20), _w("7", 22, 30)]),
                         (7, "7"))
        self.assertEqual(L._row_step([_w("Level", 0, 20), _w("3", 22, 30)]),
                         (3, "3"))

    def test_textual_disabled_by_flag(self):
        self.assertIsNone(
            L._row_step([_w("Step", 0, 20), _w("7", 22, 30)],
                        allow_textual=False))

    def test_glued_or_noisy_label_rejected(self):
        # The degraded-text-layer family (Cicero SD 99): never matched.
        self.assertIsNone(L._row_step([_w("STEP7", 0, 30)]))
        self.assertIsNone(L._row_step([_w("Step1.", 0, 30)]))
        self.assertIsNone(L._row_step([_w("STEPI7", 0, 30)]))

    def test_three_digit_step_rejected(self):
        self.assertIsNone(L._row_step([_w("100", 0, 30)]))

    def test_textual_needs_a_separate_digit_token(self):
        self.assertIsNone(L._row_step([_w("Step", 0, 20), _w("one", 22, 40)]))
        self.assertIsNone(L._row_step([_w("Step", 0, 20)]))


def _textual_edu_lines(top, kw="Step"):
    """A 2-lane (BA, MA) education grid that uses *textual* step labels
    ("Step 1 ..."); ``top`` sets the magnitude of the largest cell."""
    lo = top - 5000
    return [
        _line(20.0, [_w("2025-2026", 100, 160)]),
        _line(40.0, [_w("BA", 100, 120), _w("MA", 200, 220)]),
        _line(60.0, [_w(kw, 60, 78), _w("1", 80, 90),
                     _w(f"{lo:,}", 100, 120), _w(f"{lo + 1000:,}", 200, 220)]),
        _line(72.0, [_w(kw, 60, 78), _w("2", 80, 90),
                     _w(f"{lo + 2000:,}", 100, 120),
                     _w(f"{lo + 3000:,}", 200, 220)]),
        _line(84.0, [_w(kw, 60, 78), _w("3", 80, 90),
                     _w(f"{top - 1000:,}", 100, 120), _w(f"{top:,}", 200, 220)]),
    ]


class TextualStepTest(unittest.TestCase):
    """Clean textual 'Step N' / 'Level N' rows are a fallback used only when the
    bare-digit pass finds nothing, and the resulting grid is trusted ONLY if it
    is a recognizable education (BA/MA) grid the magnitude floor can validate."""

    def test_textual_education_grid_recovered(self):
        for kw in ("Step", "Level", "STEP", "level"):
            s = L._parse_page(1, _textual_edu_lines(60000, kw), "Teachers")
            self.assertIsNotNone(s, f"{kw} grid not parsed")
            self.assertEqual(s["lane_labels"], ["BA", "MA"])
            self.assertEqual(s["lane_count"], 2)
            self.assertEqual(s["step_count"], 3)
            self.assertFalse(s["needs_review"], s["review_reason"])

    def test_textual_education_stipend_is_flagged_and_withheld(self):
        # Education lanes but stipend-sized values -> flagged, never shown clean.
        s = L._parse_page(1, _textual_edu_lines(9000), "Teachers")
        self.assertIsNotNone(s)
        self.assertTrue(s["needs_review"])
        self.assertIn("implausible_salary_magnitude", s["review_reason"])

    def test_textual_non_education_grid_rejected(self):
        # Generic (non-BA/MA) textual-step table, e.g. a "Group I/II" stipend
        # schedule (Glen Ellyn SD 41): its small values evade the education-only
        # magnitude floor, so it must be withheld ENTIRELY (parser returns None).
        lines = [
            _line(40.0, [_w("Group", 95, 130), _w("I", 132, 140),
                         _w("Group", 195, 230), _w("II", 232, 240)]),
            _line(60.0, [_w("Step", 60, 78), _w("1", 80, 90),
                         _w("1,210", 100, 120), _w("1,980", 200, 220)]),
            _line(72.0, [_w("Step", 60, 78), _w("2", 80, 90),
                         _w("1,210", 100, 120), _w("2,530", 200, 220)]),
            _line(84.0, [_w("Step", 60, 78), _w("3", 80, 90),
                         _w("1,210", 100, 120), _w("2,970", 200, 220)]),
        ]
        self.assertIsNone(L._parse_page(1, lines, "Stipends"))

    def test_glued_step_label_grid_rejected(self):
        # Even with BA/MA lanes, glued labels (STEP1) yield no data rows at all.
        lines = [
            _line(40.0, [_w("BA", 100, 120), _w("MA", 200, 220)]),
            _line(60.0, [_w("STEP1", 70, 95), _w("50,000", 100, 120),
                         _w("52,000", 200, 220)]),
            _line(72.0, [_w("STEP2", 70, 95), _w("51,000", 100, 120),
                         _w("53,000", 200, 220)]),
            _line(84.0, [_w("STEP3", 70, 95), _w("52,000", 100, 120),
                         _w("54,000", 200, 220)]),
        ]
        self.assertIsNone(L._parse_page(1, lines, "Teachers"))

    def test_bare_digit_grid_unaffected_by_fallback(self):
        # A normal bare-digit education grid still parses via the first pass and
        # is NOT subject to the textual-only education gate.
        s = L._parse_page(1, _edu_page_lines(55000, 60000), "Teachers")
        self.assertIsNotNone(s)
        self.assertEqual(s["lane_labels"], ["BA", "MA"])
        self.assertFalse(s["needs_review"])


class ScannedHelperTest(unittest.TestCase):
    def test_is_scanned_threshold(self):
        self.assertTrue(L.is_scanned(0, 10))    # image-only, many pages
        self.assertTrue(L.is_scanned(4, 1))     # under 5 words/page
        self.assertFalse(L.is_scanned(5, 1))    # exactly at threshold
        self.assertFalse(L.is_scanned(600, 1))  # digital PDF
        self.assertTrue(L.is_scanned(0, 0))     # guards divide-by-zero

    def test_scanned_placeholder_is_flagged_with_no_cells(self):
        p = L.scanned_placeholder(3)
        self.assertTrue(p["needs_review"])
        self.assertEqual(p["review_reason"], "scanned_no_text")
        self.assertEqual(p["schedule_type"], "unknown")
        self.assertEqual(p["cells"], [])
        self.assertEqual(p["page_end"], 3)


if __name__ == "__main__":
    unittest.main()
