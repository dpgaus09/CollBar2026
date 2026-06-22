---
name: api-server dev runs a stale prebuilt bundle → restart
description: Why api-server changes (new routes OR edited handlers) don't take effect in dev until the workflow is restarted
---

The `artifacts/api-server: API Server` dev workflow does **NOT** watch/hot-reload.
Its `dev` script is `build && start` → it bundles once to `dist/index.mjs` and runs
that static bundle. So ANY source change (a new route, OR an edit to an existing
handler) keeps running the OLD code until the workflow is restarted. This also means
a freshly-merged task is not live in dev until you restart the api-server.

**Symptoms (not just 404s):**
- A new route 404s even though its path is correct and wired into `routes/index.ts`.
- An edited handler runs OLD behavior while returning a normal 200 — e.g. a PATCH
  that should now persist a new column returns 200 but silently ignores it because
  the running bundle predates that field. Looks like a code bug; it is staleness.

**How to confirm staleness (read-only):**
- Compare `stat -c '%y' artifacts/api-server/dist/index.mjs` (build time) against the
  source file's mtime. If the source is newer than the bundle, it's stale.
- `rg -c "<expected new string>" artifacts/api-server/dist/index.mjs` — 0 matches in
  the bundle means the running server lacks the change.
- Find the live PORT via `/proc/<pid>/environ` of the `dist/index.mjs` process.

**How to apply:** After editing/adding api-server code OR after a merge, restart the
`artifacts/api-server: API Server` workflow before curl-testing. Don't chase a 404 or
a "200 but ignored my change" by re-editing — a restart rebuilds the bundle.
(Reminder: router paths are relative to the `/api` mount — use `/dashboard/ask`,
never `/api/dashboard/ask`, or you double-prefix to a real 404.)
