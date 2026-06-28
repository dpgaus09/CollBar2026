---
name: Firm "Entire database" clause scope
description: The firm clause-search/compare "database" scope spans the whole CUSTOMER_STATE corpus, and the firm /document auth was widened to match.
---

# Firm clause tools have a whole-state "database" scope

The firm `/app` clause tools (clause-search + clause-compare) expose a scope
beyond the firm's own workspace: **"database" = every district in
CUSTOMER_STATE (IL)**, not just roster ∪ matters. Out-of-state (OH) stays hidden.

**Rule:** clause scope is a discriminated union — `{kind:"districts", districtIds}`
for matter/tracked/all/explicit, and `{kind:"state", state}` for "database".
The empty-list short-circuit and the MAX_DISTRICTS cap apply ONLY to
`kind:"districts"`; "database" is bounded by result LIMIT (search ≤50) and
DATABASE_MAX_CLAUSES (compare). The clause-search cache key MUST encode scope
kind + state (not the absent id list), or a "database" request collides with a
genuinely-empty workspace scope.

**Why:** firm attorneys wanted to compare a clause across the whole in-state
corpus, not only districts they track. The integrity invariant (every returned
clause's source PDF must be openable) forced a matching auth change.

**Companion auth widening — `GET /api/firm/document`:** a firm member may now
open ANY document whose district is in their workspace OR in CUSTOMER_STATE.
Firm membership is still required (non-members 403) and OH still 403s. This
deliberately drops the old roster-based cross-firm doc isolation for in-state
docs — any firm member can open any IL doc. **How to apply:** if you add a
per-district guard on a firm route, do NOT assume firm doc access is
workspace-scoped; it is firm-member + in-state. (Distinct from the *dashboard*
document route, which stays gate()/own-district governed — see
collbar-document-link-auth.md.)
