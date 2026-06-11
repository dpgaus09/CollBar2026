---
name: CollBar DB actual column names (key tables)
description: Authoritative column names for districts and benchmarks — the Drizzle schema is the source of truth, not column names assumed from business logic.
---

# CollBar actual column names (key tables)

**districts:** `id`, `state`, `state_district_id` (NOT `irn`), `name`, `county`, `district_type`, `enrollment`, `valuation`, `avg_teacher_salary`, `website_url`, `updated_at`. Unique constraint: `(state, state_district_id)`.

**benchmarks:** `id`, `district_id`, `doc_year`, `source_url`, `raw_text`, `effective_date`, `expiry_date`, `wage_schedule` (jsonb), `parsed_at`. No `metric_key` / `metric_value` columns.

**Why:** These differ from what might be inferred from business context (e.g. "IRN" is a common Ohio district identifier term, but the column is `state_district_id`). Pipeline tests and e2e fixture must use the actual column names.

**How to apply:** Run `psql $DATABASE_URL -c "\d <table>"` to verify before writing SQL in tests or scripts.
