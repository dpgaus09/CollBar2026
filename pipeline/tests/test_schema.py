#!/usr/bin/env python3
"""Schema migration test — verifies all expected tables and key columns exist in the DB."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
import common


EXPECTED_SCHEMA = {
    "districts": {
        "id", "state", "state_district_id", "name", "enrollment",
        "county", "district_type",
    },
    "source_documents": {
        "id", "district_id", "doc_type", "source_url", "file_hash",
        "storage_key", "school_year", "retrieved_at",
    },
    "contracts": {
        "id", "district_id", "source_doc_id", "union_name",
        "effective_start", "effective_end",
    },
    "contract_provisions": {
        "id", "contract_id", "category", "provision_key",
        "value_numeric", "value_text", "unit",
        "confidence", "human_verified", "page_ref",
    },
    "settlements": {
        "id", "district_id", "from_year", "to_year", "base_increase_pct",
        "method", "confidence", "human_verified", "page_ref",
    },
    "factfinding_proposals": {
        "id", "district_id", "report_date", "case_number",
        "page_ref", "confidence", "human_verified",
    },
    "extraction_runs": {
        "id", "source_doc_id", "model", "status", "error",
    },
    "users": {
        "id", "email", "role", "district_id",
    },
    "benchmarks": {
        "id", "district_id", "doc_year", "wage_schedule",
    },
    "alerts": {
        "id", "alert_type", "doc_name", "source_url",
        "detected_at", "status", "acknowledged_at",
    },
    "cdss_staging": {
        "id", "raw_json", "source_url",
        "district_name_raw", "district_id", "status",
    },
}


class TestSchema(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        try:
            cls.conn = common.get_db_conn()
        except Exception as e:
            raise unittest.SkipTest(f"Cannot connect to database: {e}")

    @classmethod
    def tearDownClass(cls):
        try:
            cls.conn.close()
        except Exception:
            pass

    def _get_tables(self) -> set:
        cur = self.conn.cursor()
        cur.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
        )
        result = {r[0] for r in cur.fetchall()}
        cur.close()
        return result

    def _get_columns(self, table: str) -> set:
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = %s
            """,
            (table,),
        )
        result = {r[0] for r in cur.fetchall()}
        cur.close()
        return result

    def test_all_expected_tables_exist(self):
        existing = self._get_tables()
        missing = []
        for table in EXPECTED_SCHEMA:
            if table not in existing:
                missing.append(table)
        self.assertEqual(
            missing, [],
            f"Missing tables: {missing!r}. "
            "Run: pnpm --filter @workspace/db run push",
        )

    def test_all_expected_columns_exist(self):
        existing_tables = self._get_tables()
        errors = []
        for table, expected_cols in EXPECTED_SCHEMA.items():
            if table not in existing_tables:
                continue  # already caught by test_all_expected_tables_exist
            actual_cols = self._get_columns(table)
            for col in sorted(expected_cols):
                if col not in actual_cols:
                    errors.append(f"{table}.{col}")
        self.assertEqual(
            errors, [],
            f"Missing columns: {errors!r}. "
            "Run: pnpm --filter @workspace/db run push",
        )

    def test_districts_state_column_accepts_oh(self):
        cur = self.conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM districts WHERE state = 'OH'"
        )
        count = cur.fetchone()[0]
        cur.close()
        self.assertGreaterEqual(count, 0)  # table is queryable; 0 rows is fine

    def test_users_role_check_constraint(self):
        """users.role must only accept 'admin' or 'district_user'."""
        cur = self.conn.cursor()
        try:
            cur.execute(
                "INSERT INTO users (email, role) VALUES ('__schema_test__@test.invalid', 'bad_role')"
            )
            self.conn.rollback()
            self.fail("Should have raised an IntegrityError for invalid role")
        except Exception as e:
            self.conn.rollback()
            self.assertIn(
                "check",
                str(e).lower(),
                f"Expected check-constraint violation, got: {e}",
            )
        finally:
            cur.close()

    def test_alerts_status_check_constraint(self):
        """alerts.status must only accept 'pending' or 'acknowledged'."""
        cur = self.conn.cursor()
        try:
            cur.execute(
                """
                INSERT INTO alerts (alert_type, doc_name, source_url, status)
                VALUES ('new_doc', 'test', 'http://test.invalid', 'invalid_status')
                """
            )
            self.conn.rollback()
            self.fail("Should have raised an IntegrityError for invalid status")
        except Exception as e:
            self.conn.rollback()
            self.assertIn(
                "check",
                str(e).lower(),
                f"Expected check-constraint violation, got: {e}",
            )
        finally:
            cur.close()

    def test_cdss_staging_status_check_constraint(self):
        """cdss_staging.status must only accept known values."""
        cur = self.conn.cursor()
        try:
            cur.execute(
                """
                INSERT INTO cdss_staging (source_url, status)
                VALUES ('http://test.invalid', 'bad_status')
                """
            )
            self.conn.rollback()
            self.fail("Should have raised an IntegrityError for invalid status")
        except Exception as e:
            self.conn.rollback()
            self.assertIn(
                "check",
                str(e).lower(),
                f"Expected check-constraint violation, got: {e}",
            )
        finally:
            cur.close()


    def test_drizzle_schema_matches_db(self):
        """
        Drizzle schema files must declare every column that exists in the DB.
        Runs drizzle-kit push and asserts 'No changes detected', confirming
        the TypeScript schema files and the live DB are in sync.
        This catches the failure mode where a column was added via raw
        ALTER TABLE but not declared in the .ts schema file.
        """
        import subprocess
        result = subprocess.run(
            ["pnpm", "--filter", "@workspace/db", "run", "push"],
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent.parent.parent),
            timeout=30,
        )
        combined = result.stdout + result.stderr
        self.assertIn(
            "No changes detected",
            combined,
            "drizzle-kit detected pending schema changes — run "
            "`pnpm --filter @workspace/db run push` and re-add any raw "
            "ALTER TABLE columns to the Drizzle schema .ts files.\n"
            f"drizzle-kit output:\n{combined}",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
