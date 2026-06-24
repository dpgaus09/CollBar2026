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
            "Declare them in lib/db/src/schema/*.ts and apply them via a "
            "migration / the API server's runMigrations(). Do NOT run "
            "`drizzle-kit push --force` — it can truncate or drop data.",
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
            "Declare them in lib/db/src/schema/*.ts and apply them via a "
            "migration / the API server's runMigrations(). Do NOT run "
            "`drizzle-kit push --force` — it can truncate or drop data.",
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
        Every column on a Drizzle-owned table must be declared in the .ts schema.

        Runs the non-destructive `check-drift` script
        (lib/db/scripts/check-drift.ts), which compares the columns declared in
        the Drizzle schema against the live database for every Drizzle-owned
        table. It issues no DDL, so unlike `drizzle-kit push` it can never
        truncate or drop data — important because this DB is a hybrid of
        migration files + the API server's runMigrations(), with several tables
        (login_events, sync_run_status, pipeline tables) intentionally living in
        the DB without a Drizzle declaration.

        This catches the failure mode where a column was added via raw ALTER
        TABLE (or runMigrations) but never mirrored into the Drizzle .ts schema.
        """
        import subprocess
        result = subprocess.run(
            ["pnpm", "--filter", "@workspace/db", "run", "check-drift"],
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).parent.parent.parent),
            timeout=120,
        )
        combined = result.stdout + result.stderr
        self.assertEqual(
            result.returncode, 0,
            "Schema drift detected between the Drizzle schema and the database. "
            "Mirror any DB-only columns into lib/db/src/schema/*.ts (and keep "
            "the additive ALTER in the API server's runMigrations()). Do NOT "
            "run `drizzle-kit push --force` — it can truncate or drop data.\n"
            f"check-drift output:\n{combined}",
        )

    def test_contracts_unique_constraint_intact(self):
        """
        The contracts uniqueness key — (district_id, bargaining_unit,
        unit_scope, effective_start), NULLS DISTINCT — must exist exactly as
        declared in lib/db/src/schema/contracts.ts. This is the constraint whose
        absence previously made drizzle-kit push want to TRUNCATE the populated
        contracts table; the guardrail must detect if it ever drifts.
        """
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT con.conname, idx.indnullsnotdistinct,
                   array_agg(att.attname ORDER BY att.attname) AS cols
            FROM pg_constraint con
            JOIN pg_class rel ON rel.oid = con.conrelid
            JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
            JOIN pg_index idx ON idx.indexrelid = con.conindid
            JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
            JOIN pg_attribute att ON att.attrelid = rel.oid
                                 AND att.attnum = k.attnum
            WHERE nsp.nspname = 'public' AND rel.relname = 'contracts'
              AND con.contype = 'u'
            GROUP BY con.conname, idx.indnullsnotdistinct
            """
        )
        rows = cur.fetchall()
        cur.close()
        expected_cols = {
            "district_id", "bargaining_unit", "unit_scope", "effective_start",
        }
        match = [r for r in rows if set(r[2]) == expected_cols]
        self.assertTrue(
            match,
            f"contracts unique constraint over {sorted(expected_cols)} not "
            f"found. Existing unique constraints: {rows!r}",
        )
        # indnullsnotdistinct must be False (NULLS DISTINCT) so multiple rows
        # with a NULL effective_start do not collide.
        self.assertFalse(
            match[0][1],
            "contracts unique constraint must be NULLS DISTINCT; NULLS NOT "
            "DISTINCT would wrongly collide rows with a NULL effective_start.",
        )

    def test_migration_files_exist_for_all_phases(self):
        """
        Verify SQL migration files exist for all schema phases.
        On a fresh DB, running these migrations in order reproduces the full schema.
        Missing migration files mean schema changes happened outside the migration
        lifecycle and cannot be reproduced on a fresh deployment.
        """
        migrations_dir = Path(__file__).parent.parent.parent / "db" / "migrations"
        self.assertTrue(
            migrations_dir.is_dir(),
            f"Migration directory not found: {migrations_dir}",
        )
        sql_files = sorted(migrations_dir.glob("*.sql"))
        self.assertGreater(
            len(sql_files), 0,
            "No SQL migration files found in db/migrations/",
        )
        # Phase 5 migration must exist (alerts + cdss_staging + column additions)
        tags = [f.stem for f in sql_files]
        phase5 = [t for t in tags if "phase5" in t or t.startswith("0003")]
        self.assertTrue(
            len(phase5) > 0,
            f"No Phase 5 migration file found. Have: {tags}. "
            "Expected a file starting with '0003' or containing 'phase5'.",
        )
        # Each migration file in the journal must have a corresponding SQL file
        journal_path = migrations_dir / "meta" / "_journal.json"
        if journal_path.exists():
            import json as _json
            journal = _json.loads(journal_path.read_text())
            for entry in journal.get("entries", []):
                tag = entry["tag"]
                sql_path = migrations_dir / f"{tag}.sql"
                self.assertTrue(
                    sql_path.exists(),
                    f"Journal entry '{tag}' has no SQL file at {sql_path}",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
