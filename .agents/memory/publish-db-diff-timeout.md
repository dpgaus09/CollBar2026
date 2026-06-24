---
name: Publish DB-diff timeout on cold prod
description: Replit publish-time schema-diff check times out connecting to a cold/suspended Neon production DB; warm prod then retry publish.
---

# Publish "Failed to check for database diff: timeout exceeded when trying to connect"

The Replit Publishing flow introspects BOTH the dev and prod databases and computes
a SQL diff (the supported way prod schema changes are applied). It connects using a
short timeout.

**Symptom:** Publish shows `Failed to check for database diff: timeout exceeded when
trying to connect`. This is NOT a build/run/config failure — build + start are fine.

**Why:** The managed Postgres is Neon-backed and auto-suspends when idle. A cold
connect to the PRODUCTION DB measured ~17s (dev ~5s) — longer than the diff check's
connection timeout — so the check gives up before Neon finishes waking.

**How to apply / fix:**
- Warm the prod DB first, then have the user retry publish within ~5 min (Neon stays
  warm a few minutes after activity). Warm it with a trivial read:
  `executeSql({ sqlQuery: "SELECT 1", environment: "production" })` (read-only is fine
  and is enough to wake it).
- There is no user-facing knob to extend the diff check timeout; warm + retry is the
  practical fix. If it suspends again, re-warm and retry.
- Do NOT "solve" this by pushing schema to prod via scripts, build hooks, or
  startup DDL — see database-migrations-on-publish.md. Letting the publish diff run
  is the correct path; the only blocker here is cold-start latency.
