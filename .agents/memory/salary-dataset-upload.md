---
name: ISBE salary-dataset admin upload
description: How the EIS/ATSB + TSS spreadsheet upload button works and why TSS needs an explicit school year
---

Admin-panel "Salary Data" tab lets non-technical staff load ISBE annual
spreadsheets (EIS/ATSB salary + TSS Teacher Salary Study) straight into the DB:
pick file → upload → spawn python loader → upsert → poll status.

**Pattern:** deliberately mirrors the min-salary sync (detached `python3` spawn +
in-memory pid + `sync_run_status` row), NOT the heavy CBA-upload model. The user
explicitly rejected AI extraction / versioning / job queue for this — keep it simple.
The loaders gained a single-file mode (`--file`, and TSS also `--school-year`).

**Why TSS needs an explicit school year but EIS doesn't:** EIS rows carry a
`SchoolYearId` column so the year is auto-detected from the data; TSS data has no
year column at all (the built-in `FILE_SCHOOL_YEARS` map keyed it by filename), so
an uploaded TSS file MUST be given the school year (YYYY-YY) or the loader can't
know which year it is. The upload endpoint requires `school_year` for TSS, optional
for EIS.

**Concurrency hazard (fixed):** the upload handler must check the dataset's running
pid BEFORE writing the file to disk / object storage. A retry or double-click during
an active load would otherwise overwrite the very spreadsheet the child process is
still reading. Reject concurrent uploads with 409 before any disk mutation.

**Single-file failure semantics:** in single-file (upload) mode, 0 usable rows is a
hard `sys.exit(1)` so the admin panel shows "failed" instead of a false "success".
Magic-byte check (xlsx=`PK`, xls=`D0CF`) rejects mistaken PDF/CSV before spawning.
