---
name: Bargaining-unit scoping invariants
description: Rules that keep CollBar settlement benchmarks from mixing bargaining units; read before touching any settlement aggregation, provenance join, or unit param.
---

# Multi-bargaining-unit invariants (CollBar)

CSBOs/superintendents bargain separately with each unit, so a benchmark that
mixes (e.g.) teacher % with custodian % is meaningless. Canonical units:
`teachers, paraprofessionals, custodial_maintenance, transportation,
secretarial_clerical, food_service, nurses, administrators, support_staff, other`.

## Rule 1 — every settlement aggregation is single-unit, defaulting to teachers
Any query that medians/averages/compares settlements (dashboard medians,
comparables, peer-set PDF export) MUST filter `s.bargaining_unit = <unit>` and
default the unit to `teachers` when no param is given.
**Why:** backward compat (legacy callers expect teacher numbers) + no cross-unit
mixing. **How to apply:** if you add a new settlement rollup, scope it by a
single unit; never `GROUP BY` across units into one benchmark number.

## Rule 1b — provision benchmarks AND the whole customer Overview are single-unit
The no-mixing rule covers `contract_provisions` aggregations too, not just
settlements. The customer Overview is fully unit-scoped: `/dashboard/districts/:id`
(currentContract), `/districts/:id/provisions`, `/districts/:id/settlements`, and
`/dashboard/provision-medians` ALL take `?bargainingUnit=` via `parseUnit`
(default teachers) and filter `c.bargaining_unit = <unit>`. The front-end district
page keys every Overview query by unit and resets the selector to teachers on
district change (synchronous "adjust state during render", not a useEffect, to
avoid a stale-unit fetch). The settlements route's `availableUnits` is the UNION
of settlement + contract units (teachers ordered first) so a CBA-only unit with no
settlements is still selectable.
**Why:** the unit selector must drive the entire Overview — header, provision
cards, AND the "vs median" context inside them; a teacher-vs-custodian mixed
median is meaningless (this was the "frozen cards" bug). **How to apply:** any new
Overview/provision rollup must thread the unit param; never `GROUP BY` across
units into one number. NOTE: the paid `/districts/:id/clauses` route is a separate
feature and was intentionally left unit-agnostic.

## Rule 2 — unit param is whitelisted, never interpolated raw
Resolve the unit through `parseUnit()` (api-server/src/routes/bargaining-units.ts)
before use. Some queries interpolate the unit into `sql.raw(...)`; parseUnit's
enum whitelist is what makes that injection-safe. Accept both `bargainingUnit`
(dashboard convention) and `bargaining_unit` (legacy export) query keys.

## Rule 3 — settlement provenance is unit-scoped, own-doc first
A settlement's source link resolves as `COALESCE(s.source_doc_id, latest
same-unit contract's source_doc_id)`. The contract fallback LATERAL must include
`c2.bargaining_unit = s.bargaining_unit`.
**Why:** bulk teacher tss-diff settlements have NULL source_doc_id and need the
contract fallback; document-derived (stated) settlements carry their own
source_doc_id. Without the unit filter, a non-teacher settlement would display a
teacher contract's PDF — silently wrong provenance.

## Rule 4 — cost-impact / EIS columns are teachers-only
The est_annual_cost_impact and EIS cross-check CASEs are gated on
`s.bargaining_unit = 'teachers'` (they model the TSS teacher salary schedule).
Non-teacher settlements return NULL for these; keep it that way unless a
unit-specific salary model is added.

## Known latent gap — contracts uniqueness
`contracts` still uniques on `(district_id, unit_scope, effective_start)`;
`bargaining_unit` is NOT in the key (only `settlements` got the unit added to its
unique, and `source_documents` got `(district_id, bargaining_unit, file_hash)`).
Low real-world risk because `bargaining_unit` is *derived from* `unit_scope`
(same scope → same unit), but if a future change lets two distinct units share an
identical `unit_scope` + `effective_start`, the extraction upsert would overwrite
one unit's contract. Fixing needs a new migration + new ON CONFLICT target.
