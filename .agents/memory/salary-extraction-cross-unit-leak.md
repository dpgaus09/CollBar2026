---
name: Salary extraction cross-unit PDF leak (RESOLVED)
description: Why one CBA PDF backing several unit-rows leaked teacher grids onto non-teacher units, and the three guards (route, magnitude, dedupe) that fixed it. Recall gap remains open.
---

# Salary extraction cross-unit PDF leak — RESOLVED

First seen in the `18_extract_salary_schedules.py` pilot, fixed before the full IL
backfill. The full IL backfill since runs clean — the key invariant (no education
lane grid on any non-teacher unit) holds across the corpus.

## The trap (why the naive design was unsafe)
- Many districts have SEVERAL `contracts` rows — one per bargaining unit
  (teachers, support_staff, secretarial_clerical…) — all pointing at the SAME
  `source_doc_id` (one CBA PDF, usually the teachers' agreement).
- The naive extractor parsed that one PDF and stored the grid under EVERY such
  contract, stamped with that contract's unit → a teachers' BA/MA lane grid got
  written under support_staff/secretarial. The frontend `laneKind` guard cannot
  catch it because those leaked rows are genuinely classified `education`.
- **Lesson:** "bargaining_unit comes from the contract row" is UNSAFE when one
  PDF backs multiple unit-rows. Attribute by what the schedule *is*, not by which
  contract row happens to reference the PDF.

## Three guards that fixed it (all in lib_salary_grid.py / 18_extract…py)
1. **Route, don't replicate.** Group target contracts by `source_doc_id`, parse
   once, and `route_schedules` each parsed grid to ONE unit: education grids ⇒
   teachers (or `unattributed`, NEVER a non-teacher unit); specific non-teacher
   keyword ⇒ that unit; ambiguous ⇒ the PDF primary (teachers). One PDF → one
   unit per grid.
2. **Magnitude sanity.** `EDU_SALARY_FLOOR=15000 / CEILING=300000`; grids whose
   base magnitude falls outside are flagged `implausible_salary_magnitude` and
   the dashboard route EXCLUDES those rows (stipend/differential tables were
   being read as base grids, e.g. Anna Jonesboro $31–$9,963).
3. **Dedupe before insert.** Two parsed schedules can collapse to the same DB
   unique key `(schedule_name, school_year)`; the delete-then-insert is ONE
   transaction, so a dup aborts the WHOLE contract → it rolls back to empty
   (silent `store_error`). `store_schedules` runs a dedupe pre-pass keeping the
   richest row (cells, then confidence, then step_count) per key. **Why:** a
   single noisy PDF must not zero out an entire district's schedules. Missing-year
   rows are keyed by the same `unknown-p{page_start}` synthesis the insert uses.
   Residual caveat: complementary split-page rows are dropped, not merged
   (recall-only; merge-by-cell is a future option if audits show lost cells).

## Still open: recall
- Only ~half of IL contracts yield any schedule. Some are scanned (placeholder),
  some have a readable text layer the parser doesn't recognize. Architect signed
  off with this as the one remaining caveat — improve recall before relying on
  corpus-wide coverage, but it does NOT affect correctness of what IS extracted.
