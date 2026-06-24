---
name: Source-PDF link auth (new-tab navigation)
description: Why dashboard document links carry a signed token instead of relying on the session cookie, and the access invariant.
---

# Source-PDF links authenticate with a signed token, not the cookie

"View source PDF" links and provenance-tooltip source links open `upload://`
documents via a NEW top-level browser tab at `GET /api/dashboard/document`.

**Rule:** the link carries its own short-lived signed credential; it must NOT
depend on the session cookie.

**Why:** the app runs in a cross-site Replit-preview iframe where the
express-session cookie is `SameSite=Lax` and partitioned. A brand-new top-level
tab navigation does not present that cookie, so the route 401s
("Authentication required"). Switching the cookie to `SameSite=None` is not a
fix — third-party cookies are being partitioned/phased out and it weakens CSRF
posture.

**How it works:**
- `lib/documentToken.ts` signs/verifies an HMAC token `"<userId>.<exp>.<sig>"`
  with the SAME `SESSION_SECRET` as the session (default
  `collbar-dev-only-not-for-production` in dev). The token only proves identity.
- `/api/auth/me` returns `documentToken`; the web stores it via
  `setDocumentToken` (`collbar-web/src/lib/api.ts`), set from the `use-auth`
  queryFn and cleared on logout. `sourceHref()` embeds it in the upload:// URL.
- `GET /dashboard/document` resolves access from the session cookie OR the token
  (`loadAccessForUser`), then RE-APPLIES the per-district checks
  (IL-only via `isCustomerDistrict`, free = own district). The token never
  bypasses authorization — it is a per-user identity, not a per-doc grant.

**Gotchas:**
- The token is stateless, so it stays valid until expiry even after logout
  (8h TTL, == session maxAge). Acceptable: equivalent exposure to the cookie,
  and the in-memory copy is cleared on logout/navigation.
- Error responses use `sendDocumentError`: HTML page when
  `Sec-Fetch-Dest: document` (top-level nav), JSON otherwise — keep route tests
  cookie/XHR-style (no that header) so they still assert JSON.
