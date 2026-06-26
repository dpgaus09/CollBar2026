---
name: TSS field display semantics
description: Non-obvious value encodings in tss_annual when surfacing ISBE Teacher Salary Study fields in UI/AI
---

When surfacing `tss_annual` (ISBE Teacher Salary Study) fields to humans, the
stored values are NOT all display-ready:

- **Percent columns are 0–100, not 0–1.** `trs_board_paid_pct`, every
  `*_pct_employer_*` insurance share, etc. e.g. `9.900` means 9.9%, `90.00`
  means 90%. Append `%` directly; do not multiply by 100.

- **Yes/blank boolean-ish text flags.** `trs_included_in_salary` ("Yes"/"No"/""),
  `sick_leave_bank` ("Yes"/""), `severance_pay` ("Yes"/""),
  `early_retirement_program` ("Yes"/""). Blank/"" is the dominant value and means
  the district did NOT report the provision — do **not** render blank as "No"
  (you'd be asserting a fact the state never reported). Render blank as "—".

- **`fair_share_provision` and `longevity_pay_provided` store opaque numeric
  codes "1"/"2" (no codebook in the repo).** Do NOT render the raw code to users —
  it's meaningless and the 1↔Yes / 2↔No mapping is unverified. Surface longevity
  via its dollar columns instead (`longevity_ba_max`/`ma_max`/`ma30_max`/`hss_max`).

- **`$0` premiums are ambiguous** (genuine $0 vs not-reported). When deciding
  whether an insurance coverage type has data, treat a coverage as "present" only
  if at least one of its 4 fields is `> 0`; otherwise hide the row rather than
  showing a wall of "$0 / 0%".

- **`school_year` is varchar "YYYY-YYYY"**, so lexical `MAX`/`ORDER BY DESC`
  correctly yields the latest snapshot.

**Why:** these encodings caused the baseline district-profile sections to risk
showing "longevity: 2", "severance: No" (false), or unscaled percentages.
**How to apply:** any UI/AI/report that reads tss_annual fields directly.
