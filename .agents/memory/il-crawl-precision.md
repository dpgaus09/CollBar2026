---
name: IL CBA crawl precision
description: Two precision guards that keep the IL CBA discovery crawl from storing non-CBA junk and falsely marking districts "found".
---

# IL CBA crawl precision guards

The IL discovery crawl (`pipeline/11_crawl_il_cbas.py`) uses Serper search +
homepage crawling to find district CBA PDFs. Two classes of false positives must
be guarded against, because both silently poison coverage:

## 1. Aggregator / government domains in name-search
**Rule:** name-based Serper search (for districts with no website_url) must
denylist aggregator + government domains (`isbe.net`, `ilga.gov`,
`illinois.gov`).
**Why:** a bare district-name search matches ISBE board-meeting packets and state
portals, which look CBA-ish but are not the district's contract. isbe.net is also
unreachable from the sandbox, so those candidates also time out.
**How to apply:** keep `_SEARCH_DOMAIN_DENYLIST` + `_is_denied_search_domain()`
and skip denied URLs in the `_search_fallback` candidate loop. Only applies to
search-discovered (off-domain) candidates, not on-domain homepage crawl results.

## 2. HTML landing pages stored as PDFs
**Rule:** before storing a downloaded candidate, require the `%PDF` magic header
in the first ~1KB; reject (status `failed`, reason `not_a_pdf`) otherwise.
**Why:** the broad site-scoped search query intentionally returns non-`.pdf` URLs
(doc-management / board / "collective-bargaining" landing pages) because some
redirect to a real PDF. When the body is actually HTML, storing it under a
`il/cba/<hash>.pdf` key (a) marks the district `found` so it is never re-crawled,
masking a real coverage gap, and (b) guarantees a downstream
`PDF_CORRUPT_OR_UNREADABLE` extraction failure. A size>1024 check is NOT enough —
HTML error/landing pages are large and many districts return the *same* CMS 404
template (identical file_hash across many docs is the tell).
**How to apply:** the magic-byte check lives in `_store_candidate` after the size
check. Returning `failed` (not `found`) keeps the district re-attemptable. If junk
HTML-as-PDF docs already exist, they are safe to delete (0 contracts) and their
`per_district` crawl-state entries (keyed by RCDTS) should be removed so the next
crawl retries them honestly.
