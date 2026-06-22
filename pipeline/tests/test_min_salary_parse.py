#!/usr/bin/env python3
"""Safety-net tests for the CGFA minimum-teacher-salary importer (17_sync_il_min_salary).

The CGFA certification PDF is re-published every July and its wording drifts year
to year. Two parsing rules are subtle and easy to break with a future PDF tweak:

  1. There are TWO near-identical "Minimum Salary Rate for the YYYY-YYYY School
     Year ... $NN,NNN" lines. The FIRST is the prior year + rate, the LAST is the
     new school-year rate we actually want to store.
  2. The "Applicable Percentage Increase" line carries a footnote digit glued to
     the label ("Percentage Increase1 (not less than 0) 2.67%"). The parser must
     ignore that footnote "1" and capture the real percentage (2.67%).

These tests pin the parser to the known 2025 certification (for the 2026-2027
school year) so a silently-wrong number is caught immediately. A second test
confirms re-running with the same file is a no-op via the SHA-256 hash-skip and
never creates a duplicate row.
"""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

_PKG_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_PKG_ROOT))

# Module filename starts with a digit, so load it explicitly.
_spec = importlib.util.spec_from_file_location(
    "sync_il_min_salary", _PKG_ROOT / "17_sync_il_min_salary.py")
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

CERT_PDF = (
    Path(__file__).parents[2]
    / "attached_assets"
    / "Teacher_Salary_Certification_2025_1782094962663.pdf"
)


class TestParseCertification2025(unittest.TestCase):
    """Pin the parser to the known 2025 CGFA certification figures."""

    @classmethod
    def setUpClass(cls):
        if not CERT_PDF.exists():
            raise unittest.SkipTest(f"Certification fixture missing: {CERT_PDF}")
        data = CERT_PDF.read_bytes()
        cls.rec = mod.parse_certification(mod._pdf_text(data))

    def test_new_school_year_is_last_rate_line(self):
        self.assertEqual(self.rec["school_year"], "2026-2027")

    def test_new_year_rate(self):
        self.assertEqual(self.rec["new_year_rate"], 43543)

    def test_prior_school_year_is_first_rate_line(self):
        self.assertEqual(self.rec["prior_year"], "2025-2026")

    def test_prior_year_rate(self):
        self.assertEqual(self.rec["prior_year_rate"], 42411)

    def test_percentage_ignores_footnote_digit(self):
        # "Applicable Percentage Increase1 (not less than 0) 2.67%" — the glued
        # footnote "1" must NOT be read as the percentage.
        self.assertEqual(self.rec["percentage_increase"], 2.67)

    def test_certified_date(self):
        self.assertEqual(self.rec["certified_date"], "2025-07-15")


class _FakeCursor:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, *a, **k):
        pass


class _FakeConn:
    def cursor(self):
        return _FakeCursor()

    def commit(self):
        pass

    def close(self):
        pass


class TestRerunIsNoOp(unittest.TestCase):
    """Re-running with the same PDF must hash-skip and not insert a duplicate row."""

    def test_second_run_skips_upsert(self):
        if not CERT_PDF.exists():
            self.skipTest(f"Certification fixture missing: {CERT_PDF}")

        # Minimal in-memory stand-in for the il_min_teacher_salary table:
        # school_year -> {"hash": ..., "rows": <count>}.
        store: dict[str, dict] = {}

        def fake_existing_hash(conn, school_year):
            return store.get(school_year, {}).get("hash")

        def fake_upsert(conn, rec, source_url, file_hash):
            entry = store.setdefault(rec["school_year"], {"rows": 0})
            entry["hash"] = file_hash
            entry["rows"] += 1

        with mock.patch.object(mod.common, "get_db_conn", return_value=_FakeConn()), \
                mock.patch.object(mod.common, "upload_to_object_storage", return_value=""), \
                mock.patch.object(mod, "_ensure_table"), \
                mock.patch.object(mod, "_existing_hash", side_effect=fake_existing_hash), \
                mock.patch.object(mod, "_upsert", side_effect=fake_upsert), \
                mock.patch.object(mod, "MIN_SALARY_DIR", Path(self._tmp())):

            first = mod.run(pdf_path=str(CERT_PDF))
            second = mod.run(pdf_path=str(CERT_PDF))

        self.assertEqual(first["status"], "success")
        self.assertEqual(second["status"], "no_change")
        self.assertEqual(store["2026-2027"]["rows"], 1)

    def _tmp(self):
        import tempfile

        d = tempfile.mkdtemp(prefix="min_salary_test_")
        self.addCleanup(lambda: __import__("shutil").rmtree(d, ignore_errors=True))
        return d


if __name__ == "__main__":
    unittest.main(verbosity=2)
