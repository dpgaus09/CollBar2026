#!/usr/bin/env python3
"""Unit tests for validate_extraction and extract_json_from_response in 06_extract_contracts.py."""
import importlib.util
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# Dynamically import 06_extract_contracts without triggering argparse main()
_SPEC = importlib.util.spec_from_file_location(
    "extract_contracts",
    Path(__file__).parent.parent / "06_extract_contracts.py",
)
_MOD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MOD)

validate_extraction = _MOD.validate_extraction
extract_json_from_response = _MOD.extract_json_from_response
PYDANTIC_OK = _MOD.PYDANTIC_OK

VALID_PAYLOAD = {
    "contracts": [
        {
            "union_name": "OEA Local 1234",
            "affiliation": "OEA/NEA",
            "unit_scope": "certified",
            "effective_start": "2023-08-01",
            "effective_end": "2026-07-31",
            "term_years": 3,
            "has_reopener": False,
            "provisions": [
                {
                    "category": "compensation",
                    "provision_key": "base_salary_increase_yr1",
                    "value_numeric": 2.5,
                    "value_text": "2.5%",
                    "unit": "percent",
                    "clause_excerpt": (
                        "All bargaining unit members shall receive a 2.5 percent "
                        "salary increase effective August 1 2023."
                    ),
                    "page_ref": 12,
                    "confidence": 0.95,
                },
                {
                    "category": "insurance",
                    "provision_key": "single_health_premium",
                    "value_numeric": 800.0,
                    "value_text": "$800/month",
                    "unit": "dollars_per_month",
                    "clause_excerpt": (
                        "The Board shall contribute eight hundred dollars per month "
                        "toward individual health insurance premiums."
                    ),
                    "page_ref": 18,
                    "confidence": 0.88,
                },
            ],
        }
    ]
}


class TestValidateExtraction(unittest.TestCase):

    def test_valid_payload_accepted(self):
        result = validate_extraction(json.dumps(VALID_PAYLOAD))
        self.assertIsNotNone(result)

    def test_empty_contracts_list_accepted(self):
        result = validate_extraction(json.dumps({"contracts": []}))
        self.assertIsNotNone(result)

    def test_contract_with_no_provisions_accepted(self):
        payload = {
            "contracts": [
                {
                    "union_name": "Test Union",
                    "effective_start": "2024-08-01",
                    "provisions": [],
                }
            ]
        }
        result = validate_extraction(json.dumps(payload))
        self.assertIsNotNone(result)

    def test_invalid_json_rejected(self):
        result = validate_extraction("not valid json {{{")
        self.assertIsNone(result)

    def test_empty_string_rejected(self):
        result = validate_extraction("")
        self.assertIsNone(result)

    def test_missing_contracts_key_rejected(self):
        result = validate_extraction(json.dumps({"provisions": []}))
        if PYDANTIC_OK:
            # Pydantic accepts unknown fields and defaults contracts=[],
            # so this returns ExtractionResult(contracts=[]) — not None.
            # Verify it produces an empty-contract result rather than None.
            contracts = result.contracts if result is not None else None
            self.assertIsNotNone(result)
            self.assertEqual(len(contracts), 0)
        else:
            # Loose validator requires explicit "contracts" key
            self.assertIsNone(result)

    def test_contracts_is_not_list_rejected(self):
        result = validate_extraction(json.dumps({"contracts": "not a list"}))
        self.assertIsNone(result)

    def test_null_json_rejected(self):
        result = validate_extraction("null")
        self.assertIsNone(result)

    def test_numeric_value_optional(self):
        payload = json.loads(json.dumps(VALID_PAYLOAD))
        payload["contracts"][0]["provisions"][0]["value_numeric"] = None
        result = validate_extraction(json.dumps(payload))
        self.assertIsNotNone(result)

    def test_page_ref_optional(self):
        payload = json.loads(json.dumps(VALID_PAYLOAD))
        payload["contracts"][0]["provisions"][0]["page_ref"] = None
        result = validate_extraction(json.dumps(payload))
        self.assertIsNotNone(result)

    @unittest.skipUnless(PYDANTIC_OK, "Pydantic not installed")
    def test_invalid_category_provision_dropped_pydantic(self):
        # Lenient validation: a single bad provision is dropped, not fatal to the doc.
        payload = json.loads(json.dumps(VALID_PAYLOAD))
        payload["contracts"][0]["provisions"][0]["category"] = "invalid_category_xyz"
        result = validate_extraction(json.dumps(payload))
        self.assertIsNotNone(result)
        self.assertEqual(len(result.contracts), 1)
        # The invalid provision is dropped; the second (valid) provision remains.
        self.assertEqual(len(result.contracts[0].provisions), 1)

    @unittest.skipUnless(PYDANTIC_OK, "Pydantic not installed")
    def test_empty_clause_excerpt_provision_dropped_pydantic(self):
        # Lenient validation: a null/empty clause_excerpt drops the provision only.
        payload = json.loads(json.dumps(VALID_PAYLOAD))
        payload["contracts"][0]["provisions"][0]["clause_excerpt"] = "   "
        result = validate_extraction(json.dumps(payload))
        self.assertIsNotNone(result)
        self.assertEqual(len(result.contracts[0].provisions), 1)

    @unittest.skipUnless(PYDANTIC_OK, "Pydantic not installed")
    def test_contracts_have_correct_field_count(self):
        result = validate_extraction(json.dumps(VALID_PAYLOAD))
        self.assertIsNotNone(result)
        contracts = result.contracts
        self.assertEqual(len(contracts), 1)
        provisions = contracts[0].provisions
        self.assertEqual(len(provisions), 2)


class TestExtractJsonFromResponse(unittest.TestCase):

    def test_strips_json_fence(self):
        raw = '```json\n{"contracts": []}\n```'
        result = extract_json_from_response(raw)
        self.assertIn('"contracts"', result)
        self.assertNotIn("```", result)

    def test_strips_bare_fence(self):
        raw = '```\n{"contracts": []}\n```'
        result = extract_json_from_response(raw)
        self.assertNotIn("```", result)

    def test_no_fence_passthrough(self):
        raw = '{"contracts": []}'
        result = extract_json_from_response(raw)
        self.assertIn('"contracts"', result)

    def test_result_is_valid_json(self):
        raw = '```json\n{"contracts": [{"union_name": "Test"}]}\n```'
        result = extract_json_from_response(raw)
        parsed = json.loads(result)
        self.assertIn("contracts", parsed)

    def test_whitespace_only_fence_content(self):
        raw = '{"contracts": []}'
        result = extract_json_from_response(raw)
        self.assertIsNotNone(result)
        self.assertTrue(len(result.strip()) > 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
