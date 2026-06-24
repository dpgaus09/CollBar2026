#!/bin/bash
set -e

# Install workspace dependencies for the merged code.
pnpm install --frozen-lockfile

# Schema is intentionally NOT applied here with `drizzle-kit push --force`.
#
# This database is managed by a hybrid of versioned migration files
# (db/migrations) plus idempotent ALTERs in the API server's runMigrations()
# (artifacts/api-server/src/app.ts). Several tables (login_events,
# sync_run_status, and the Python pipeline's tables) intentionally exist in the
# DB without a Drizzle declaration, so `drizzle-kit push` always wants to DROP
# them and `push --force` would silently destroy data (it also tries to TRUNCATE
# the populated contracts table to add an already-existing unique constraint).
#
# Additive schema changes are applied idempotently by runMigrations() when the
# API server workflow restarts after this merge. Verify the Drizzle schema and
# the live DB are in sync any time with:
#   pnpm --filter @workspace/db run check-drift
