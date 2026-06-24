import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: "collbar-api",
  // Auto-abort any transaction left idle mid-flight (a request that errored
  // without releasing its client, or a leaked test/script connection). Without
  // this, such a transaction holds its locks indefinitely; a boot-time migration
  // ALTER TABLE then queues an ACCESS EXCLUSIVE lock behind it and every later
  // query on that table — including login's users read — freezes for minutes.
  idle_in_transaction_session_timeout: 60_000,
  // Don't let a saturated pool hang a request forever waiting for a client.
  connectionTimeoutMillis: 10_000,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
