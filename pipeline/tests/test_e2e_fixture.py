#!/usr/bin/env python3
"""
End-to-end fixture test for the extraction pipeline.

Patches call_anthropic to return a fixed JSON response, then runs the full
validate → shape-check flow and verifies that the LLM response round-trips
correctly through the validation and extraction helpers.

DB insert functions (upsert_contract / insert_provisions) are tested against
a real DB in a rolled-back transaction so no permanent rows are left behind.
The DB test is skipped automatically when DATABASE_URL is not set.
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))
import common

# Dynamically import 06_extract_contracts without running main()
_SPEC = importlib.util.spec_from_file_location(
    "extract_contracts",
    Path(__file__).parent.parent / "06_extract_contracts.py",
)
_MOD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MOD)

validate_extraction = _MOD.validate_extraction
extract_json_from_response = _MOD.extract_json_from_response
upsert_contract = _MOD.upsert_contract
insert_provisions = _MOD.insert_provisions
PYDANTIC_OK = _MOD.PYDANTIC_OK

# Fixed LLM response used throughout all fixture tests
FIXTURE_LLM_RESPONSE = json.dumps({
    "contracts": [
        {
            "union_name": "OEA Fixture Local 999",
            "affiliation": "OEA/NEA",
            "unit_scope": "certified",
            "effective_start": "2023-08-01",
            "effective_end": "2026-07-31",
            "term_years": 3,
            "has_reopener": False,
            "reopener_terms": None,
            "provisions": [
                {
                    "category": "compensation",
                    "provision_key": "base_salary_increase_yr1",
                    "value_numeric": 3.0,
                    "value_text": "3.0%",
                    "unit": "percent",
                    "clause_excerpt": (
                        "Each bargaining unit member shall receive a three percent "
                        "salary increase effective August 1 2023."
                    ),
                    "page_ref": 5,
                    "confidence": 0.93,
                },
                {
                    "category": "insurance",
                    "provision_key": "single_health_premium",
                    "value_numeric": 875.0,
                    "value_text": "$875/month",
                    "unit": "dollars_per_month",
                    "clause_excerpt": (
                        "The Board shall contribute eight hundred seventy-five dollars "
                        "per month toward individual health insurance premiums."
                    ),
                    "page_ref": 19,
                    "confidence": 0.89,
                },
                {
                    "category": "compensation",
                    "provision_key": "base_salary_increase_yr2",
                    "value_numeric": 2.75,
                    "value_text": "2.75%",
                    "unit": "percent",
                    "clause_excerpt": (
                        "Effective August 1 2024 each employee shall receive "
                        "a 2.75 percent salary increase."
                    ),
                    "page_ref": 5,
                    "confidence": 0.91,
                },
            ],
        }
    ]
})


class TestFixtureValidation(unittest.TestCase):
    """validate_extraction on the fixture payload."""

    def test_fixture_accepted(self):
        result = validate_extraction(FIXTURE_LLM_RESPONSE)
        self.assertIsNotNone(result)

    def test_fixture_contract_count(self):
        result = validate_extraction(FIXTURE_LLM_RESPONSE)
        contracts = result.contracts if PYDANTIC_OK else result["contracts"]
        self.assertEqual(len(contracts), 1)

    def test_fixture_provision_count(self):
        result = validate_extraction(FIXTURE_LLM_RESPONSE)
        contracts = result.contracts if PYDANTIC_OK else result["contracts"]
        provisions = contracts[0].provisions if PYDANTIC_OK else contracts[0]["provisions"]
        self.assertEqual(len(provisions), 3)

    def test_fixture_provision_keys(self):
        result = validate_extraction(FIXTURE_LLM_RESPONSE)
        contracts = result.contracts if PYDANTIC_OK else result["contracts"]
        provisions = contracts[0].provisions if PYDANTIC_OK else contracts[0]["provisions"]
        if PYDANTIC_OK:
            keys = {p.provision_key for p in provisions}
        else:
            keys = {p["provision_key"] for p in provisions}
        self.assertIn("base_salary_increase_yr1", keys)
        self.assertIn("base_salary_increase_yr2", keys)
        self.assertIn("single_health_premium", keys)

    def test_fixture_yr1_value(self):
        result = validate_extraction(FIXTURE_LLM_RESPONSE)
        contracts = result.contracts if PYDANTIC_OK else result["contracts"]
        provisions = contracts[0].provisions if PYDANTIC_OK else contracts[0]["provisions"]
        if PYDANTIC_OK:
            yr1 = next(p for p in provisions if p.provision_key == "base_salary_increase_yr1")
            self.assertAlmostEqual(yr1.value_numeric, 3.0)
            self.assertEqual(yr1.page_ref, 5)
            self.assertGreater(yr1.confidence, 0.8)
        else:
            yr1 = next(p for p in provisions if p["provision_key"] == "base_salary_increase_yr1")
            self.assertAlmostEqual(float(yr1["value_numeric"]), 3.0)

    @unittest.skipUnless(PYDANTIC_OK, "Pydantic not installed")
    def test_fixture_union_name(self):
        result = validate_extraction(FIXTURE_LLM_RESPONSE)
        self.assertEqual(result.contracts[0].union_name, "OEA Fixture Local 999")


class TestMockedLLMFlow(unittest.TestCase):
    """Full flow with call_anthropic mocked."""

    def test_mock_call_returns_fixture(self):
        with patch.object(_MOD, "call_anthropic", return_value=FIXTURE_LLM_RESPONSE):
            raw = _MOD.call_anthropic("system-prompt", "pdf-text-here")
        self.assertIsNotNone(raw)

    def test_mock_flow_validates_cleanly(self):
        with patch.object(_MOD, "call_anthropic", return_value=FIXTURE_LLM_RESPONSE):
            raw = _MOD.call_anthropic("system-prompt", "pdf-text-here")
        cleaned = extract_json_from_response(raw)
        result = validate_extraction(cleaned)
        self.assertIsNotNone(result)

    def test_mock_flow_fence_stripped(self):
        fenced = f"```json\n{FIXTURE_LLM_RESPONSE}\n```"
        with patch.object(_MOD, "call_anthropic", return_value=fenced):
            raw = _MOD.call_anthropic("s", "t")
        cleaned = extract_json_from_response(raw)
        result = validate_extraction(cleaned)
        self.assertIsNotNone(result)


class TestDBInsertFlow(unittest.TestCase):
    """upsert_contract + insert_provisions in a rolled-back transaction."""

    @classmethod
    def setUpClass(cls):
        try:
            cls.conn = common.get_db_conn()
        except Exception as e:
            raise unittest.SkipTest(f"DATABASE_URL not available: {e}")

        # We need a real district row to satisfy the FK on contracts.district_id
        cur = cls.conn.cursor()
        cur.execute(
            """
            INSERT INTO districts (state, state_district_id, name)
            VALUES ('OH', '999999', '__fixture_test_district__')
            ON CONFLICT (state, state_district_id) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
            """
        )
        cls.fixture_district_id = cur.fetchone()[0]
        cur.close()
        cls.conn.commit()

    @classmethod
    def tearDownClass(cls):
        cur = cls.conn.cursor()
        cur.execute("DELETE FROM districts WHERE state_district_id = '999999' AND state = 'OH'")
        cls.conn.commit()
        cur.close()
        cls.conn.close()

    def test_upsert_contract_and_provisions(self):
        result = validate_extraction(FIXTURE_LLM_RESPONSE)
        self.assertIsNotNone(result)

        contracts = result.contracts if PYDANTIC_OK else result["contracts"]
        contract_data = contracts[0]

        cur = self.conn.cursor()
        try:
            # upsert_contract expects a psycopg2 cursor and source_doc_id=None is OK
            contract_id = upsert_contract(cur, self.fixture_district_id, contract_data, None)
            self.assertIsNotNone(contract_id)
            self.assertIsInstance(contract_id, int)

            provisions = (
                contract_data.provisions if PYDANTIC_OK else contract_data["provisions"]
            )
            n = insert_provisions(cur, contract_id, provisions)
            self.assertEqual(n, 3, f"Expected 3 provisions inserted, got {n}")

            # Verify rows exist (within the transaction)
            cur.execute("SELECT COUNT(*) FROM contracts WHERE id = %s", (contract_id,))
            self.assertEqual(cur.fetchone()[0], 1)

            cur.execute(
                "SELECT COUNT(*) FROM contract_provisions WHERE contract_id = %s",
                (contract_id,),
            )
            self.assertEqual(cur.fetchone()[0], 3)
        finally:
            self.conn.rollback()
            cur.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
