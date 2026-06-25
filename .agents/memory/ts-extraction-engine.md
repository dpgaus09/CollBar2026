---
name: TS-native vision extraction engine (api-server)
description: Durable design decisions for the TypeScript Claude-Vision extraction engine in artifacts/api-server/src/extraction that replaces the Python pipeline extractors.
---

A TS-native, Claude-Vision-PRIMARY extraction engine lives in
`artifacts/api-server/src/extraction` (no Python shell-out) and must run in dev
AND autoscale prod. It reads PDFs with mupdf WASM and extracts from rendered page
images, not the raw text layer. The Python pipeline extractors are its parity
target. Below are the decisions that are NOT obvious from the code.

**Cost-bounding triage is mandatory, per domain.**
**Why:** full-doc vision on 100–337 page CBAs is financially/operationally
untenable. Salary data is localized → low-res vision triage finds the appendix.
Provisions data is scattered → a FREE text-layer keyword triage (article keyword
+ a digit, expand ±1 page) is used for digital docs, falling back to low-res
vision triage only for scanned docs, under a hard high-res page cap.
**How to apply:** the triage page set is data-dependent, so it must NOT go in the
cache request hash; cache by file content + the deterministic knobs only.

**Fail-closed is the load-bearing invariant (this bit twice).**
**Why:** every store is a per-target delete-then-insert (incl. ZERO rows, so
stale/leaked data clears). A truncated (hit max_tokens) or unparseable model
response that degrades into an *empty* result is indistinguishable from a genuine
"nothing here" — and a live store then wipes existing rows and replaces them with
nothing. This must never happen.
**How to apply:** classify every model response as success | truncated |
parse_error. Only success is `ok` (storeable/cacheable). The orchestrators must
gate the store on `ok` BEFORE any delete. Critically, EVERY path that yields the
final item set must be fail-closed — not just the main extract batch, but also
the scanned-doc vision *triage* step (a truncated/unparseable triage that returns
"no candidate pages" silently wipes the doc). A genuine valid-empty result
(`success` + 0 items) MAY legitimately replace, matching Python.

**Option B numeric verify is unit-aware and cautious.**
**Why:** vision is authoritative; the text layer is a corroboration source, not a
correction source. For provisions, only `$` and `%` values are checked —
days/hours/small counts collide with article numbers / years / step counts and
over-flag.
**How to apply:** verify NEVER overwrites a value; on mismatch it only lowers
confidence (routing to the human-review queue) and, where a column exists, adds a
review reason. A missing page_ref also caps confidence so the row routes to
review.

**Multi-unit attribution never guesses.**
**Why:** `contract_provisions` carries only contract_id (no bargaining_unit).
Mis-assigning a unit's provisions to another unit is worse than dropping them.
**How to apply:** single DB contract on the doc → attach all provisions; multiple
→ exact-match canonical bargaining_unit only, leave unmatched as "unattributed"
(counted, never guessed). Batches that miss the title page often emit a null
unit, so some multi-unit docs lose rows to unattributed — accepted as fail-safe.

**Live store wipes human-verified rows.**
**Why:** delete-then-insert replaces ALL of a contract's rows for the domain.
**How to apply:** until a re-run/merge UX exists, validate with dryRun and do not
run a live store over prod data during dev. A no-paid-run parity harness
(`validation/parity.ts`) encodes the hard gates — fail-closed-on-non-success, no
teacher-grid-on-non-teacher-unit leak, salary cells exact-or-flagged vs baseline —
so they can be checked over fixtures or stored rows without model calls.

**settlement and final_offer domains differ from the vision domains.**
**Why:** settlement is DERIVED from a doc's already-extracted compensation
provisions (no PDF, no model) — only the 'stated' method is per-doc; 'ba_min_delta'
and 'tss_diff' are cross-document and stay in the Python pipeline. final_offer is
one party's filing on an ELRB posting, so it is meaningless without a posting+side.
**How to apply:** branch settlement BEFORE resolving PDF bytes (model=null,
modelVersion="derive"). For final_offer, resolve findPostingSide first and
fail-closed if the doc maps to no posting (never store orphan items). Both still
flow through the same version/diff/promote path as salary/provisions.

**Job queue dedupes by source_doc_id across ALL domains.**
**Why:** the partial-unique index allows only one active job per doc regardless of
domain. **How to apply:** to (re-)run several domains on the same doc, enqueue them
one at a time (admin enqueue returns deduped:true if one is already active).
