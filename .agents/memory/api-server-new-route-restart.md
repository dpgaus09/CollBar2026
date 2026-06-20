---
name: api-server new-route 404 → restart
description: Why a freshly-added Express route can 404 in dev even when the path is correct
---

A `404` on a newly-added api-server route whose path is provably correct (right
string, registered in `routes/index.ts`, mounted under `/api`) almost always
means the running dev server predates the route registration — not a code bug.

**Why:** The api-server dev workflow runs under `tsx` watch. A newly *added*
route module / new `import` in `routes/index.ts` is not always hot-picked-up; the
process can keep serving its old route table. Auth/existing routes still work,
which masks the staleness.

**How to apply:** After creating a new `routes/*.ts` file AND wiring it into
`routes/index.ts`, restart the `artifacts/api-server: API Server` workflow before
curl-testing. Don't keep editing the route file chasing a 404 that a restart
fixes. (Reminder: router paths are relative to the `/api` mount — use
`/dashboard/ask`, never `/api/dashboard/ask`, or you double-prefix to a real 404.)
