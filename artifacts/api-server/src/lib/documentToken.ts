import { createHmac, timingSafeEqual } from "crypto";

// Short-lived, self-contained credential for the document-serving route.
//
// "View source PDF" links open a brand-new top-level browser tab pointing at
// GET /api/dashboard/document. In the Replit preview the app runs inside a
// cross-site iframe whose express-session cookie is SameSite=Lax and set in a
// partitioned/third-party context, so a new top-level navigation does NOT carry
// that cookie and the route would 401. Switching the cookie to SameSite=None is
// not a reliable fix (browsers are partitioning/phasing out third-party
// cookies) and weakens CSRF posture, so instead each link carries its own
// signed token. The token only proves *who* the caller is; the document route
// still re-derives the user's live access and re-applies the per-district
// checks, so access rules are identical to the cookie path.
//
// Signed with the same secret as the session (SESSION_SECRET) so it shares the
// session's trust root and rotates with it.
const SECRET = process.env.SESSION_SECRET ?? "collbar-dev-only-not-for-production";

// Match the session cookie lifetime (8h) so a token never outlives the session
// it was minted alongside.
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

// token = "<userId>.<expEpochMs>.<base64url(HMAC-SHA256)>"
export function signDocumentAccessToken(userId: number, ttlMs: number = DEFAULT_TTL_MS): string {
  const exp = Date.now() + ttlMs;
  const payload = `${userId}.${exp}`;
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

// Returns the userId on a valid, unexpired, untampered token; otherwise null.
export function verifyDocumentAccessToken(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userIdStr, expStr, sig] = parts;
  const userId = Number(userIdStr);
  const exp = Number(expStr);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = createHmac("sha256", SECRET).update(`${userIdStr}.${expStr}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return userId;
}
