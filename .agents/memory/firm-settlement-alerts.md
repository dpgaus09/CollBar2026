---
name: Firm tracked-district alerts
description: Durable invariants for how firm-workspace settlement/contract alerts dedup, scope, and trigger
---
Firm-workspace alerts (a firm subscribes a tracked district to a "new settlement" / "new contract" event and sees triggered alerts in-app) reuse the shared GLOBAL `alerts` table. Hard constraints, none obvious from a quick code read:

- NO parallel alert store and NO new columns on `alerts` (it is dual-declared but intentionally NOT in runMigrations — adding columns risks schema drift). The only new table is the per-(firm, district, event_type) subscription table, which IS created in runMigrations.
- NO cron. Detection piggybacks the existing on-demand ingest paths (settlement promotion + CBA upload/bulk-import). **Why:** a separate scheduler was explicitly out of scope; an alert must be a side effect of ingest, not a poller.
- Idempotency is DB-enforced (partial unique indexes + ON CONFLICT DO NOTHING), keyed on CONTENT, never on a row id:
  - new-settlement key lives in `alerts.file_hash` as a sha256 over (district, unit, from-year, to-year). **Why file_hash and not the settlement row id:** stated settlements are delete+reinserted on re-promote so their ids aren't stable; `file_hash` is immutable, whereas the admin "acknowledge" action rewrites a notes field — so notes is UNSAFE as a key.
  - new-contract dedups on the source document id. Legacy/pipeline alert rows carry a NULL source-doc id, so a partial index (WHERE source_doc_id IS NOT NULL) never collides with that history.
  - **Lockstep:** the migration's partial-index definitions and the detection inserts' ON CONFLICT targets must always match, or inserts fail at runtime.
- A new-contract alert must fire ONLY for a genuinely new document — after the content-dedup / duplicate path has been ruled out. Re-ingesting the same PDF must NOT create a second alert.
- Detection is best-effort: it swallows/logs its own errors so an alert failure can never break ingestion, and it is gated on an EXISTS check against subscriptions so it does no work when no firm subscribes.
- All alert endpoints use the firm-session guard, NEVER the plan/entitlement gate(). Subscribe enforces the district is in the firm's CURRENT scope (roster ∪ matters) → out-of-scope = 404; cross-firm delete = 404. list + feed RE-FILTER to current scope so a stale subscription (district later removed from roster/matters) stops surfacing.
- Out-of-scope extensions the team already CANCELLED (don't re-propose): email/SMS notification, alerts on the dev→prod promotion bundle path, and a user-facing "acknowledge / clear seen" action.
