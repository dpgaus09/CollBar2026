---
name: IL CBA re-check of expiring contracts
description: Why the crawler re-fetches saved CBA URLs only for expiring districts, plus two durable constraints it depends on (atomic crawl-state writes; current-contract partitioning by scope).
---

# Re-check expiring contracts (`11_crawl_il_cbas.py --recheck-expiring`)

Efficient renewal policy (product decision): do NOT re-discover or re-crawl every
district. Only districts whose **current** contract has expired or expires within a
near-term window get re-checked, and we re-download the exact **already-saved source
URL** — not full discovery. Same bytes are dropped by per-district file-hash dedup
(no churn); changed bytes are stored as a new source document so the normal
extraction step ingests them as a new contract version. Districts well within term,
with NULL `effective_end`, or with no saved URL are skipped.
**Former blind spot, now addressed:** the saved-URL-only fetch never catches a
successor posted at a NEW URL. Opt-in re-discovery fallback (`--recheck-rediscover`)
fixes this: when the saved URL gives "unchanged"/"failed" AND the contract has
*already* lapsed (strictly before today, not just within the window), it re-runs the
existing `_crawl_district` (+ `_search_fallback` when `--search-fallback` is also
set) and stores any relocated/changed file via the same `_store_candidate` path.
Off by default so the efficient saved-URL-only policy stands. In `--dry-run` the
saved-URL fetch reports outcome "dry_run", so the fallback also fires on that to let
users preview discovery — but discovery itself does real network crawls, so dry-run
still hits district sites (unreachable from the sandbox).

## Durable constraint 1 — the crawl-state JSON must be written atomically
Write via temp file + `os.replace`, never a plain truncating `open("w")`.
**Why:** the normal crawl and the re-check mode can run at the same time and both
write the same state file; the loader swallows JSON errors and returns a *fresh
empty* state, so a torn/partial write silently wipes ALL per-district progress.
Atomic replace guarantees readers see a complete file (worst case last-writer-wins,
self-heals next run).
**How to apply:** any new writer of that state file uses the same temp+replace; and
avoid running the re-check concurrently with a heavy crawl if you can't tolerate
losing a few status updates in the overlap.

## Durable constraint 2 — "current contract" partitions by unit AND scope
When picking the latest/current contract per district (expiry checks, re-check,
benchmarks, cost-impact), partition by **(district, bargaining_unit, unit_scope)** —
the contracts uniqueness key — ordered by most recent effective_start.
**Why:** some districts bargain the same unit across multiple scopes; each scope is
a separate current contract with its own source URL. Partitioning by (district,
unit) alone collapses them and under-counts the expiring set.
**How to apply:** include `unit_scope` in any "latest contract per district unit"
selection, and key any per-district recheck/result map by (unit, scope) too, or one
scope's outcome clobbers another's.

## Surfacing rediscovery to users (district view)
The "rediscovered_new_version" recheck outcome is surfaced on the district detail
page as an "auto-refreshed from a relocated source" badge with the recheck date and
a link to the new URL. Derived purely from the crawl-state JSON — no scraping.
**Why:** the rediscovered file is stored as the *newest* version, so it becomes the
**current** contract for its (unit, scope). That means the new web address is simply
the current contract's `source_url`; the only extra fact needed from crawl-state is
the `checked_at` date and that the outcome was a rediscovery.
**How to apply:** match a contract to its recheck record with key
`${bargaining_unit}::${unit_scope ?? "default"}` (mirror the crawler's
`_record_recheck` key exactly, including the "default" scope fallback). The reader
lives in api-server `lib/crawl-state.ts`; it re-implements `resolvePipelineDir` (same
walk-up logic as routes/admin.ts) because that path resolver is not exported.
