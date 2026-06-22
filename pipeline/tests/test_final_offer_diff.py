#!/usr/bin/env python3
"""Safety-net tests for ELRB final-offer diff/alignment (19_extract_final_offers).

The board-vs-union comparison must classify a topic two different ways:

  1. NUMERIC topics (salary %, stipend $, term years): "aligned" only when both
     sides give a number in the same unit within a small per-unit tolerance,
     otherwise a genuine "diff". A real numeric gap must never be hidden by
     similar surrounding language.
  2. QUALITATIVE topics (seniority rules, grievance language, status-quo
     clauses): there is no number to compare, so alignment falls back to the
     verbatim offer language / summary. Two offers reproducing the same agreed
     clause are "aligned" even though each PDF frames it from its own side; two
     genuinely different positions stay "diff"; and the same wording with a
     different embedded number (e.g. "3 days" vs "5 days") is a "diff".

These pin classify_pair so a future tweak can't silently regress either path.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

_PKG_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_PKG_ROOT))

# Module filename starts with a digit, so load it explicitly.
_spec = importlib.util.spec_from_file_location(
    "extract_final_offers", _PKG_ROOT / "19_extract_final_offers.py")
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

classify_pair = mod.classify_pair
_text_aligned = mod._text_aligned
_normalize_text = mod._normalize_text


def _item(*, summary=None, raw_text=None, value=None, unit=None):
    return {"summary": summary, "raw_text": raw_text, "value": value, "unit": unit}


class TestNumericClassification(unittest.TestCase):
    def test_numeric_aligned_within_tolerance(self):
        # Both sides 4% salary (same number, same unit) → aligned, zero gap.
        d = _item(summary="4% increase", value=4.0, unit="percent")
        u = _item(summary="4% increase", value=4.0, unit="percent")
        status, gap, gap_unit = classify_pair(d, u)
        self.assertEqual(status, "aligned")
        self.assertEqual(gap, 0.0)
        self.assertEqual(gap_unit, "percent")

    def test_numeric_diff_beyond_tolerance(self):
        # Board 3% vs union 5% → real numeric gap, must be diff (not hidden).
        d = _item(summary="3% increase", value=3.0, unit="percent")
        u = _item(summary="3% increase", value=5.0, unit="percent")
        status, gap, gap_unit = classify_pair(d, u)
        self.assertEqual(status, "diff")
        self.assertEqual(gap, 2.0)
        self.assertEqual(gap_unit, "percent")

    def test_numeric_diff_not_overridden_by_similar_language(self):
        # Identical wording but different numbers must still be a diff.
        d = _item(summary="Salary increase of 3% in year one",
                  raw_text="Salary increase of 3% in year one",
                  value=3.0, unit="percent")
        u = _item(summary="Salary increase of 4% in year one",
                  raw_text="Salary increase of 4% in year one",
                  value=4.0, unit="percent")
        status, _gap, _unit = classify_pair(d, u)
        self.assertEqual(status, "diff")

    def test_different_units_fall_back_to_language(self):
        # Units differ → not numerically comparable; different language → diff.
        d = _item(summary="Severance paid in days", value=10.0, unit="days")
        u = _item(summary="Severance paid as a percent", value=10.0, unit="percent")
        status, gap, gap_unit = classify_pair(d, u)
        self.assertEqual(status, "diff")
        self.assertIsNone(gap)
        self.assertIsNone(gap_unit)


class TestLanguageClassification(unittest.TestCase):
    def test_language_aligned_identical_clause(self):
        clause = ("Seniority shall be defined in order of priority as total "
                  "continuous years of certified service in the district.")
        d = _item(raw_text=clause, summary="Seniority by continuous service")
        u = _item(raw_text=clause, summary="Seniority by continuous service")
        status, gap, gap_unit = classify_pair(d, u)
        self.assertEqual(status, "aligned")
        self.assertIsNone(gap)
        self.assertIsNone(gap_unit)

    def test_language_aligned_despite_side_framing(self):
        # Same agreed clause framed from each side → still aligned.
        d = _item(raw_text="The Board proposes the parties maintain the "
                           "current grievance procedure with no changes.")
        u = _item(raw_text="The Union proposes the parties maintain the "
                           "current grievance procedure with no changes.")
        self.assertEqual(classify_pair(d, u)[0], "aligned")

    def test_language_diff_genuinely_different_positions(self):
        d = _item(raw_text="Part-time certified staff clock in and out each day.")
        u = _item(raw_text="Released time for negotiations begins at noon.")
        self.assertEqual(classify_pair(d, u)[0], "diff")

    def test_same_wording_different_number_is_diff(self):
        # No declared numeric_value, but embedded numbers differ → diff.
        d = _item(raw_text="New staff attend up to 3 days of orientation before the school year.")
        u = _item(raw_text="New staff attend up to 5 days of orientation before the school year.")
        self.assertEqual(classify_pair(d, u)[0], "diff")

    def test_missing_text_is_diff(self):
        d = _item(raw_text=None, summary=None)
        u = _item(raw_text="Some union-only position language here.")
        self.assertEqual(classify_pair(d, u)[0], "diff")


class TestNormalization(unittest.TestCase):
    def test_side_framing_words_dropped(self):
        a = _normalize_text("The Board proposes status quo language")
        b = _normalize_text("The Union proposes status quo language")
        self.assertEqual(a, b)

    def test_digit_guard_blocks_fuzzy_match(self):
        self.assertFalse(
            _text_aligned("orientation lasts 3 days", "orientation lasts 5 days"))


if __name__ == "__main__":
    unittest.main()
