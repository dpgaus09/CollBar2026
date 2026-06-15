---
name: IL CBA crawler discovery boosts (sitemap / JS-render / on-page)
description: How the 3 added discovery capabilities work and the non-obvious constraints (NixOS Playwright, %PDF verify, html_contract source_type plumbing).
---

The IL CBA crawler (`pipeline/11_crawl_il_cbas.py`) gained three discovery capabilities layered on top of the existing direct_crawl + search-fallback logic. provenance precedence for `found_via`: `js_render` > `onpage` > `sitemap` > `direct_crawl` (search fallback collapses to `search`).

## Playwright on NixOS — the launch contract
**Rule:** never rely on Playwright's bundled browsers (they are NOT installed here). Launch the Nix chromium explicitly:
`chromium.launch(executable_path=shutil.which("chromium") or shutil.which("chromium-browser"), headless=True, args=["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"])`.
**Why:** the sandbox/prod images ship chromium via Nix on PATH but have no `playwright install` browser cache; `--no-sandbox` is required or chromium won't start as root.
**How to apply:** keep render strictly optional — a single lazy singleton browser reused across districts; on any import/launch failure set a module `_render_disabled` flag and return None so the crawl degrades to non-JS rather than crashing. Render is budget-capped per district and only triggered on zero-signal pages; domains that needed rendering are cached to crawl-state `render_domains[]` so later runs go straight to the browser.

## %PDF verification before counting a find
Broadened/off-domain/extensionless doc candidates must pass a ranged GET (`Range: bytes=0-1023`) requiring `application/pdf` content-type OR a `%PDF` magic header before being stored. **Why:** district sites routinely return `text/html` 200s for doc-looking URLs (FOIA/HR landing pages), which previously falsely marked districts "found". Cache verify results per-URL per run to bound request volume.

## html_contract source_type — plumb it end to end
When no downloadable doc exists but a (possibly rendered) page reads like the actual agreement (length + repeated ARTICLE headers + "agreement" + salary/wage terms), capture the page text as a source document with `source_type='html_contract'` (stored as a local `.txt`).
**Why:** some districts publish the CBA as an HTML page, not a PDF.
**How to apply:** `source_documents.source_type` (additive text col, default `'pdf'`) is the contract. Any new source_type must be plumbed in lockstep: crawler store branch → DB column → `06_extract_contracts.py` (it is the 8th SELECT column, unpacked as `row[7]`; the extractor branches `is_html` to read the stored `.txt` with `used_ocr=False`, `ocr_confidence=None`). Unresolvable embedded viewers (Box/Issuu/Scribd/Drive folders) are not stored — they go to a manual-review CSV instead.
