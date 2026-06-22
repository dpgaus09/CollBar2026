---
name: Review queue scope + audit sampling disabled
description: Why is_audit_sample never gates the admin review queue and why audit sampling is turned off
---

The admin Review Queue (artifacts/api-server/src/routes/admin.ts) lists and counts ONLY
`contract_provisions.confidence < 0.8 AND NOT human_verified` (optionally filtered by a
validated category). It does NOT include `is_audit_sample` anymore — that predicate and the
`is_audit_sample DESC` ordering were removed from both SELECT blocks and both COUNT queries.

**Audit sampling is disabled.** pipeline/06_extract_contracts.py sets AUDIT_SAMPLE_RATE = 0.0
and mark_audit_samples() computes `n_sample = ceil(len * rate)` then `if n_sample <= 0: return 0`.
The old `max(1, ceil(...))` forced >= 1 sample even at rate 0, so rate alone could not disable it.
High-confidence extractions (>= 0.8) are now trusted automatically and never flagged for review.

**Why:** spot-check audit samples were the ONLY high-confidence rows reaching the queue; the user
wanted high-confidence items auto-trusted and kept out of manual review going forward.

**is_audit_sample is now historical-only.** Rows still flagged `is_audit_sample=true` are PAST
human-reviewed audits (`human_verified=true` with an `audit_verdict`). The one-time cleanup cleared
only UNREVIEWED audit samples (set human_verified=true, is_audit_sample=false, audit_verdict=NULL)
and deliberately left already-reviewed audits intact, so extraction-report audit metrics keep
showing real history instead of fake bulk approvals.

**How to apply:** do NOT re-add `OR is_audit_sample` to the queue query. To re-enable sampling,
set AUDIT_SAMPLE_RATE > 0 — but the queue still won't surface samples unless the query is also
changed back. The frontend "Audit Quality Sampling" card now shows historical counts only.

**Any bulk/queue mutation must keep two invariants in lockstep:** (1) reuse the *exact* queue
scope guard `confidence < 0.8 AND NOT human_verified` (never widen it — that's the only thing
keeping verified/high-confidence rows safe), and (2) preserve audit samples by UPDATE
(`human_verified=true, audit_verdict='disagree'`), never DELETE them — deleting an audit row
destroys real review history. POST /admin/review-queue/bulk-dismiss does both inside one
db.transaction so a mixed audit/non-audit dismissal can't partially apply.
**Why:** the bulk-dismiss feature could otherwise silently erase audit history or touch trusted
high-confidence rows if a future bulk op forgot either guard.
