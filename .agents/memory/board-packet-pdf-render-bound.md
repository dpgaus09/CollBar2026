---
name: Board Packet PDF render must be row-bounded
description: Why the peer-set Board Packet PDF export hung, and the rule for keeping renderToBuffer fast.
---

The Board Packet PDF export (GET /api/peer-sets/:id/export/pdf) once hung ~161s
and the browser aborted (logged statusCode:null). Cause was volume, NOT a
react-pdf bundling problem: the route fed the template every settlement of every
peer district across all years (~2,000+ rows), and @react-pdf/renderer's
renderToBuffer is CPU-bound and blocks the Node event loop — long enough that
other concurrent requests also stalled.

**Rule:** the rendered comparables TABLE must be bounded — one row per district
(its most recent settlement), not full history. Medians and the trend chart are
still computed over the full peer settlement history (so they match the on-screen
Comparables medians), but only the deduped per-district set is passed to the
template as `allSettlements`.

**Why:** react-pdf has no virtualization; render cost scales with element count.
A few hundred rows render sub-second; a couple thousand take minutes and block the
event loop.

**How to apply:** any time the PDF template is fed a list, cap it. Also: the
export's district membership must come from the peer set's materialized
`district_ids` only (the same set the on-screen Comparables uses) — do NOT
re-resolve `filters_json` in the export, which double-counted and leaked
out-of-state (OH) districts into an IL packet.
