---
name: Firm compare provenance gating
description: What gates a cell as "shown" in the firm cross-district compare matrix, and why page_ref/confidence/human_verified are NOT hard filters.
---

# Firm cross-district compare matrix — provenance gating

The project goal lists "full provenance" as (id, source_url, page_ref, retrieved_at, confidence, human_verified). That set is what every cell **carries in its payload**, NOT a set of non-null filters.

## The hard gate for showing a cell
A cell is emitted only when it has a real value AND a citation:
- `id` — the row PK (provision/settlement), always present.
- `source_url` — required (NOT NULL). This IS the citation gate.
- `retrieved_at` — rides the same `source_documents` row as `source_url` (100% populated), so effectively guaranteed once source_url is required; no separate filter needed.
- Provision cells additionally require a non-blank verbatim `clause_excerpt` (the value is derived from that clause; without it you can't verify source language). Settlement cells have `clauseExcerpt=null` by design.

## What is NOT gated (and why)
`page_ref`, `confidence`, `human_verified` are surfaced honestly (null when absent; `human_verified=false` ⇒ the amber "machine-extracted" marking) but are NEVER hard filters.

**Why:** verified against live data —
- **Settlements have `page_ref` NULL for 100% of rows** (settlements are aggregate records, not page-anchored clause extractions). Requiring page_ref would emit ZERO settlement cells and kill the settlement half of the matrix that the spec explicitly designs columns for.
- Provisions are ~92% page_ref; requiring it drops legitimately-cited rows.
- `human_verified=true` rows can legitimately have `confidence=NULL` (human entry, no model score). Gating on confidence would suppress the MOST trustworthy values. A human-verified value with null confidence is more trustworthy, not less.

**How to apply:** keep this gate consistent across downstream firm features (clause search, export). Don't "tighten" provenance into non-null filters on page_ref/confidence/human_verified — that contradicts the data shape and the "missing renders an empty CELL, not a hidden value" principle. The citation gate is value + source_url (+ verbatim excerpt for provisions).

## Settlement latest-per-district ordering (stale-fallback trap)
Pick the latest settlement per district in a CTE FIRST (DISTINCT ON district, ORDER BY year DESC, id DESC), THEN LEFT JOIN `source_documents`. If you INNER JOIN the citation before choosing latest, an uncited NEWEST settlement is dropped and an older CITED one wrongly surfaces (stale fallback). After the CTE, skip rows whose source_url is null ⇒ uncited latest ⇒ empty (never stale).
