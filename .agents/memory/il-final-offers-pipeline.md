---
name: IL ELRB final-offers pipeline
description: Board-vs-union final-offer scrape/extract/diff feature — model shape, IL scoping, and the cron Phase E re-extraction gap.
---

# IL ELRB final-offers (board vs union)

Separate doc pipeline from CBAs: ELRB interest-arbitration postings where the
board and the union each file a "final offer". Stored under
`source_documents.doc_type = 'final_offer'`; modeled as
`final_offer_postings` (case-level) → `final_offer_items` (per case+side+topic)
→ `final_offer_comparisons` (per topic: diff | aligned | district_only | union_only).

**IL-only, like every customer-facing read.** The Ask tool (`search_final_offers`)
and the dashboard endpoint must join `districts d` and filter `d.state =
CUSTOMER_STATE`. Out-of-state (OH) rows must never leak. There is a test that
asserts every Ask query is anchored to `.state =` + bound `CUSTOMER_STATE`.

**Cron Phase E (08_cron_incremental.py) is idempotent by skip, not by content.**
It runs the scraper (rolling current-year + lookahead, so a new year/case needs
no code change), then gates the extract+diff on `count_pending_final_offers` =
postings missing a side's items OR missing any comparison. The extractor skips
sides already extracted unless `--force`.

**Known gap:** if ELRB *edits* an already-complete posting's PDF (same URL, new
content) after both sides are extracted and compared, `count_pending_final_offers`
returns 0 and the stale comparison is kept. Re-detecting changed-content PDFs is
deliberately out of scope of the cron wiring and tracked as a follow-up.
**Why:** keeps nightly runs cheap (no re-OCR of unchanged offers); content-change
detection belongs in the scraper, not the gating count.
