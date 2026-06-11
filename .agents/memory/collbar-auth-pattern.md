---
name: CollBar auth pattern
description: How auth works in CollBar — custom magic-link on Express, not Auth.js
---

## Rule
collbar-web is React + Vite (not Next.js), so Auth.js/NextAuth is not applicable. Auth lives entirely on the Express API server using express-session + a custom magic-link flow.

**Why:** Auth.js requires a Next.js runtime. Migrating the frontend to Next.js would be a large breaking change; the custom flow is functionally equivalent.

**How to apply:**
- POST `/api/auth/request` — generates `crypto.randomBytes(32).toString('hex')` token, stores in server memory `Map<token, {userId, expiresAt}>`. Returns magic link in response body when `NODE_ENV !== 'production'` (no email provider needed for dev/demo).
- GET `/api/auth/verify?token=...` — one-time token; deletes after use; creates `express-session` with `userId`, `userRole`, `userDistrictId`, `userEmail`.
- GET `/api/auth/me` — returns current session user; unauthenticated returns `{authenticated: false}`.
- POST `/api/auth/logout` — destroys session.
- Rate limiting: `Map<email, {count, windowStart}>` — max 5 attempts per hour.
- Admin user `david@collbar.io` is seeded at server startup via `INSERT ... ON CONFLICT DO NOTHING`.
- SessionData TypeScript augmentation: `auth.ts` adds `userId/userRole/userDistrictId/userEmail`; `admin.ts` adds `adminAuthenticated`. TypeScript merges module augmentations across files.
- Magic link URL construction: use `req.headers.origin` (set by browser) to point link at the frontend. Replit proxy routes `/*` to collbar-web and `/api/*` to api-server — so the same domain works for both.
