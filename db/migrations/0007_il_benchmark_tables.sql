-- Migration 0007: IL benchmark data tables
-- Creates three tables populated by pipeline loaders:
--   load_il_classsize.py  → il_district_fte
--   load_il_eis.py        → il_eis_district
--   load_il_tss.py        → tss_annual

-- ── 1. il_district_fte ───────────────────────────────────────────────────────
-- ISBE Class Size Report: teacher FTE and pupil-teacher ratios per district/year.
CREATE TABLE IF NOT EXISTS il_district_fte (
  id                bigserial PRIMARY KEY,
  state_district_id text        NOT NULL,
  school_year       varchar(7)  NOT NULL,
  teacher_fte       numeric(10, 2),
  ptr_elementary    numeric(6, 2),
  ptr_highschool    numeric(6, 2),
  loaded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT il_district_fte_uq UNIQUE (state_district_id, school_year)
);
CREATE INDEX IF NOT EXISTS il_district_fte_sdid_idx
  ON il_district_fte (state_district_id, school_year);

-- ── 2. il_eis_district ───────────────────────────────────────────────────────
-- ISBE EIS / ATSB salary report: district-level teacher salary aggregates.
-- No individual names are stored — privacy safe.
CREATE TABLE IF NOT EXISTS il_eis_district (
  id                         bigserial PRIMARY KEY,
  state_district_id          text        NOT NULL,
  school_year                varchar(7)  NOT NULL,
  teacher_headcount          integer,
  teacher_fte                numeric(10, 2),
  avg_teacher_salary         numeric(10, 2),
  median_teacher_salary      numeric(10, 2),
  p25_salary                 numeric(10, 2),
  p75_salary                 numeric(10, 2),
  total_teacher_base_payroll numeric(16, 2),
  avg_sick_days              numeric(6, 2),
  all_staff_headcount        integer,
  all_staff_fte              numeric(10, 2),
  loaded_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT il_eis_district_uq UNIQUE (state_district_id, school_year)
);
CREATE INDEX IF NOT EXISTS il_eis_district_sdid_idx
  ON il_eis_district (state_district_id, school_year);

-- ── 3. tss_annual ────────────────────────────────────────────────────────────
-- ISBE Teacher Salary Study: salary schedule data per district/year.
CREATE TABLE IF NOT EXISTS tss_annual (
  id                       bigserial PRIMARY KEY,
  state                    char(2)     NOT NULL DEFAULT 'IL',
  state_district_id        text        NOT NULL,
  school_year              varchar(7)  NOT NULL,
  district_name            text,
  enrollment_range         text,
  affiliation              text,
  ba_begin                 numeric(10, 2),
  ba_max                   numeric(10, 2),
  ba_years_to_max          integer,
  ma_begin                 numeric(10, 2),
  ma_max                   numeric(10, 2),
  ma_years_to_max          integer,
  highest_scheduled_salary numeric(10, 2),
  trs_board_paid_pct       numeric(6, 3),
  contract_expires         date,
  personal_days            numeric(6, 2),
  sick_days                numeric(6, 2),
  payload                  jsonb,
  loaded_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tss_annual_uq UNIQUE (state, state_district_id, school_year)
);
CREATE INDEX IF NOT EXISTS tss_annual_sdid_idx
  ON tss_annual (state, state_district_id, school_year);
