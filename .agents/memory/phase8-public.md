---
name: Phase 8 public layer
description: SSR district pages, Vite dev proxy, slug/plan DB schema, county field quirk
---

## Key decisions

**County field already contains "County" suffix**
- DB `districts.county` stores e.g. "Hardin County", NOT "Hardin"
- Do NOT append " County" in templates — produces "Hardin County County"
- All display/meta templates should use `${d.county}` directly

**SSR HTML routes mounted before /api on Express**
- `publicHtmlRouter` (public-html.ts) registered in `app.ts` BEFORE the `/api` router
- Routes: GET /tracker, GET /oh/:slug, GET /sitemap.xml, GET /robots.txt
- Vite dev proxy in `vite.config.ts` forwards these paths to Express port 8080

**Public JSON API routes**
- `/api/public/tracker-stats` — 1h cache, returns 0s until extraction pipeline exists
- `/api/public/districts` — returns `id, slug, name, county`; `id` required by signup form
- `/api/public/district/:slug` — full district data for SSR + district pages

**Plan column on users**
- `plan` column: CHECK ('free','pro'), default 'free'
- `isPro` computed as `isAdmin || plan === 'pro'` in `/auth/me`
- POST `/api/auth/signup` upserts user with plan='free', returns magic link

**Signup form**
- Uses `/api/public/districts` (no auth required) for district dropdown — NOT `/api/dashboard/districts`
- District list includes `id` so form can POST `district_id` to `/api/auth/signup`

**Why:**
- County field format discovered when "Hardin County County" appeared in meta descriptions
- Public districts endpoint needed `id` for the signup POST body; originally omitted
