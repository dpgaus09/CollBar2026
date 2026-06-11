---
name: SERB PDF download requirements
description: How to successfully download PDFs from serb.ohio.gov/static/PDF/Contracts/
---

PDFs at `https://serb.ohio.gov/static/PDF/Contracts/{YEAR}/{case}.pdf` require:
1. AWS ALB session cookies — obtained by first GETting any serb.ohio.gov page (homepage is lightweight; the CBA catalog is 10MB and times out at 30s).
2. `Referer: https://serb.ohio.gov/wps/portal/gov/serb/view-document-archive/collective-bargaining-agreements`
3. A browser-like User-Agent.

**Why:** Without the cookies the server returns an empty/closed connection (requests returns None). Without Referer it returns a redirect or error. curl with `-H "Referer: ..."` plus having visited the catalog page first downloads 6.6MB real PDFs.

**How to apply:** In `pipeline/common.py`, `PDF_HEADERS` has the Referer. In `02_scrape_serb_cba.py`, `fetch_cba_page()` warms up the session by GETting `https://serb.ohio.gov/` (not the 10MB catalog) before downloading PDFs. Use `polite_get(session, url, headers=PDF_HEADERS, timeout=120)`.
