---
name: Salary grid display (customer dashboard Compensation)
description: How the extracted salary-schedule grid renders in the customer dashboard and the cross-unit / lane-label traps to avoid.
---

# Salary grid display

The customer dashboard Compensation card swaps to a real extracted salary grid
(steps × lanes) when the selected unit has schedules, else falls back to the
legacy provision-summary DataCard. The grid is keyed by `contract_id` and served
by `GET /api/dashboard/districts/:id/salary-schedules?bargainingUnit=`.

## Cross-unit stale-render trap (must gate on response unit)
- The salary query (like the other dashboard queries) keeps the previous unit's
  response as React Query `placeholderData` while the new unit loads.
- **Never** decide "has grids" from `schedules.length` alone. Gate on
  `salaryData.bargainingUnit === selectedUnit`. The API echoes the resolved unit
  as `bargainingUnit`.
- **Why:** without the guard, switching the page-level unit selector from
  teachers to a non-teacher unit briefly renders the teacher grid — including
  BA/MA lane headers and "MA Base" — on the non-teacher unit, violating the
  hard rule "NEVER show education lanes (BA/MA/MA+30) for non-education units."

## Education-lane chrome is gated by `laneKind`, not by labels
- `laneKind` is `'education' | 'columns' | null`. Education chrome (the "MA Base"
  anchor; treating labels as BA/MA lanes) renders ONLY when
  `laneKind === 'education'`.
- Defense-in-depth: for non-education schedules, a strictly-anchored regex
  neutralizes any stray education token (BA, MA, BA+15, MA+30, Ed.D…) to
  "Col N". The match is whole-label so real job classes ("Maintenance",
  "Engineer") are never neutralized.

## Lane-label fallbacks (real data is messy)
- Build the grid from the cells themselves (step/lane orders), not from
  `stepCount`/`laneCount`, so non-contiguous or text-labelled steps still render.
- Label priority: schedule `laneLabels[i]` → cell `laneLabel` → `"Salary"` only
  when there is a TRUE single lane, else `"Col N"`.
- **Extraction gap (for backfill/extraction work):** some multi-column
  non-teacher grids are stored as `schedule_type='lane_grid'` with a real
  `lane_count` (e.g. 5) but EMPTY `lane_labels` AND empty per-cell `lane_label`
  (observed: Joliet custodial contract 664, 5 lanes, 26 steps). The display can
  only show "Col 1..N" for these — the job-class column headers were not
  captured at extraction time. Improving extraction to capture those headers is
  a separate extraction concern, not a display fix.

## Verification reality
- The customer dashboard is auth-gated and IL-only; the screenshot tool cannot
  carry a session, so the gated grid cannot be screenshotted. Verify via: tsc,
  the api-server salary-schedules endpoint test, and DB checks of real
  `lane_labels`/`laneKind` (teachers 661 = education lanes; custodial 664 =
  columns). Visual sign-off came from the approved mockup (mockup-sandbox
  AppendixGrid), which the live SalaryGrid mirrors.
