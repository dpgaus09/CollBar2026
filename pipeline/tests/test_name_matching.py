#!/usr/bin/env python3
"""Unit tests for common.normalise_employer and common.match_employer."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from common import normalise_employer, match_employer


class TestNormaliseEmployer(unittest.TestCase):

    def test_strips_board_of_education(self):
        self.assertEqual(normalise_employer("Akron City Board of Education"), "akron city")

    def test_strips_school_district(self):
        self.assertEqual(normalise_employer("Columbus City School District"), "columbus city")

    def test_strips_schools_plural(self):
        self.assertEqual(normalise_employer("Lakewood City Schools"), "lakewood city")

    def test_strips_school_singular(self):
        result = normalise_employer("Ada School")
        self.assertEqual(result, "ada")

    def test_expands_co_slash(self):
        result = normalise_employer("Adams Co/Ohio Valley Local School District")
        self.assertIn("county", result)
        self.assertNotIn("/", result)

    def test_expands_co_space(self):
        result = normalise_employer("Clark Co School District")
        self.assertIn("county", result)

    def test_expands_st_prefix(self):
        result = normalise_employer("St Mary School District")
        self.assertIn("saint", result)

    def test_slash_replaced_by_space(self):
        result = normalise_employer("Clark/Shawnee Local School District")
        self.assertNotIn("/", result)

    def test_already_clean_name(self):
        result = normalise_employer("Worthington City")
        self.assertEqual(result, "worthington city")

    def test_trailing_punctuation_stripped(self):
        result = normalise_employer("Ada Exempted Village,")
        self.assertFalse(result.endswith(","))
        self.assertFalse(result.endswith("."))

    def test_extra_whitespace_collapsed(self):
        result = normalise_employer("  Upper   Arlington   City  ")
        self.assertEqual(result, "upper arlington city")

    def test_joint_vocational_stripped(self):
        result = normalise_employer("Wayne County Joint Vocational School District")
        self.assertNotIn("joint vocational school district", result)

    def test_career_center_stripped(self):
        result = normalise_employer("Tri-County Career Center")
        self.assertNotIn("career center", result)

    def test_lowercased(self):
        result = normalise_employer("AKRON CITY BOARD OF EDUCATION")
        self.assertEqual(result, result.lower())

    def test_empty_string(self):
        result = normalise_employer("")
        self.assertEqual(result, "")


class TestMatchEmployer(unittest.TestCase):
    DIST_INDEX = {
        "akron city": (1, "Akron City"),
        "columbus city": (2, "Columbus City"),
        "worthington city": (3, "Worthington City"),
        "upper arlington city": (4, "Upper Arlington City"),
        "ada exempted village": (5, "Ada Exempted Village"),
    }

    def test_exact_match_after_normalise(self):
        did, status, matched = match_employer(
            "Akron City Board of Education", self.DIST_INDEX
        )
        self.assertEqual(status, "auto")
        self.assertEqual(did, 1)

    def test_school_district_suffix_stripped_then_matched(self):
        did, status, matched = match_employer(
            "Columbus City School District", self.DIST_INDEX
        )
        self.assertEqual(status, "auto")
        self.assertEqual(did, 2)

    def test_unmatched_gibberish(self):
        _, status, _ = match_employer("Completely Unknown XYZ School 99999", self.DIST_INDEX)
        self.assertIn(status, ("unmatched", "review"))

    def test_empty_index_returns_unmatched(self):
        _, status, _ = match_employer("Akron City Board of Education", {})
        self.assertEqual(status, "unmatched")

    def test_fuzzy_near_miss_auto_or_review(self):
        _, status, _ = match_employer(
            "Upper Arlingtn City Board of Education", self.DIST_INDEX
        )
        self.assertIn(status, ("auto", "review"))

    def test_return_type_is_tuple_of_three(self):
        result = match_employer("Akron City Board of Education", self.DIST_INDEX)
        self.assertIsInstance(result, tuple)
        self.assertEqual(len(result), 3)

    def test_auto_match_returns_district_id(self):
        did, status, _ = match_employer("Worthington City", self.DIST_INDEX)
        self.assertEqual(status, "auto")
        self.assertIsNotNone(did)
        self.assertIsInstance(did, int)

    def test_unmatched_returns_none_district_id(self):
        did, status, _ = match_employer("Zzzz Nonexistent XYZ", self.DIST_INDEX)
        if status == "unmatched":
            self.assertIsNone(did)


if __name__ == "__main__":
    unittest.main(verbosity=2)
