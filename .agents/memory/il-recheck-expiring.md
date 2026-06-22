---
name: IL CBA re-check of expiring contracts
description: How/why the crawler re-fetches saved CBA URLs only for expiring districts, plus two durable constraints it relies on (atomic crawl-state writes; current-contract partitioning).
---

# Re-check expiring contracts (`11_crawl_il_cbas.py --recheck-expiring`)

Efficient renewal policy (chosen by product): instead of re-discovering or
re-crawling every district, only districts whose **current** contract has expired
or expires within a near-term window are re-checked, and we re-download the exact
**already-saved source URL** (not full discovery). The same-file case is dropped by
per-district file-hash dedup in `_store_candidate` (no churn); a changed file is
stored as a new `source_document` and the normal extraction step ingests it as a
new contract version. Districts well within term, with NULL `effective_end`, or
with no saved `source_url` are skipped. Outcomes are logged + written to the crawl
state JSON (`per_district[rcdts].recheck` + an `il_recheck` summary).

## Durable constraint 1 — crawl-state JSON must be written atomically
`_save_crawl_state` must write via temp file + `os.replace` (atomic on POSIX), not
a plain `open("w")`.
**Why:** the normal crawl workflow and `--recheck-expiring` can run concurrently
and both write `pipeline/state/il_cba_crawl.json`. A plain write can interleave /
truncate; `_load_crawl_state` swallows JSON errors and returns a *fresh empty*
state, which silently wipes ALL per-district crawl progress. Atomic replace means
a reader always sees a complete file (worst case last-writer-wins, self-heals next
run). Still avoid running recheck concurrently with a heavy crawl if you care about
not losing a few status updates in the overlap window.
**How to apply:** any new writer of this state file uses the same temp+replace.

## Durable constraint 2 — "current contract" partitions by (district, unit, unit_scope)
When selecting the latest/current contract per district (expiry checks, re-check,
benchmarks, cost-impact), partition by **(district_id, bargaining_unit,
unit_scope)** — the contracts uniqueness key — ordered by `effective_start DESC
NULLS LAST, id DESC`.
**Why:** ~20/275 IL (district, unit) groups bargain the same unit across multiple
scopes. Partitioning by (district, unit) only collapses those and under-counts
(116 → 106 current contracts in the expiring set); each distinct scope is a real
separate contract with its own source URL.
**How to apply:** include `unit_scope` in any "row_number per district unit" CTE.
