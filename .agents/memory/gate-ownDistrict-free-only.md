---
name: gate ownDistrict only scopes free users
description: Why district-scoped write endpoints must re-check ownership beyond gate({ownDistrict})
---

`gate({ ownDistrict: true })` in `artifacts/api-server/src/lib/access.ts` only
applies the own-district check inside the `if (isFree(access))` branch. Admins
**and Pro customers** pass straight through with NO district check.

**Why:** Pro is treated as "unrestricted reads" for the benchmark/comparables
surface, so the gate intentionally skips them. But a Pro district_user belongs to
exactly one district — for any endpoint that *writes* or mutates a specific
district's data (e.g. settlement self-verification), relying on the gate alone is
an IDOR: a Pro user from district A could act on district B.

**How to apply:** For district-scoped write endpoints, use `gate()` for auth only,
then re-check ownership in the handler for non-admins:
`if (access.role !== "admin" && access.districtId !== districtId) → 403`. Admins
may act cross-district (record as an 'internal' action). Also verify the target
row actually belongs to the path's district before mutating.
