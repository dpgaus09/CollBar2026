---
name: CollBar customer-view state scoping
description: How the customer-facing dashboard is restricted to one state (IL) without deleting OH data, and the per-endpoint guard gotcha.
---

The customer-facing dashboard must show only Illinois data; Ohio data stays
in the DB but must never appear in the customer view.

Rule: every customer-facing endpoint in
`artifacts/api-server/src/routes/dashboard.ts` filters to a single
`CUSTOMER_STATE = "IL"` constant. This includes the aggregate/list endpoints
(districts list, medians, comparables, provision-medians, counties,
district-types) AND the per-district child endpoints
(`/:id`, `/:id/provisions`, `/:id/settlements`, `/:id/factfinding`).

**Why:** the child endpoints use only `canAccessDistrict` (auth-only) and key
off `:id`. Filtering just the list/detail is NOT enough — an authenticated
user can pass an OH district id straight to a child endpoint and read OH
provisions/settlements/factfinding (cross-state IDOR). Every per-id child
endpoint needs its own state check; it is easy to add a new one and forget.

**How to apply:** gate per-id child endpoints with the `isCustomerDistrict(id)`
helper (returns true only when the district exists AND `state = CUSTOMER_STATE`)
and 404 when it fails. Admin-only endpoints (expiration-calendar, acceptance)
are intentionally left unfiltered. The forced IL filter is unconditional (not
role-gated), so these shared endpoints cannot be used by admins to inspect OH —
if admin OH access is ever needed, split customer routes from admin routes
rather than relaxing the guard.
