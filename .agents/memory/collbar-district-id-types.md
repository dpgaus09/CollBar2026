---
name: CollBar district id type/limit gotchas
description: Dashboard API returns district id as a STRING and the list endpoint is capped, both of which bite client-side district matching.
---

# CollBar district id type & list-cap gotchas

When matching a customer's own district on the client (e.g. pinning it in the picker), two non-obvious traps:

1. **District `id` comes back as a STRING from the dashboard API** (e.g. `"10855"`), even though the TS `District` interface declares `id: number`. This is `db.execute` returning Postgres bigint/numeric as strings. Meanwhile `/api/auth/me` returns `districtId` as a real NUMBER. A strict `d.id === districtId` comparison silently fails.
   **How to apply:** coerce both sides, e.g. `Number(d.id) === Number(districtId)`, whenever comparing a district id from a list row against a numeric id from auth/session.

2. **`GET /api/dashboard/districts` is capped at `LIMIT 1000`** while the table holds ~1562 rows (IL + OH), ordered by name globally. A given district may simply be absent from the list.
   **Why:** you cannot rely on the list to contain an arbitrary district.
   **How to apply:** to render/select a specific known district (like the logged-in user's own), fetch it directly via `GET /api/dashboard/districts/:id` instead of `.find()`-ing the capped list.
