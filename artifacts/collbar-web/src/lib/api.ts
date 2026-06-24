export function apiUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}

// Short-lived signed token that authenticates document-PDF links opened in a
// new top-level tab, where the cross-site iframe session cookie is not sent.
// Supplied by /api/auth/me and refreshed on every auth poll (see use-auth).
let documentToken: string | null = null;
export function setDocumentToken(token: string | null | undefined): void {
  documentToken = token ?? null;
}

// Build a browser-openable href for a document source. Locally-stored uploads
// use an 'upload://' scheme the browser can't render, so route those through the
// API, which streams the stored PDF. Real http(s) URLs (crawled docs) are linked
// directly. A page ref becomes a #page=N fragment honoured by the PDF viewer.
//
// upload:// links open in a NEW top-level tab and so cannot rely on the session
// cookie (SameSite=Lax, partitioned inside the Replit preview iframe). We embed
// the signed document token so the request authenticates itself; the server
// still re-applies the per-district access checks.
export function sourceHref(
  sourceUrl?: string | null,
  pageRef?: number | null,
): string | null {
  if (!sourceUrl) return null;
  const hash = pageRef != null ? `#page=${pageRef}` : "";
  if (sourceUrl.startsWith("upload://")) {
    const params = new URLSearchParams({ src: sourceUrl });
    if (documentToken) params.set("token", documentToken);
    return `${apiUrl("api/dashboard/document")}?${params.toString()}${hash}`;
  }
  return `${sourceUrl}${hash}`;
}
