---
name: Salary extraction cross-unit PDF leak (pilot finding)
description: Why blind salary-grid backfill leaks teacher grids onto non-teacher units, plus the magnitude/recall gaps found in the first pilot batch.
---

# Salary extraction cross-unit PDF leak

Found while running the first pilot batch of `18_extract_salary_schedules.py`
(10 IL contracts) before the corpus backfill.

## Cross-unit leak (critical)
- Many districts have SEVERAL `contracts` rows — one per bargaining unit
  (teachers, support_staff, secretarial_clerical…) — that all reference the
  SAME `source_doc_id` (one CBA PDF, usually the teachers' agreement).
- `18_extract_salary_schedules` parses that one PDF and stores the resulting
  grid under EVERY such contract, stamped with that contract's unit. So the
  teachers' BS/MS lane grid gets written under support_staff / secretarial_clerical.
- Net effect: a non-teacher unit displays an education (BA/MA/BS/MS) lane grid —
  the exact thing the feature must never do. The frontend `laneKind` guard can't
  catch it because those leaked rows are genuinely classified `education`.
- The script's stated invariant ("bargaining_unit comes from the contract row")
  is UNSAFE when one PDF backs multiple unit-rows.
- **Fix direction:** one PDF → one unit's schedules. When multiple target
  contracts share a `source_doc_id`, parse once and attribute only to the unit
  the appendix actually represents (education lanes ⇒ teachers); do not replicate
  onto the other units.

## Magnitude sanity gap
- Anna Jonesboro parsed a differential/stipend-looking table as the base grid:
  values $31–$9,963 with BS/MS lanes, NOT flagged. There is no plausibility
  check on salary magnitude. Add one (flag/withhold grids whose max is outside a
  sane base-salary range) and route to review instead of displaying.

## Recall gap (not scanned)
- ~40% of pilot contracts (Adlai Stevenson, Canton, Dallas) produced 0 schedules
  despite having a readable text layer (not scanned — the script stores a
  scanned placeholder when `is_scanned`, and these stored nothing). The parser
  did not recognize their schedule format. Improve recall before scaling.

## Other noise
- Aurora East captured step names ("STEP AA, A, B…") as lane labels and emitted
  overlapping year ranges (2026-2030 alongside per-year). Caught by the
  `lane_label_mismatch` review flag, but the flag rate was high (15 of 24).

**Bottom line:** do NOT run the ~367-contract IL backfill until cross-unit
attribution + magnitude sanity (and ideally recall) are fixed; then re-pilot.
