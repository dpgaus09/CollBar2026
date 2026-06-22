---
name: IL minimum teacher salary ingest
description: How the CGFA statutory minimum full-time teacher salary is ingested/displayed, and the cert-year vs school-year offset.
---

# IL statutory minimum full-time teacher salary (CGFA, PA 103-515)

CGFA certifies & publishes the statewide minimum full-time teacher salary each year
(by ~July 20). CollBar ingests it and shows it as a statewide reference figure.

## Year-offset semantics (the non-obvious part)
- The certification PDF filename embeds the **certification calendar year**, e.g.
  `Teacher%20Salary%20Certification%202025.pdf`.
- That 2025 letter (dated ~July 2025) certifies the rate **effective for the
  2026-2027 school year**. So filename year `N` → effective school year `(N+1)-(N+2)`.
- The row is keyed by the *effective* school year (e.g. `2026-2027`), not the cert year.
- **Why:** the statute sets the next-year floor based on a prior-year CPI window; do
  not confuse the filename year with the school year when constructing URLs or rows.

## Where it lives
- Table `il_min_teacher_salary` (one row per effective school year, UNIQUE).
  Created idempotently in both the api-server startup migration and the Python script.
- Ingest script: `pipeline/17_sync_il_min_salary.py`
  (`--pdf`/`--url`/`--year` overrides; SHA-256 hash-skip; upsert ON CONFLICT(school_year)).
- Annual cron: July 25 06:00 America/Chicago → `spawnMinSalarySync` (index.ts / admin.ts).
  Like the other crons it only fires on a Reserved VM deployment.
- Admin trigger: POST `/api/admin/run-min-salary-sync`, status GET `/api/admin/min-salary-status`.
- Customer API: GET `/api/dashboard/min-teacher-salary` (auth required, IL-only).

## How to apply
- To ingest a new year's certification manually: run `17_sync_il_min_salary.py`
  (auto-builds the current-year CGFA URL, falls back to prior year) or use the admin
  "Run now" button. For an out-of-band PDF, use `--pdf <path> --year <cert_year>`.
- isbe.net / cgfa.ilga.gov are unreachable from the sandbox; the auto URL download only
  works on the deployed Reserved VM — backfill via `--pdf` locally.
