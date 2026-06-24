#!/usr/bin/env python3
"""Deterministic salary-schedule grid parser test.

Proves lib_salary_grid.parse_pdf extracts the full salary schedules from a real
CBA (Joliet District 86), including ragged teacher lane grids, garbled-header
recovery from a sibling year, and single-column non-teacher schedules.
"""
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
import lib_salary_grid as L

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
