---
name: Free-tier access gating (CollBar)
description: How free vs paid/admin customers are gated server-side; read before touching dashboard/ask/peer-sets route guards or adding any benchmark endpoint.
---

# Free-tier gating invariants (CollBar)

Free customer = non-admin with `plan !== 'pro'`. Free users get ONLY their own
district's Overview + the Toolkit page. Admins and pro users are never gated.

## Rule 1 — enforcement is server-first and reads LIVE access
The shared `gate()` middleware (api-server `src/lib/access.ts`) reads
role/plan/district_id/active from the DB on every request via `loadAccess`, NOT
the cached session.
**Why:** an admin downgrade (pro→free), district reassignment, or deactivation
must take effect immediately, not only after the customer next logs in.
**How to apply:** never gate off `req.session.userPlan` alone; always go through
`gate(...)`. UI greying is cosmetic — the server gate is the real line.

## Rule 2 — aggregate median endpoints must scope free users' filters
`/dashboard/medians` and `/dashboard/provision-medians` are shared by the
Overview (allowed) and by paid Comparables-style analysis (not allowed for free).
They use `gate({ ownFilters: true })`: for free users, any `county`/`band` query
filter MUST equal the caller's own district's county / `enrollmentBand(enrollment)`
or it 403s; a bare (no county/band) request returns the broadest statewide
aggregate and is allowed.
**Why:** without this, a free user could iterate county/band via direct API calls
and reconstruct the paid Comparables dataset (broken access control).
**How to apply:** any NEW endpoint that exposes cross-district aggregates and is
reachable by free users must either be `gate({ paid: true })` or scope its
filters to the caller's own district the same way. The client Overview only ever
sends the user's OWN county/band, so own-scoped filtering doesn't break it.

## Rule 3 — gate option matrix
- `gate({ paid: true })` → paid-only feature; free 403 `PAID_FEATURE`.
- `gate({ ownDistrict: true })` → route has `:id`; free may only hit their own.
- `gate({ ownFilters: true })` → free may only filter by own county/band.
- Combine as needed (e.g. factfinding/final-offers use `{ ownDistrict, paid }`).
All free rejections return the verbatim `UPGRADE_MESSAGE` (kept in lockstep with
client `components/upgrade.tsx`).

## Testing note
`lib/access.test.ts` covers the gate matrix with a mocked `@workspace/db` and also
mounts the REAL dashboard router to prove routes are wired to the real gate.
`routes/ask.test.ts` mocks `../lib/access.js` `gate` down to the auth check so the
median/queue mocks aren't consumed by `loadAccess` — the gate's real behavior is
covered in access.test.ts, not ask.test.ts.
