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


class TestExtractionPipelineFromFixturePDF(unittest.TestCase):
    """
    End-to-end test using a real fixture PDF stored in pipeline/data/cba/.

    extract_pdf_text() is called on the actual file (pdfplumber path), then
    call_anthropic is patched to return the deterministic FIXTURE_LLM_RESPONSE.
    The full validate → shape-check → DB-insert flow is exercised so that
    regressions in PDF parsing, validation, or DB persistence are caught.
    """

    FIXTURE_PDF = Path(__file__).parent.parent / "data" / "cba" / "21-CON-01-0108.pdf"

    @classmethod
    def setUpClass(cls):
        if not cls.FIXTURE_PDF.exists():
            raise unittest.SkipTest(f"Fixture PDF not found: {cls.FIXTURE_PDF}")
        try:
            import pdfplumber  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("pdfplumber not installed")
        try:
            cls.conn = common.get_db_conn()
        except Exception as e:
            raise unittest.SkipTest(f"DATABASE_URL not available: {e}")

        cur = cls.conn.cursor()
        cur.execute(
            """
            INSERT INTO districts (state, state_district_id, name)
            VALUES ('OH', '999998', '__e2e_pdf_test_district__')
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
        cur.execute(
            "DELETE FROM districts WHERE state_district_id = '999998' AND state = 'OH'"
        )
        cls.conn.commit()
        cur.close()
        cls.conn.close()

    def test_pdf_text_extraction_produces_content(self):
        """extract_pdf_text on the fixture PDF must return non-empty text."""
        text, used_ocr = _MOD.extract_pdf_text(self.FIXTURE_PDF)
        self.assertIsInstance(text, str)
        self.assertGreater(len(text), 50, "Expected meaningful text from fixture PDF")
        self.assertFalse(used_ocr, "Fixture PDF should have a usable text layer")

    def test_full_pipeline_with_mocked_llm(self):
        """
        Full path: PDF text extraction → (mocked) LLM call → validate →
        upsert_contract → insert_provisions — all in a rolled-back transaction.
        """
        # Step 1: extract real text from the fixture PDF
        text, _ = _MOD.extract_pdf_text(self.FIXTURE_PDF)
        self.assertGreater(len(text), 50, "PDF text extraction failed")

        # Step 2: call the LLM (mocked) using the extracted text
        with patch.object(_MOD, "call_anthropic", return_value=FIXTURE_LLM_RESPONSE):
            raw = _MOD.call_anthropic("system-prompt", text)

        # Step 3: validate and parse
        cleaned = extract_json_from_response(raw)
        result = validate_extraction(cleaned)
        self.assertIsNotNone(result, "validate_extraction returned None for fixture LLM response")

        # Step 4: DB insert (rolled back so no permanent rows)
        contracts = result.contracts if PYDANTIC_OK else result["contracts"]
        contract_data = contracts[0]
        cur = self.conn.cursor()
        try:
            contract_id = upsert_contract(cur, self.fixture_district_id, contract_data, None)
            self.assertIsNotNone(contract_id)
            self.assertIsInstance(contract_id, int)

            provisions = (
                contract_data.provisions if PYDANTIC_OK else contract_data["provisions"]
            )
            n = insert_provisions(cur, contract_id, provisions)
            self.assertEqual(n, 3, f"Expected 3 provisions, got {n}")

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


class TestFreshSchemaMigrations(unittest.TestCase):
    """
    Apply all SQL migration files to a freshly-created PostgreSQL schema and
    verify the expected tables are created. This proves the migration files
    are sufficient to reproduce the full schema from scratch on a new database.
    """

    @classmethod
    def setUpClass(cls):
        import uuid
        cls.schema = f"test_migration_{uuid.uuid4().hex[:8]}"
        try:
            cls.conn = common.get_db_conn()
        except Exception as e:
            raise unittest.SkipTest(f"DATABASE_URL not available: {e}")

    @classmethod
    def tearDownClass(cls):
        cur = cls.conn.cursor()
        cur.execute(f'DROP SCHEMA IF EXISTS "{cls.schema}" CASCADE')
        cls.conn.commit()
        cur.close()
        cls.conn.close()

    def test_migrations_apply_cleanly_to_fresh_schema(self):
        """
        Apply all migration SQL files in order to a blank schema and assert
        all core tables are created. Catches: missing migration files, DDL
        errors in any migration, or tables accidentally omitted from migrations.
        """
        migrations_dir = Path(__file__).parent.parent.parent / "db" / "migrations"
        sql_files = sorted(migrations_dir.glob("*.sql"))
        self.assertGreater(len(sql_files), 0, "No migration SQL files found")

        cur = self.conn.cursor()
        try:
            cur.execute(f'CREATE SCHEMA "{self.schema}"')
            cur.execute(f'SET search_path TO "{self.schema}", public')

            for sql_file in sql_files:
                sql = sql_file.read_text()
                statements = [
                    s.strip()
                    for s in sql.split("--> statement-breakpoint")
                    if s.strip()
                ]
                for stmt in statements:
                    cur.execute(stmt)

            self.conn.commit()

            # Verify core tables were created in the fresh schema
            cur.execute(
                """
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = %s
                """,
                (self.schema,),
            )
            created_tables = {row[0] for row in cur.fetchall()}
            required = {
                "districts", "source_documents", "contracts",
                "contract_provisions", "settlements", "factfinding_proposals",
                "alerts", "cdss_staging",
            }
            missing = required - created_tables
            self.assertEqual(
                missing,
                set(),
                f"Tables missing after fresh migration: {missing}. "
                f"Created: {sorted(created_tables)}",
            )
        except Exception:
            self.conn.rollback()
            raise
        finally:
            cur.execute(f'SET search_path TO public')
            cur.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
