---
name: IL viewer-hosted CBA recovery
description: How CBAs behind embedded viewers (Box/Issuu/Drive/etc.) are surfaced and recovered into source_documents.
---

# Recovering CBAs stuck behind embedded viewers

Some IL districts publish their CBA inside an embedded viewer instead of a plain
`.pdf` link. The crawler (`11_crawl_il_cbas.py`) cannot resolve these during its
fast link-scan, so `_resolve_viewer` returns `(None, True)` for the hosts in
`VIEWER_MANUAL_HOSTS` and they are appended to the module-level `_manual_review`
list, written to `data/il_cba_manual_review.csv` **only at the very end of a
non-dry-run crawl** (never on `--dry-run`).

**Key constraint:** the manual-review CSV is a *side effect of crawling*. It is
empty until a non-dry-run crawl actually re-visits pages that embed viewers.
`--retry-failed` only re-crawls the ~69 previously failed/search_failed
districts, so viewer yield from a retry pass can be low/zero — the hardest
districts are exactly the ones already marked failed.

**Why recovery is a separate step, not inline in the crawler:** resolving a
viewer needs an extra network fetch per link (fetch the Box share page, hit the
Issuu reader API, scrape a Drive folder). Doing that inside the per-link scan
would slow every crawl and add fragility, so it lives in
`13_recover_viewer_cbas.py`, which reads the CSV and best-effort resolves each
host, then ingests via the same contract as the crawler (`%PDF` header check →
sha256 → per-district hash dedup → object storage → upsert `source_documents`).

**Resolvers are best-effort and host-fragile.** Box `/s/` needs the file id
scraped from the share page; Issuu only works when `downloadable:true`; Drive
folders need ids scraped from the embedded JS blob. Anything that fails is
written to `il_cba_manual_review_remaining.csv` and must be hand-downloaded, then
ingested with `13_recover_viewer_cbas.py --pdf <file> --rcdts <code> --url <viewer_url>`.

**Empirical finding (June 2026): viewer-hosted CBAs are rare in the IL set.**
A broad probe of the 80 highest-enrollment *unfound* districts surfaced 136
viewer embeds (135 Google Drive, 1 Issuu) across 12 districts — but **zero were
CBAs**; they were board-meeting agendas/minutes and one "Return to Learn" plan.
A CBA-keyword-gated `--retry-failed` crawl logged **zero** viewer/manual-review
additions across the failed districts it re-hit. Takeaway: most embedded viewers
on these district sites carry board-docs, not contracts, which is exactly why the
crawler's `_score_pdf_text > 0` gate keeps the manual-review CSV near-empty. Do
not "recover" every embedded Drive/Box file as a `cba_pdf` — that pollutes the
table with agendas. Only ingest viewers that carry CBA signal.

**Drive resolver is live-verified.** `resolve_drive` on a `/file/d/<id>/` URL →
`uc?export=download&id=<id>` downloads a real `%PDF`. Folder URLs are fragile:
the inline blob contains Google config tokens (e.g. `_F_toggles_default_...`);
the folder id regex requires an alphanumeric first char to skip them. Large
files hit Drive's virus-scan interstitial and return HTML — `_download_pdf`
correctly rejects non-`%PDF` bytes, so bad ids fail safe (no garbage stored).

**Content-aware CBA classification (June 2026).** `13_recover_viewer_cbas.py`
now downloads each candidate and classifies its *text* before storing:
`classify_cba_text` balances title phrases ("collective bargaining agreement"),
contract-body phrases (grievance/salary schedule/arbitration/seniority…), and
board-meeting phrases (call to order/roll call/consent agenda/motion/minutes).
A doc dominated by agenda signals with a thin body is rejected (status
`not_cba`) even if it *mentions* a CBA. Real CBAs accumulate body≥6; agendas
score agenda≥4. Content check is ON by default for CSV recovery
(`--no-content-check` to disable, `--fast` for text-layer-only/no-OCR); manual
`--pdf` ingests skip it unless `--content-check`. Text extraction reuses
06's `extract_pdf_text`/`_text_layer`; keyword score reuses 11's
`_score_pdf_text` (loaded via importlib — both modules have numeric filenames).
**Gotcha:** the crawler keyword score is noisy ("teachers"/"agreement" hit on
handbooks) — never let it override a thin body (rescue branch requires kw≥8 AND
body≥3 AND agenda≤1). **Known gray area:** PRESS board-policy manuals (body 3-5,
agenda low) still pass — they're not the agenda problem this targets.

**Wider net is opt-in at the crawler.** `11_crawl_il_cbas.py --log-all-viewers`
logs EVERY embedded viewer/doc-host file to the manual-review CSV (reason
`viewer_unflagged`), not just keyword-flagged ones, so 13 can content-check the
full set. Default off so routine crawls keep the near-empty keyword-gated CSV.

**District mapping** in the recovery step uses the CSV `rcdts` column when
present, else falls back to matching the source `page` host to
`districts.website_url`. The crawler now writes `host/district/rcdts` columns
(via `_current_district`, set per-attempt), but older CSVs only have
`url,page,text,reason` — the page-host fallback keeps those working.
