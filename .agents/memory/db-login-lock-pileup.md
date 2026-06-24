---
name: Dev login lock pileup
description: Why all logins froze for 30-106s and the pool setting that prevents it; the likely trigger to avoid.
---

# Dev login freeze: idle-in-transaction lock pileup on `users`

## Failure mode (observed 2026-06-24)
All logins hung on "Signing in..." and aborted after 30-106s. Root cause chain:
1. A connection sat **idle in transaction** holding a lock on `users`
   (root blocker showed wait `ClientRead`).
2. The API server's boot-time `runMigrations()` first statement is
   `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...` — that needs `ACCESS
   EXCLUSIVE`, so it **queued behind** the idle txn.
3. A queued `ACCESS EXCLUSIVE` request blocks *all* later lock requests on
   `users`, so every login / `/auth/me` (a `users` read) piled up behind it
   until client abort. `blocked` count in `pg_stat_activity` was non-zero.

`ALTER ... IF NOT EXISTS` still takes the exclusive lock even when it changes
nothing, so this fires on every restart — normally instant, catastrophic only
when something else already holds a conflicting lock.

## The fix (durable)
`lib/db/src/index.ts` Pool now sets `idle_in_transaction_session_timeout =
60000`. Postgres auto-aborts the leaked txn → releases its `users` lock → the
boot ALTER proceeds → no pileup. **Do not remove this** or the freeze returns.
Also set `application_name='collbar-api'` (so future pile-ups are attributable
in `pg_stat_activity`) and `connectionTimeoutMillis=10000`.

**Why not `statement_timeout` / `lock_timeout`:** the shared pool also serves
`promote.ts` long copies and heavy admin reports; a global statement cap would
break those. `idle_in_transaction_session_timeout` only aborts sessions IDLE
*between* statements in a txn — it never interrupts an actively-running query —
so promote and migrations are safe.

## Likely trigger to avoid
The `test` workflow runs `vitest` against the **live dev DATABASE_URL**; its
`beforeAll/afterAll` do `DELETE FROM users` / inserts inside transactions. A
stalled/leaked test connection is the prime suspect for the idle-in-txn holder.
Running the suite against the live dev DB while the app is up is dangerous.

## Recovery if it recurs
`pg_terminate_backend(pid)` the blockers (find via `pg_blocking_pids`), then
restart "artifacts/api-server: API Server". Verify with direct curl to
`http://localhost:8080/api/healthz` and `/api/auth/login` (bad creds → fast 401).
