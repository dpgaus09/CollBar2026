export function apiUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}

// Build a browser-openable href for a document source. Locally-stored uploads
// use an 'upload://' scheme the browser can't render, so route those through the
// API, which streams the stored PDF. Real http(s) URLs (crawled docs) are linked
// directly. A page ref becomes a #page=N fragment honoured by the PDF viewer.
export function sourceHref(
  sourceUrl?: string | null,
  pageRef?: number | null,
): string | null {
  if (!sourceUrl) return null;
  const hash = pageRef != null ? `#page=${pageRef}` : "";
  if (sourceUrl.startsWith("upload://")) {
    return `${apiUrl("api/dashboard/document")}?src=${encodeURIComponent(
      sourceUrl,
    )}${hash}`;
  }
  return `${sourceUrl}${hash}`;
}
