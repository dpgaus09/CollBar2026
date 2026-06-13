---
name: ISBE Class Size Report Loader
description: How to parse ISBE xlsx Class Size Report files into il_district_fte
---

## Rule
When reading District Data with `pd.read_excel(..., header=[3,4])`, pandas fills
empty merged-cell labels in the first header row with "Unnamed: N_level_M" strings
(NOT NaN). Filtering only "nan"/"none" strings is insufficient — must also filter
tokens starting with "unnamed:".

```python
parts = [
    str(p).strip() for p in col
    if str(p).strip()
    and str(p).strip().lower() not in ("nan", "none")
    and not str(p).strip().lower().startswith("unnamed:")
]
```

**Why:** The ISBE District Data sheet has merged cells in row 3 (e.g. "Pupil Teacher Ratio"
spans two columns); unmerged cells produce "Unnamed: N_level_0" from pandas.

**How to apply:** Any future re-reads of ISBE District Data xlsx with multi-row headers.

## RCDTS normalization
- School Data RCDTS = 15 digits (district=first 11, school=last 4).
- District Data RCDT = 11 digits. Both sheets: strip non-digits, if < 11 left-pad to 11, take first 11.
- Valid input: 9–15 digits after stripping; outside that range → None (skip row).

## School year
`f"{int(year)-1}-{str(int(year))[2:]}"` — e.g. 2024 → "2023-24". The xlsx "School Year"
column holds just the end-year integer.

## File structure
- pipeline/data/il_classsize/ — one xlsx per school year (2021–2024 loaded)
- Table: il_district_fte (state_district_id TEXT, school_year VARCHAR(7), teacher_fte, ptr_elementary, ptr_highschool)
- UNIQUE constraint on (state_district_id, school_year); re-runs upsert safely
