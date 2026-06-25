---
name: Salary hourly/annual mixed tables + per-lane sanity
description: How support-staff wage schedules with mixed hourly+annual columns are classified, formatted, and magnitude-checked per column.
---

Support-staff wage appendices routinely pair an hourly-rate column with an annual-salary column in ONE table (e.g. custodial "STARTING WAGES": Hourly $20.43 | Salary $42,500). The salary domain must judge each column by its OWN unit, never on the schedule's mixed aggregate.

Rules (server `salary.ts` + `salary-grid.ts`, mirrored in web `district.tsx`):
- A lane is hourly via `isHourlyLane` (hourly/hour/per hour//hr/hr/rate) and annual via `isAnnualLane` (salary/annual/year(ly)/per year//yr).
- A column is treated as HOURLY only when `isHourlyLane && !isAnnualLane`. A header that reads as BOTH (e.g. "Annual Rate") is treated as ANNUAL, so an annual column is never rendered "/hr" nor judged on rate bounds.
- `scheduleType="hourly"` ONLY when NO lane is annual; if any lane is annual the table becomes `lane_grid` (per-column unit). A single pure-hourly column defaults its lane label to "Hourly Rate".
- `applySanity` is PER-LANE: the hourly window (FLOOR 5 / CEILING 200) applies only to hourly-only lanes; annual support salaries are left UNBOUNDED (job families vary too widely to bound safely); education grids keep the EDU floor/ceiling via `isEducationSchedule`.
- Money parsing preserves cents (`toMoney`, numeric(12,2)) — an hourly 22.50 must not round to whole dollars.

**Why:** Prod Palatine CCSD 15 custodial/transportation salary came back EMPTY or falsely flagged `rate_above_ceiling` because an aggregate hourly-ceiling check saw the $42,500 annual column. Per-lane scoping fixes both the drop and the false flag.

**How to apply:** When touching salary classification/formatting/sanity, keep the hourly-vs-annual decision per-column and keep `salary.ts` and `district.tsx` in lockstep. Bump `SALARY_PROMPT_VERSION` when the prompt or normalization changes (cache is keyed on it). Bare `rate` can still mis-tag oddities like "Daily Rate" as hourly — only a review flag, never a dropped cell; narrow it only if prod shows false flags.
