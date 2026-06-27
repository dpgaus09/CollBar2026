---
name: Firm workspace — roster & matters (Phase 2)
description: How the firm-scoped attorney workspace selection sets work; invariants downstream phases (comparison matrix, clause search, alerts) depend on.
---

# Firm workspace: roster & matters

The firm/attorney workspace (`/app`, `/api/firm/*`) is a SECOND entitlement system,
fully parallel to the per-district CFO `gate()`/`users.plan`. Workspace access
derives ONLY from `firm_members` via `requireFirmSession()` (attaches
`req.firmAccess`). The two systems never share enforcement code. The firm district
search (`/firm/districts/search`) is its OWN endpoint — do NOT reuse the paid
peer-set comparables search.

**Rule:** every firm read/write must be constrained to `req.firmAccess.firmId`.
Cross-firm ids return 404 (never leak existence). Helpers: `loadMatter(id, firmId)`,
`firmOwnsMatter(id, firmId)`, or a DELETE/UPDATE joined through `matters` on
`m.firm_id = firmId`.
**Why:** a firm-scoped table with an id-only lookup is an IDOR; the whole workspace
is multi-tenant.

## Dual-stored matter client
A matter's client district is stored TWICE and must stay in sync:
`matters.primary_district_id` AND a `matter_districts` row with `role='client'`
(a partial unique index enforces ≤1 client row per matter). Every mutation that
touches the client — create, PUT reassign, attach `role='client'`, **detach of the
client** — must update both, and must do so in a single `db.transaction` so the pair
can never be left half-applied.
**Why:** a half-applied write leaves `primary_district_id` pointing at a district
with no client role row (or vice-versa), breaking lists/exports that read either side.
**How to apply:** when adding new client-mutating paths in later phases, wrap the
role-row write and the `primary_district_id` write in one transaction; add a test
asserting `primaryDistrictId` and the client-row set agree after the op.

## active-matter (session-scoped)
The current matter selection lives on `req.session.activeMatterId` (parallel to
`activeFirmId`). On read it must be re-validated against the firm and cleared if the
matter was deleted or is no longer in the firm; deleting a matter clears the current
session's selection. Later phases read active-matter to know which selection set to
operate over.

## Verification note
Dev DB normally has NO firms/firm_members, so you cannot curl-login a firm user.
Verify firm routes with a vitest integration test (`routes/matters.test.ts`) that
inserts two marked firms, mounts the router behind a shared mutable session stub, and
tears down by deleting firms (FKs cascade to tracked_districts/matters/matter_districts).
