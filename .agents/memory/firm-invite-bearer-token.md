---
name: Firm invite is a bearer token
description: Security constraints for firm invite acceptance (multi-seat workspace) — how to attach existing vs new accounts without enabling account takeover.
---

A firm invite link carries a high-entropy token in the URL; whoever holds the
link (including the firm_admin who created it, since there is no email delivery
yet) can present it. Treat the link as a **bearer token**, not proof of identity.

## Rules for `POST /firm/invite/accept`
- If the invited email already has a `users` row: attach firm membership **only**
  when the request is already authenticated as that exact user
  (`session.userId === existingUserId`). Otherwise return 403 `requiresLogin`
  and do NOT create a session. Never accept a password to "verify" an existing
  account here — that turns accept into an unthrottled login/brute-force surface
  and the original flaw let an admin bearer-link straight into a victim's account.
- If the invited email is new: create the account with the supplied password
  (>= 8 chars) and `session.regenerate()` (fixation guard for the new identity).
- Existing authenticated user: just set `activeFirmId`/`firmRole` on their
  current session — do NOT regenerate and do NOT overwrite their
  `userRole`/`userPlan`/`userDistrictId` (would downgrade a real CFO/admin/Pro
  user to district_user/free/null).
- Re-check `accepted_at` AND `expires_at` inside the `FOR UPDATE` transaction,
  not just before it.

**Why:** code review found an account-takeover hole — accept attached an existing
user and regenerated the session as them without proving ownership.

**How to apply:** preserve these invariants in any later firm work (re-invites,
role changes, real email delivery, SSO). Email verification would let new-account
creation be deferred, but existing-account attach must still require auth-as-user.
