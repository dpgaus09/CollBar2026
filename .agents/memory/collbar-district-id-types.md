---
name: CollBar district id type/limit gotchas
description: Dashboard API returns district id as a STRING and the list endpoint is capped, both of which bite client-side district matching.
---

# CollBar district id type & list-cap gotchas

When matching a customer's own district on the client (e.g. pinning it in the picker), two non-obvious traps:

1. **Root cause:** `db.execute` returns Postgres `bigint`/`bigserial` (int8) columns as STRINGS, so raw district rows have `id` as `"10855"` even though every TS `District` interface declares `id: number`. `/api/auth/me` returns `districtId` as a real NUMBER, so a strict `d.id === districtId` silently fails on un-coerced rows.
   **Fix in place:** the API now coerces district `id` to a number at the boundary via `coerceId`/`coerceIds` (`artifacts/api-server/src/lib/coerce.ts`), applied in the dashboard list+detail and peer-sets search/preview endpoints. So the `id: number` contract is now honest for those responses and client code can use strict `===` without `Number()`.
   **How to apply:** when adding a NEW endpoint that returns district (or other bigserial-pk) rows to the frontend, wrap `rows.rows` in `coerceIds(...)` (or `coerceId(...)` for a single row). Do NOT rely on raw `db.execute` rows having numeric ids. If you compare an id that did NOT pass through coercion, still coerce both sides.

2. **`GET /api/dashboard/districts` is capped at `LIMIT 1000`** while the table holds ~1562 rows (IL + OH), ordered by name globally. A given district may simply be absent from the list.
   **Why:** you cannot rely on the list to contain an arbitrary district.
   **How to apply:** to render/select a specific known district (like the logged-in user's own), fetch it directly via `GET /api/dashboard/districts/:id` instead of `.find()`-ing the capped list.
