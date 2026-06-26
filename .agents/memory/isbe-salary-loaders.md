---
name: ISBE TSS & EIS structured loaders
description: How the ISBE TSS (tss_annual) and EIS (il_eis_*) Python loaders store full salary/benefits data — schema self-migration, idempotency, PII rules, psycopg2 numpy safety.
---

# ISBE TSS & EIS structured loaders

Covers `pipeline/load_il_tss.py` and `pipeline/load_il_eis.py` after the
"capture all ISBE salary & benefits data" work.

## TSS (tss_annual)
- The full 85-col TSS row is always archived in `payload` JSONB; *useful* fields
  are promoted to typed columns via the declarative `EXTENDED_TSS_FIELDS` spec
  (namedtuple TF: key, column, sqltype, header, kind).
- **Resolve by EXACT normalized header** (`_norm_hdr`: collapse whitespace +
  lowercase), NOT fuzzy substring. TSS has many short/truncated/duplicate
  headers that a substring match confuses — exact match is the only safe path.
  All extended headers were verified present in TSS-2026 (newest vintage);
  older files simply leave those typed columns NULL.
- `kind` drives sanitizer + SQL type: money→NUMERIC(12,2) 0..1e6 (0 kept),
  pct→NUMERIC(6,2) 0..100 (whole numbers in the sheet), years→INTEGER 0..60,
  text→trimmed/NULL.
- Self-migrate in `ensure_tss_schema()` (called at top of `load_file`):
  CREATE TABLE IF NOT EXISTS + one ALTER ADD COLUMN IF NOT EXISTS per spec field.
  Insert/upsert SQL (`_TSS_INSERT_SQL`) is built once from the spec; the values
  tuple in `upsert_tss_row` MUST stay in `_TSS_INSERT_COLS` order.
- Idempotent: upsert on `(state, state_district_id, school_year)`.

## EIS (3 tables)
- `il_eis_district` (aggregates) is UNCHANGED — keep its calc/upsert shape.
- `il_eis_educator`: anonymized per-educator rows, salaries stored UNMASKED so
  downstream can recompute stats. `is_teacher` from position contains "teacher".
- `il_eis_position_summary`: per (district × position_description) rollup with
  headcount, FTE-weighted avg + median/p25/p75 salary (positive-FTE & in-range
  only), avg sick/vacation, benefit totals, and a coarse `position_group`
  (teacher/administrator/other via `_classify_position`).
- **Idempotency = DELETE-by-year then execute_values insert** for the two detail
  tables (district still upserts). Re-loading a year replaces, never duplicates.
- Batched `execute_values(page_size=5000)` for ~148k educator rows/year.
- `_ensure_eis_schema()` called once in `main()` BEFORE the file loop (not in
  `_process_file`); CREATE IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS so a
  pre-existing table self-repairs from partial drift.

## PII (hard rule)
Names are NEVER persisted. EIS drops Last/First/Middle Name columns
(`PRIVATE_COLS_RE`) immediately after read, before any processing; only column
*names* are logged, never values.

## psycopg2 + numpy safety (the subtle trap)
psycopg2 cannot adapt numpy scalar types. When building rows from pandas:
- Use `Series.tolist()` (converts numpy int/float/bool → Python natives), then a
  `_n()` guard mapping float NaN → None.
- For per-group sums of optional benefit columns use `sum(min_count=1)` so an
  all-missing group yields NaN→NULL, not a misleading 0.
- Make optional numeric columns float64 (`.astype("float64")`, or `np.nan` when
  the source column is absent) so groupby mean/sum don't choke on object dtype.

## Admin upload drives all of this unchanged
`POST /admin/upload-salary-dataset` spawns `python3 -u <loader> --file <path>
[--school-year]` (TSS needs --school-year). CLI interface was not changed;
because the loaders self-migrate, an uploaded file applies the schema itself —
critical on prod autoscale where there is no separate migration step.
