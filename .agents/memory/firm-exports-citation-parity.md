---
name: Firm work-product exports
description: CollBar /app exports (memo/exhibit/clause appendix → PDF/DOCX) — durable invariants for citation parity, durability, and entitlement
---

# Firm work-product exports (Phase 5)

Firms generate billable deliverables from a matter — comparison memo, benchmark
exhibit, clause appendix — as PDF or DOCX, persisted to Object Storage with
metadata in a `firm_exports` table.

## Citation parity (the core contract)
Exports render ONLY from the same shared data builders the live `/app` views use
(the comparison-matrix and clause-compare models). One export IR, two renderers
(PDF + DOCX). The export layer NEVER computes or infers — "no new analysis."
**Why:** every figure/clause in a delivered document must match on-screen
provenance (district, source_url/title, page, retrieved date) EXACTLY.
**How to apply:** if you change the compare/clauses model output, update the
export IR + both renderers in lockstep, and keep the compare/clauses route
response shapes identical (those routes were refactored to call the shared
models). A test asserts export citations == builder citations — keep it green.

## Durability invariant
Object upload MUST succeed BEFORE the Postgres row insert. Orphan objects
(upload ok, insert failed) are acceptable; orphan ROWS (row, no bytes) are NOT —
they 404 on download. Upload throw → 502, no row.

## Entitlement
`requireFirmSession()` only — NEVER gate()/isFree(). A cross-firm matter id or
export id is a 404 with no existence leak; every route filters by firm_id.

## Decisions worth keeping
- Frontend download is an auth'd blob (fetch credentials:include → anchor), NOT
  a plain `<a href>` — the firm session cookie + scope require it.
- OpenAPI codegen intentionally skipped for firm routes (direct firmFetch, per
  Phase 3/4 precedent).
- Clean formatting only: black text, hairline borders, NO colored
  fills/rules/accent bars — do NOT copy the navy BoardPacketPDF styling.
