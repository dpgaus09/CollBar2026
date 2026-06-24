/**
 * Non-destructive schema drift check.
 *
 * Compares the columns declared in the Drizzle schema (lib/db/src/schema)
 * against the live database, for every table the Drizzle schema owns.
 *
 * Why this exists instead of `drizzle-kit push`: this database is managed by a
 * hybrid of versioned migration files (db/migrations) plus idempotent ALTERs in
 * the API server's runMigrations(). Several tables intentionally live in the DB
 * without a Drizzle declaration (e.g. login_events, sync_run_status, and the
 * Python pipeline's tables). A `drizzle-kit push` diff therefore always wants to
 * DROP those tables and can never report "No changes", and `push --force` would
 * silently destroy data. This check is strictly read-only: it issues no DDL.
 *
 * It catches the failure mode the guardrail cares about: a column added to a
 * Drizzle-owned table via raw ALTER (or runMigrations) but never mirrored into
 * the .ts schema, and the reverse (schema declares a column the DB lacks).
 *
 * Exit codes: 0 = no drift, 1 = drift (with a per-item report), 2 = error.
 */
import pg from "pg";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/schema/index";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set");
    process.exit(2);
  }

  // Expected: table name -> set of column names, derived from the Drizzle schema.
  const expected = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      const cfg = getTableConfig(value);
      expected.set(cfg.name, new Set(cfg.columns.map((c) => c.name)));
    }
  }

  if (expected.size === 0) {
    console.error("No Drizzle tables found — schema import likely failed.");
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  let rows: { table_name: string; column_name: string }[];
  try {
    const res = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    rows = res.rows;
  } finally {
    await pool.end();
  }

  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = actual.get(row.table_name);
    if (!set) {
      set = new Set<string>();
      actual.set(row.table_name, set);
    }
    set.add(row.column_name);
  }

  const drift: string[] = [];
  for (const [table, cols] of [...expected.entries()].sort()) {
    const live = actual.get(table);
    if (!live) {
      drift.push(
        `MISSING TABLE: "${table}" is declared in the Drizzle schema but does not exist in the database.`,
      );
      continue;
    }
    for (const col of [...cols].sort()) {
      if (!live.has(col)) {
        drift.push(
          `SCHEMA-AHEAD: "${table}.${col}" is in the Drizzle schema but not in the database (migration not applied?).`,
        );
      }
    }
    for (const col of [...live].sort()) {
      if (!cols.has(col)) {
        drift.push(
          `UNDECLARED:   "${table}.${col}" exists in the database but is not declared in the Drizzle schema (raw ALTER not mirrored into lib/db/src/schema?).`,
        );
      }
    }
  }

  if (drift.length > 0) {
    console.error("Schema drift detected between the Drizzle schema and the database:\n");
    console.error(drift.join("\n"));
    console.error(
      `\n${drift.length} drift item(s) across ${expected.size} Drizzle-owned tables.`,
    );
    process.exit(1);
  }

  console.log(
    `No schema drift: all ${expected.size} Drizzle-owned tables match the database.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("check-drift failed:", err);
  process.exit(2);
});
