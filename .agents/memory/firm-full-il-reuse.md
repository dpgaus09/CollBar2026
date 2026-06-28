---
name: Firm workspace full-IL settlements + Ask reuse
description: Why firm /app Settlements & Ask use requireFirmSession over shared reads/engine, never gate(), and how the Ask path-rewrite works.
---

Firm workspace (`/app`) exposes a **Settlements browser** (all ~971 IL districts → detail: settlements, salary schedules, clauses) and an **Ask AI** tab. Both are open to EVERY firm member regardless of plan tier, with FULL data for all IL districts.

**Rule:** firm endpoints (`/api/firm/settlements/*`, `/api/firm/ask`, `/api/firm/conversations`) MUST use `requireFirmSession` and MUST NOT call `gate()`. The per-district dashboard `gate()` paywall stays unchanged — the two access models are deliberately separate.

**Why:** firms pay for firm-tier access to the whole IL dataset; the district `gate()` paywall is a different product surface (single-district customers). Mixing them would either paywall firm members or leak full data to district customers.

**How to apply (reuse, never fork):**
- Settlements reads go through `artifacts/api-server/src/lib/district-reads.ts` (shared with `routes/dashboard.ts`). Do not duplicate the SQL.
- Ask goes through `artifacts/api-server/src/lib/ask-engine.ts` (shared with `routes/ask.ts`). Same model, same IL-scoped tools, same SSE protocol.
- The ONLY view difference is link targets: the engine's `ResultPathMode` (`"dashboard"` | `"firm"`) rewrites tool-emitted `/dashboard/<id>...` card paths to `/app/settlements?district=<id>...` for the firm view. Keep both modes working in lockstep.
- Ask stays IL-anchored (`CUSTOMER_STATE`); never broaden scope in the firm route.
- Firm routes must be mounted BEFORE `dashboardRouter` in the app.

**Frontend:** `pages/app/settlements.tsx` + `pages/app/ask.tsx`, firm hooks in `hooks/use-firm.ts` (use `firmFetch`, NOT openapi codegen). No `isFree`/`LockedPage`/`gate` in firm UI — `WorkspaceShell` is the only audience guard. Deep links: `?district=&?unit=` via wouter `useSearchParams`.
