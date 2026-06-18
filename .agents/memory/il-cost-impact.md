---
name: IL Cost-Impact Estimate
description: Formula and join rules for est_annual_cost_impact on IL settlements
---

## Formula
`ROUND((base_increase_pct / 100.0) * teacher_fte * ((ba_begin + highest_scheduled_salary) / 2.0), 0)`

## Joins
```sql
LEFT JOIN il_district_fte fte
  ON fte.state_district_id = d.state_district_id AND fte.school_year = s.from_year
LEFT JOIN tss_annual tss
  ON tss.state_district_id = d.state_district_id AND tss.school_year = s.from_year AND tss.state = 'IL'
```

## NULL safety
CASE guards all four conditions: d.state='IL', base_increase_pct NOT NULL,
fte.teacher_fte NOT NULL, tss.ba_begin + tss.highest_scheduled_salary NOT NULL.
Never returns 0 or a guess — NULL means "Not available".

**Why:** The user specified this explicitly; showing 0 or an interpolated guess is
misleading for a public-facing cost estimate.

## Coverage (as of Phase 10 load)
2,072 of 7,246 IL settlements carry a cost-impact estimate (school-year join
must hit both il_district_fte and tss_annual for the same year).

## Loaders (populate the three reference tables)
Run from `pipeline/`: `load_il_tss.py` (~20s), `load_il_classsize.py` (~10s),
`load_il_eis.py` (~150s for 6×13MB xlsx). All upsert via ON CONFLICT — safe to re-run.
**Gotcha:** `load_il_eis.py` exceeds a single 120s tool timeout; it commits per-file,
so re-run it (idempotent) or load a missing year individually via
`python3 -c "import load_il_eis as m; m._process_file(m.IL_EIS_DIR/'2025-ATSB.xlsx')"`.

## Frontend
SettlementTable in district.tsx shows "Est. annual cost impact: $X *" in amber
below each row when est_annual_cost_impact != null; footnote cites ISBE Class
Size Report FTE and ISBE TSS salary data. Only IL districts ever show this.
