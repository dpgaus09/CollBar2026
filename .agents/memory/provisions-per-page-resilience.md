---
name: Provisions extraction per-page resilience
description: Why the provisions extractor must fail at page granularity, not document granularity, and how the deep-retry completeness pass works.
---

The provisions extractor batches pages and parses each batch's JSON. A truncated/parse-error batch must degrade gracefully, NOT discard the whole document.

Rules (`provisions.ts`):
- On a truncated or parse-error batch, recurse-split down to a SINGLE page. If one irreducible page still fails, SKIP just that page (record it in `pagesSkipped`) instead of throwing and losing every other page's provisions.
- Completeness deep-retry: if the tier-1 (triaged) pass yields ZERO provisions, escalate ONCE to a no-triage deep pass over all pages up to a deep cap, then merge. Surface `deepRetried`.
- Page caps: MAX_PROVISION_PAGES ~60, DEEP ~100. Bump `PROVISIONS_PROMPT_VERSION` when the prompt/normalization changes (results are cached on it).

**Why:** Prod Palatine CCSD 15 teachers (85pp) returned a TOTAL MISS — one bad batch threw and the catch discarded the entire document. Page-level fail-closed recovered 119 provisions live. The deep-retry guards docs whose triage misses every relevant page.

**How to apply:** Keep the catch boundaries at page granularity; never let one batch's failure zero the doc. The deep pass is one-shot and capped, so there is no unbounded cost/loop risk — preserve that bound if you refactor.
