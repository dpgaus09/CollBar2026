---
name: Firm work-product exports
description: CollBar /app exports (memo/exhibit/clause appendix → PDF/DOCX) — citation-parity, durability, and entitlement constraints
---

# Firm work-product exports (Phase 5)

Firms generate billable deliverables from a matter: comparison memo, benchmark
exhibit, clause appendix — each as PDF or DOCX. Routes live in
`artifacts/api-server/src/routes/exports.ts` (mounted in routes/index.ts).

## No-new-analysis / citation parity (the core contract)
Exports render ONLY from `buildMatrix()` (lib/firm-compare-model.ts) and
`buildClauseCompare()` (lib/firm-clauses-model.ts) — the SAME queries the live
`/app` comparison-matrix and clause-compare views use. The export IR
(`routes/exports/model.ts`) copies the four citation fields verbatim
(district, sourceUrl, pageRef, retrievedAt); both renderers (pdf.tsx, docx.ts)
consume that one IR.

**Why:** every figure/clause in a delivered document must match on-screen
provenance EXACTLY; the export layer must never compute or infer.

**How to apply:** if you change the shape/values of buildMatrix or
buildClauseCompare output, update exports/model.ts + both renderers in lockstep,
and keep the firm-compare / firm-clauses route response shapes identical (those
routes were refactored to call the shared models). Parity is enforced by a test
in firm-exports.test.ts that compares model.citations to buildMatrix cells.

## Durability invariant
Object upload (`uploadBuffer`) MUST succeed BEFORE the `firm_exports` INSERT.
Orphan objects (upload ok, insert failed) are acceptable; orphan ROWS (row with
no bytes) are NOT — they 404 on download. Upload throw → 502, no row.

## Entitlement
`requireFirmSession()` only — NEVER gate()/isFree(). A cross-firm matter id or
export id is a 404 with no existence leak. All three routes (POST resolve, GET
list, GET :id/download) filter by firm_id.

## Misc
- `firm_exports` schema is Drizzle-dual-declared (lib/db/src/schema/exports.ts)
  + idempotent CREATE in app.ts runMigrations.
- Clause appendix validates provisionKeys 1..15 against buildClauseCompare
  availableTypes (server in exports.ts, mirrored in pages/app/exports.tsx).
- Frontend download is an auth'd blob (fetch credentials:include → anchor),
  NOT a plain `<a href>` (the firm session cookie + scope require it).
- OpenAPI codegen intentionally skipped for firm routes (direct firmFetch, per
  Phase 3/4 precedent).
- Clean formatting only: black text, hairline table borders, NO colored
  fills/rules/accent bars — do NOT copy the navy BoardPacketPDF styling.
