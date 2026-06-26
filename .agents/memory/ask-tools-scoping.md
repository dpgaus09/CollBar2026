---
name: Ask assistant tool catalog scoping
description: Rules for adding a new retrieval tool to the in-app AI assistant (/api/dashboard/ask) without leaking across state or bargaining unit.
---

# Ask assistant (/dashboard/ask) tool catalog

The assistant has a fixed catalog of retrieval tools (defs + executors + dispatch in `ask-tools.ts`,
system prompt in `routes/ask.ts`, client result-card types in web `ask.tsx`). The route is
`gate({ paid: true })`, and every tool returns rows across ALL in-state districts (not just the
caller's own district) — that is by design for a paid comparables product.

## Rule: every SQL query in a tool must be independently scoped — do not rely on an upstream phase
**Why:** these tools are the highest-leverage cross-customer surface; a single unscoped query leaks
Ohio/other-state data (CUSTOMER_STATE is IL) or another bargaining unit's salaries. A multi-phase
executor (Phase 1 = find districts + latest contract, Phase 2 = fetch schedules/cells by contract id)
must NOT assume Phase 1's filtering protects Phase 2.

**How to apply:** in EVERY query of a new tool, re-join `districts` and re-assert `d.state = CUSTOMER_STATE`,
and if the data is unit-specific also re-assert `c.bargaining_unit = ${unit}` (defense-in-depth, even
when an earlier phase already filtered on both). Mirror the dashboard endpoint's domain filters too —
e.g. salary excludes `review_reason NOT LIKE '%implausible_salary_magnitude%'`. The test suite enforces
this: `ask-tools.test.ts` runs every registered tool with empty input and asserts each captured query
is anchored to IL; add the analogous unit-predicate assertion for unit-specific tools.

## Other conventions
- Parameterize all user input via Drizzle `sql` (no string interpolation); clamp `limit` and any text.
- Some ISBE baseline tables have NO `state` column (il_eis_district, il_eis_position_summary); anchor them
  by JOINing `districts d ON d.state_district_id` and asserting `d.state = CUSTOMER_STATE` in every query
  (incl. optional secondary queries and each phase of compare_to_peers). tss_annual DOES have `state` — assert both.
- A tool that needs a dynamic column (e.g. compare metric) must resolve it from a server-side WHITELIST
  registry and pass only that to `sql.raw`; never let user text reach `sql.raw`. Also store/return the
  RESOLVED key, not the raw user text, so a fallback never advertises an unsupported metric.
- Deep links use the SPA's URL state: district overview is `/dashboard/:id`, plus `?unit=<unit>` only
  for non-teacher units (teachers is the default and takes no param) — matches `useDistrictUnit()`.
- Keep the model payload compact (summaries + a small cap of matched cells), since the ask route also
  truncates serialized tool output.
