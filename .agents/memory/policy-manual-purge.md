---
name: Board-policy manuals stored as CBAs
description: Why/how non-CBA board-policy (IASB PRESS) manuals get into the cba_pdf corpus and the durable rules for removing them.
---

# Board-policy manuals mislabeled as `cba_pdf`

Pre-fix crawls stored IASB PRESS board-policy manuals (and other non-contracts:
handbooks, bus-route schedules) as `doc_type='cba_pdf'`. They share contract
vocabulary, so they pass naive keyword gates and pollute LLM extraction, the
dashboard, and comparables.

**Detection is text-layer based.** The content classifier flags a `policy_manual`
from PRESS phrasing + PRESS section numbers (e.g. `2:105`) found in the embedded
text. Real CBAs almost never carry that signal, so precision is high.

**Do NOT OCR the whole corpus to find scanned ones.**
**Why:** one scanned PRESS manual can run hundreds of pages and take minutes to
OCR; doing the ~100 image-only rows is intractable in-session.
**How to apply:** catch scanned/`needs-OCR` policy manuals from a *tight*
source_url filename pattern (board policy / PRESS only — never bare
"handbook"/"manual"); leave the rest of the scanned set to a dedicated bounded
OCR pass.

**Prefer re-label over delete.** Re-label `doc_type` to `'policy_manual'` (a value
added to the source_documents doc_type CHECK) instead of deleting.
**Why:** reversible and keeps provenance; the new value is excluded from every
`WHERE doc_type='cba_pdf'` query, so it stops feeding extraction automatically.

**Also clean what the manual already produced, in FK order.** Re-labelling only
stops *future* feeds. The doc may already have spawned `contracts`
(+`contract_provisions`), `extraction_runs`, and `settlements`. `settlements`
reference BOTH the source doc and the contract, so delete settlements *before*
contracts (FKs have no cascade) or the transaction aborts. Skipping this leaves
bogus rows in benchmarks and the failures list.

**Constraint is applied via raw SQL, not push.** This repo's schema apply
(drizzle-kit push) wants to TRUNCATE populated tables, so additive CHECK changes
go through an idempotent `DROP/ADD CONSTRAINT`. The constraint + relabel are
dev-only; prod needs the same when re-published.
