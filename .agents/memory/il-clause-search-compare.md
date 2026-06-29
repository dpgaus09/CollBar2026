---
name: IL clause search & compare (Phase 4)
description: Retrieval-first firm clause search/compare design — tsvector retrieval, grounded-only synthesis, firm scoping, and the two-query compare picker pattern.
---

# Clause search & side-by-side compare (firm workspace, /app)

Retrieval-first: keyword full-text search (`clause_tsv` generated tsvector + GIN,
`websearch_to_tsquery` + `ts_rank`) over the VERBATIM
`contract_provisions.clause_excerpt`, anchored to the latest contract per
(district, unit). Every result is a real stored clause with full provenance
(provisionId, source PDF, page_ref, confidence, human_verified). The single model
call only SYNTHESIZES over already-retrieved clauses and is best-effort:
`synthesis=null` on failure, and the verbatim clauses are always returned.

**Scope rule:** scope `all` = firm scope (roster ∪ matters), NOT a cross-firm
corpus. There is deliberately no cross-firm clause search (would need broadened
document authorization + a geo entitlement that don't exist yet).
**Why:** every citation must open via `/api/firm/document` (`firmSourceHref`), so
the scope can never contain a district outside the firm — otherwise the PDF link
404s and it becomes an IDOR surface.

**Entitlement:** `requireFirmSession` (firm membership), NOT `gate()`/`isFree()`.
Endpoints: POST `/api/firm/clause-search` (haiku synth) + POST
`/api/firm/clause-compare` (opus synth). Both rate-limit the model path; identical
search requests are cached in-memory with a TTL.

**Frontend two-query compare pattern (`clause-compare.tsx`):** the provision-type
picker is driven by a SEPARATE `useClauseCompare` query with `provisionKey` omitted
(cheap, no model call, stable key); the side-by-side comparison is a second query
with `provisionKey` set, `enabled` only once a type is chosen (the expensive opus
path).
**Why:** keeps the picker populated/stable while a comparison loads and isolates
the costly call.
**How to apply:** clear `provisionKey` on scope/unit change so the compare query
never fires against a new scope with a stale selection (an accidental opus call).
`clause-search` is a `useMutation` (user-initiated, fires only on submit), not an
auto-firing query.

**Synthesis citations:** the model is told to cite `[#provisionId]`; the UI prints
`#provisionId` on each ClauseCard so `[#123]` in the summary maps to a visible card.

**Vitest typecheck gotcha:** a `vi.fn(async () => ...)` with no declared parameter
makes `mock.calls[0][0]` fail `tsc` (calls typed as empty tuple) even though the
test passes at runtime. Give the mock impl a typed param (e.g.
`vi.fn(async (_args: { messages: unknown }) => ...)`) when asserting on call args.
Then to read OTHER fields off that arg (e.g. `system`) cast through `unknown`
first (`as unknown as {...}`) or `tsc` rejects the non-overlapping conversion.

**Prompt caching:** clause-search/compare synthesis sends its static system
prompt with an ephemeral `cache_control` breakpoint (same proven pattern as
ask-engine buildSystem: process-level latch + one-shot retry-without-cache on a
400). `msg.usage` may be absent (mocked client) → coalesce `?.…?? 0`. NOTE the
synth system prompts are tiny (~150 tokens), below Anthropic's min cacheable
prefix (1024 opus / 2048 haiku), so real cache writes/reads only materialize if
those prompts grow — the mechanism is correct and degrades cleanly regardless.

**Response-cache test gotcha:** the in-memory `responseCache` keys on the raw
query STRING, so a test asserting the model was called must use a query distinct
from every prior test's (else it's served from cache, 0 model calls). Stemming
makes order/plurals equivalent in tsquery, so "sick day" / "days sick" both match
"sick days per year" yet are distinct cache keys.
