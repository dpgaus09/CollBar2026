---
name: Phase 9B state scoping
description: Rules for keeping IL and OH data strictly separated across all data flows
---
All queries that could return OH or IL settlements must filter by `d.state` (or `d2.state` for joins). Key enforcement points:
- dashboard.ts: medians/comparables/provision-medians all have `AND d.state = $districtState`
- peer-sets.ts: preview/search/POST/PUT validate no cross-state districts; PDF passes districtState
- public.ts: `computeTrackerStats(state?)` filters globally; `/api/public/district/:slug` comparables add `AND d2.state = d.state`
- public-html.ts: `/oh/:slug` adds `AND state = 'OH'`; `/il/:slug` adds `AND state = 'IL'`; sitemap uses `(r.state ?? 'oh').toLowerCase()` as URL prefix
- tracker.tsx: defaults to IL tab; `?state=` param drives both SSR and React fetch

**Why:** Districts in OH and IL share similar names and slugs; without state scoping, comparables and medians silently cross state lines producing meaningless data.

**How to apply:** Any new query joining `settlements + districts` must check `d.state` matches the context district's state. Never use `slug` alone as a unique key — always pair with `state`.
