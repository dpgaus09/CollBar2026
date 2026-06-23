---
name: Production 300s proxy timeout + global json 100kb limit
description: Two infra constraints that shape CollBar API request design — a hard request-duration cap and an app-wide body-size cap that runs before any route.
---

# Production proxy 300s timeout

CollBar's production deployment aborts any single HTTP request that runs longer
than ~300s (observed in deployment logs as `responseTime=300080` followed by
`request aborted`). Autoscale cores are throttled, so CPU-bound work runs much
slower than in dev.

**Why:** A bulk customer import hashed ~900 passwords with bcrypt in one
synchronous request and blew past the cap — the client only saw a generic
"Network error during import."

**How to apply:** Any endpoint whose work scales with input size (bulk imports,
bcrypt/argon hashing loops, large batch upserts, report generation) must be
bounded per request. The pattern used here: the browser splits the work and
sends sequential batches (bulk import = 100 rows/batch), so each request is
short. Don't rely on a single long request finishing in prod just because it
finishes in dev.

# Global express.json() runs before per-route parsers

`artifacts/api-server/src/app.ts` mounts a global `express.json()` with the
DEFAULT 100kb limit. It runs BEFORE any route handler, so a per-route
`json({ limit: ... })` is effectively a no-op for JSON bodies — the global
parser has already consumed (or rejected) the body.

**Why:** A wide/long CSV batch could exceed 100kb and get a 413 from the global
parser before the route ever runs; Express's default 413 body isn't JSON, so an
unguarded `await res.json()` on the client throws and hides partial progress.

**How to apply:** To accept a larger JSON body on one route you must either
raise the global limit (affects every route — increases DoS surface, avoid
unless intended) or keep payloads under 100kb. The bulk-import client keeps each
batch under ~90KB by byte-budgeting rows. Client code that POSTs to API routes
should parse error responses defensively (`await res.text()` + guarded
`JSON.parse`) since 413/502/504 from the parser or proxy are not guaranteed JSON.
