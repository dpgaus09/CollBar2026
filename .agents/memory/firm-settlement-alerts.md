---
name: Firm settlement alerts (Phase 6)
description: How CollBar firm-workspace settlement/contract alerts dedup, scope, and hook into ingest
---
Settlement alerts (firm workspace /app/alerts) reuse the shared GLOBAL `alerts` table — NO parallel store, NO new columns on `alerts`. Only new table is `alert_subscriptions` (one row per firm+district+event_type).

- event_type mirrors alerts.alert_type: 'new_settlement' / 'new_doc'. UI labels new_doc "New contract"; API accepts a 'new_contract' alias → normalize to 'new_doc'.
- Idempotency is DB-enforced via PARTIAL UNIQUE INDEXES on `alerts` + ON CONFLICT DO NOTHING:
  - new_settlement → unique on `file_hash` = sha256("settlement:v1:<district>:<unit>:<from>:<to>"). **Why content-keyed, not row id:** stated settlements are delete+reinserted on re-promote so ids aren't stable; file_hash is immutable (admin acknowledge rewrites `notes`, never file_hash).
  - new_doc → unique on `source_doc_id` (partial: WHERE source_doc_id IS NOT NULL; legacy pipeline new_doc rows carry NULL source_doc_id so the index never conflicts with history).
  - **Lockstep:** the partial-index DDL in app.ts runMigrations and the ON CONFLICT targets in lib/alert-detection.ts must match exactly, or inserts 23505/fail.
- Detection PIGGYBACKS existing ingest (NO cron): `recordSettlementAlertsForDoc` in versions.ts settlement-promotion branch (after storeSettlementsForDoc); `recordNewContractAlert` in admin.ts. new_doc must fire ONLY for genuinely-new docs — handleCbaUpload calls it AFTER the 409 duplicate path returns; bulkIngestOneFile only when status==='ingested'. Both fns are best-effort (swallow/log) so an alert failure never breaks ingestion; an EXISTS-subscription gate skips work when no firm subscribes.
- All 4 firm endpoints use requireFirmSession (NEVER gate()/isFree). Subscribe enforces district ∈ firmScopeDistrictIds (roster ∪ matters) → out-of-scope = 404. list + feed RE-FILTER to current scope so a stale subscription (district left roster/matters) stops surfacing. DELETE is firm_id-scoped → cross-firm = 404. Feed JOINs alerts↔alert_subscriptions on (district_id, event_type = alert_type) + current scope.
- Firm routes use direct firmFetch (NOT openapi.yaml) — codegen intentionally skipped (Phase 3/4/5 precedent). Email/SMS notifications are out of scope (in-app feed only).
