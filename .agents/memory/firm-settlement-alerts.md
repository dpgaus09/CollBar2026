---
name: Firm settlement alerts (Phase 6)
description: How tracked-district alert subscriptions reuse the global alerts table — idempotency machine-key, firm-scoped visibility, detection hook placement, and the cleanup gotcha.
---

# Firm settlement alerts on tracked districts

Firm members subscribe a district to an event type and get a feed when an on-demand
data refresh ingests a matching settlement/contract. The feature reuses the **global,
shared `alerts` table** — there is NO parallel alert store and NO new columns on `alerts`
(only two partial unique indexes were added).

## Idempotency machine-key lives in `alerts.file_hash`
**Rule:** the dedup key for alerts MUST go in `alerts.file_hash` (char(64), immutable),
never `alerts.notes`.
**Why:** admin "acknowledge" overwrites `notes`, so a key stored there would not survive
and a re-ingest would write a duplicate alert.
**How to apply:**
- `new_settlement`: `file_hash = sha256("settlement:v1:<districtId>:<unit>:<fromYear>:<toYear>")`;
  `doc_name` is the human-readable label. Deduped by a partial unique index on
  `file_hash WHERE alert_type='new_settlement'`.
- `new_doc`: deduped on `source_doc_id` (partial unique index `WHERE alert_type='new_doc'
  AND source_doc_id IS NOT NULL`). Legacy pipeline `new_doc` rows have NULL source_doc_id,
  so the partial index never collides with them.
- All inserts use `ON CONFLICT DO NOTHING`, making repeated/concurrent refreshes safe → exactly one row.

## Visibility is by *current* subscription, not detected_at
The feed is `alerts a JOIN alert_subscriptions s ON s.district_id=a.district_id AND
s.event_type=a.alert_type`, filtered to the caller's firm + current `firmScopeDistrictIds`.
Because `alerts` rows are global, **a firm that subscribes late will see historical alerts**
that fired for that district/event before it subscribed. This is the deliberate locked
design (architect-confirmed acceptable). If future-only semantics are ever required, add
`a.detected_at >= s.created_at` to the feed join.

## Detection hook placement (NO new cron)
Detection piggybacks existing on-demand refresh paths via best-effort `try/catch`
(alert failure must never roll back ingestion; idempotency makes a later retry harmless):
- settlement promotion path (after settlements are stored),
- genuine new `cba_pdf` creation (admin CBA upload new-doc path + bulk-ingest).
The EXISTS-subscription gate keys off ANY subscription for that district+event regardless
of firm, then the firm-scoped feed/list controls who actually sees the row.

## Cleanup gotcha (tests + any district deletion)
`alert_subscriptions` cascades on BOTH `firm_id` and `district_id` delete. But the global
`alerts` table has **no cascade from districts** — delete `alerts WHERE district_id IN (...)`
BEFORE deleting the districts they reference, or the district delete errors on the FK.
