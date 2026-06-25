---
name: Scanned salary-schedule vision extraction
description: How scanned (image-only) CBA salary grids are extracted with Claude vision, and the non-obvious gating/quality constraints around it.
---

# Scanned salary-schedule vision extraction

The deterministic salary parser (`lib_salary_grid.parse_pdf`, pdfplumber word
boxes) extracts **nothing** from scanned/image-only CBAs — no word boxes — so
those PDFs only ever produced a `scanned_placeholder`. `lib_salary_vision.py`
adds a Claude-vision fallback (render pages → low-res TRIAGE to locate salary
pages → high-res EXTRACT → normalize to the exact `parse_pdf` schedule-dict
shape so routing/storage are unchanged). Hook lives in script 18's
`_parse_pdf_with_fallback`: deterministic → if empty AND `is_scanned` → vision →
else placeholder. The upload path (`extract_for_contract` → `process_doc_group`)
gets vision ON by default; CLI has `--no-vision` / `--vision-max-pages`.

## Non-obvious constraints (the durable part)

- **There is NO human-review queue / verify path for salary schedules.** Unlike
  `contract_provisions` (which has `human_verified` + an admin queue scoped by
  `confidence < 0.8 AND NOT human_verified`), `contract_salary_schedules` has no
  verify endpoint and no `human_verified` column. The ONLY customer-view gate is
  `review_reason LIKE '%implausible_salary_magnitude%'`. **Therefore setting
  `needs_review=true` or a low `confidence` does NOT withhold a salary schedule
  from customers** — it still surfaces. Do not assume the provisions
  review-queue rule applies here. To actually withhold a salary schedule you must
  either tag it with the magnitude `review_reason` or change the dashboard query.
  **Why:** I initially set vision confidence 0.75 believing it would gate behind
  review; it would have surfaced unverified. Vision data now surfaces the same
  way deterministic data does (tagged `extraction_method='claude_vision'`).

- **Vision OCR has a small, NON-DETERMINISTIC per-digit misread rate** (~1 cell
  in 432 on the validation doc; two runs of the same PDF can differ by a digit,
  e.g. 73906 vs 73908). Treat cell values as ~99.8% accurate, not exact. The
  guardrails are magnitude sanity (`_apply_sanity` vs `EDU_SALARY_FLOOR/CEILING`)
  and row-shape validation — not per-cell trust. Validate accuracy per batch
  before surfacing widely.

- **Lane-grid rows must be width `len(lane_labels)`** (the model must emit
  `null` placeholders for blank cells so positional cell→lane mapping holds). If
  a row's value count ≠ lane count, alignment is unreliable and salaries shift
  into the wrong education lane — `_normalize` fails closed and DROPS that
  schedule. Ragged grids (e.g. BA omitted at steps 22–24) are fine **as long as**
  the blanks come back as explicit nulls.

- **Education-label canonicalization is required for leak-safety.** Routing
  (`is_education_schedule` / `classify_schedule_unit`) only recognizes
  `_LANE` abbreviations (BA/BS/MA/MS[+N], PhD, EdD) or "TEACHER" in the name. A
  scanned page may spell lanes out ("Bachelors", "Master's + 30", "M.A."), which
  would evade education detection and let a teacher grid route onto a non-teacher
  unit. `_canon_lane` maps degree words → canonical abbreviations before routing;
  non-degree headers ("Salary", "Grade 1") pass through unchanged.

- **Truncation fails closed.** If the EXTRACT call returns
  `stop_reason == 'max_tokens'`, the JSON is partial → discard everything and
  return `[]` (caller stores a placeholder). Never store half-extracted output.

## Validation reference

Target doc: Rock Island SD 41 teachers (doc 1124 / contract 823), 75-page
scanned PDF, 3 school years (2024–2027), lanes BA/BA+15/MA/MA+15/2MA-2E/
2MA-2E+15, steps 0–24 (ragged: BA/BA+15 omitted at 22–24). Ground truth:
`attached_assets/teacher_salary_schedule_1782351309164.sql` (432 cells).
Stored output matched 431–432/432 (99.8–100%), routed only to teachers (no leak
into the paraprofessionals contract 824).
