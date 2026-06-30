// ---------------------------------------------------------------------------
// Google Drive helper for customer document submissions.
//
// Uses the Replit Google Drive connector (integration id "google-drive") via the
// @replit/connectors-sdk proxy, which injects OAuth credentials and refreshes
// tokens automatically. Customer-uploaded salary schedules and CBA PDFs are
// forwarded to the connected (admin's) Google Drive, into a
// "CollBar Customer Submissions" folder with one subfolder per district. The
// admin reviews them there and loads good files via the admin upload tool.
// ---------------------------------------------------------------------------

import { ReplitConnectors } from "@replit/connectors-sdk";

const ROOT_FOLDER_NAME = "CollBar Customer Submissions";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface CustomerSubmission {
  districtId: number;
  districtName: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
}

export interface UploadResult {
  fileId: string;
  name: string;
  webViewLink?: string | null;
}

export class DriveNotConnectedError extends Error {
  constructor(message = "Google Drive is not connected") {
    super(message);
    this.name = "DriveNotConnectedError";
  }
}

// Minimal shape of the fetch-like Response the connector proxy returns.
interface ProxyResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// Connector-proxy rate limiting + 429 retry.
//
// The Replit connector proxy caps Drive calls at ~10 requests/sec per repl. A
// wide folder scan (listFolderTree fans out one listFolderChildren call per
// district subfolder — hundreds of them) otherwise bursts past that cap and the
// proxy returns HTTP 429 ("Rate limit exceeded: 11/10 RPS for repl"). We (a)
// space every proxy call at least MIN_PROXY_INTERVAL_MS apart via a global gate,
// keeping the steady-state rate safely under the cap regardless of caller
// concurrency, and (b) retry a transient 429 honoring its Retry-After hint.
// ---------------------------------------------------------------------------

const MIN_PROXY_INTERVAL_MS = 130; // ~7.7 req/s, headroom under the ~10 RPS cap
const MAX_429_RETRIES = 5;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A process-global serialized chain so concurrent callers (e.g. a preview and an
// ingest running at once) share one rate budget rather than each getting their
// own.
let proxyGateChain: Promise<void> = Promise.resolve();
let lastProxyReleaseAt = 0;

/**
 * Block until at least MIN_PROXY_INTERVAL_MS has elapsed since the previous
 * proxy call was released. Serializing the gate (not the request) means N
 * concurrent workers start their requests staggered by the interval, so the
 * aggregate request rate stays under the proxy cap whatever the concurrency.
 */
async function rateLimitGate(): Promise<void> {
  const run = async (): Promise<void> => {
    const wait = lastProxyReleaseAt + MIN_PROXY_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastProxyReleaseAt = Date.now();
  };
  const next = proxyGateChain.then(run, run);
  proxyGateChain = next.catch(() => {});
  await next;
}

/**
 * Parse a Retry-After header value to milliseconds. Supports both the
 * delta-seconds form ("1") and the HTTP-date form. Returns null when absent or
 * unparseable so callers fall back to exponential backoff.
 */
export function parseRetryAfterMs(
  value: string | null,
  now: number = Date.now(),
): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - now);
  return null;
}

interface RetryableResponse {
  status: number;
  headers: { get(name: string): string | null };
  text?: () => Promise<string>;
}

/**
 * Run a proxy call behind the rate-limit gate, retrying a 429 up to maxRetries
 * times (honoring Retry-After, else exponential backoff). Non-429 responses —
 * and any thrown error, including DriveNotConnectedError — pass straight
 * through. The gate/sleep are injectable so the retry logic can be unit-tested
 * without real timers.
 */
export async function callWithRateLimitRetry<T extends RetryableResponse>(
  fn: () => Promise<T>,
  opts: {
    maxRetries?: number;
    sleepFn?: (ms: number) => Promise<void>;
    gate?: () => Promise<void>;
  } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_429_RETRIES;
  const sleepFn = opts.sleepFn ?? sleep;
  const gate = opts.gate ?? rateLimitGate;
  for (let attempt = 0; ; attempt++) {
    await gate();
    const res = await fn();
    if (res.status === 429 && attempt < maxRetries) {
      const fromHeader = parseRetryAfterMs(res.headers.get("retry-after"));
      const backoff = Math.min(
        DEFAULT_RETRY_AFTER_MS * 2 ** attempt,
        MAX_RETRY_AFTER_MS,
      );
      const waitMs = Math.min(fromHeader ?? backoff, MAX_RETRY_AFTER_MS);
      // Drain the rejected body so the underlying connection can be reused.
      if (res.text) await res.text().catch(() => undefined);
      await sleepFn(waitMs);
      continue;
    }
    return res;
  }
}

/**
 * Low-level call through the connector proxy. Returns the raw response so
 * callers can inspect status and headers (needed for resumable uploads, which
 * rely on a 308 status and a Location header). Throws DriveNotConnectedError
 * only when the SDK itself can't find usable credentials. Rate-limited and
 * 429-retried via callWithRateLimitRetry.
 */
async function driveProxy(
  connectors: ReplitConnectors,
  path: string,
  options: Record<string, unknown> = {},
): Promise<ProxyResponse> {
  return callWithRateLimitRetry<ProxyResponse>(async () => {
    try {
      return (await connectors.proxy("google-drive", path, options as never)) as never;
    } catch (e) {
      // The SDK throws when there is no usable connection/credentials.
      throw new DriveNotConnectedError((e as Error)?.message);
    }
  });
}

/**
 * Run a Drive API request through the connector proxy and parse its JSON body.
 * Throws a DriveNotConnectedError for auth/connection problems (so callers can
 * surface a "not connected" message) and a generic Error for other API
 * failures.
 */
async function driveApi(
  connectors: ReplitConnectors,
  path: string,
  options: Record<string, unknown> = {},
): Promise<any> {
  const res = await driveProxy(connectors, path, options);
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new DriveNotConnectedError(`Google Drive auth failed (HTTP ${res.status})`);
    }
    throw new Error(`Google Drive API error (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function findFolder(
  connectors: ReplitConnectors,
  name: string,
  parentId: string | null,
): Promise<string | null> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const clauses = [
    `name='${escaped}'`,
    `mimeType='${FOLDER_MIME}'`,
    "trashed=false",
    parentId ? `'${parentId}' in parents` : null,
  ].filter(Boolean);
  const q = clauses.join(" and ");
  const data = await driveApi(
    connectors,
    `/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`,
    { method: "GET" },
  );
  return data.files?.[0]?.id ?? null;
}

async function createFolder(
  connectors: ReplitConnectors,
  name: string,
  parentId: string | null,
): Promise<string> {
  const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  const data = await driveApi(connectors, "/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data.id;
}

async function ensureFolder(
  connectors: ReplitConnectors,
  name: string,
  parentId: string | null,
): Promise<string> {
  const existing = await findFolder(connectors, name, parentId);
  if (existing) return existing;
  return createFolder(connectors, name, parentId);
}

// Google-issued resumable session URIs always live under *.googleapis.com.
// We PUT file bytes directly to that host (not through the proxy), so validate
// the URI before making the request as defense-in-depth against SSRF.
const GOOGLE_UPLOAD_HOST = /^https:\/\/[a-z0-9.-]+\.googleapis\.com\//i;

/**
 * Upload file bytes via Google's resumable protocol.
 *
 * The session is OPENED through the connector proxy (which injects OAuth), but
 * the file bytes are PUT DIRECTLY to the Google-issued session URI, bypassing
 * the proxy. This is required: the connector proxy caps request bodies at ~1 MB
 * (returns 413 above that) and blocks partial/resumable continuation chunks
 * (returns 403), so real-world files can't be sent through it. The session URI
 * is a one-time capability that authorizes the upload on its own, so the direct
 * PUT needs no Authorization header. Returns the created file's metadata.
 */
async function uploadResumable(
  connectors: ReplitConnectors,
  parentId: string,
  submission: CustomerSubmission,
): Promise<{ id: string; name: string; webViewLink?: string | null }> {
  const total = submission.content.length;
  const mimeType = submission.mimeType || "application/octet-stream";

  // 1. Open the resumable session through the proxy (needs OAuth). Google
  //    returns the upload URI in the Location response header.
  const initRes = await driveProxy(
    connectors,
    "/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(total),
      },
      body: JSON.stringify({ name: submission.fileName, parents: [parentId] }),
    },
  );
  if (initRes.status === 401 || initRes.status === 403) {
    throw new DriveNotConnectedError(`Google Drive auth failed (HTTP ${initRes.status})`);
  }
  if (!initRes.ok) {
    const t = await initRes.text();
    throw new Error(`Google Drive API error (HTTP ${initRes.status}): ${t.slice(0, 300)}`);
  }
  const sessionUri = initRes.headers.get("location") || initRes.headers.get("Location");
  await initRes.text().catch(() => undefined); // drain the init response body
  if (!sessionUri || !GOOGLE_UPLOAD_HOST.test(sessionUri)) {
    throw new Error("Google Drive did not return a valid resumable upload session URI");
  }

  // 2. PUT the full content directly to the Google session URI (no proxy, so no
  //    body-size limit). A single request is fine for our 32 MB cap.
  const res = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(total),
    },
    body: submission.content,
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`Google Drive upload failed (HTTP ${res.status}): ${txt.slice(0, 300)}`);
  }
  return JSON.parse(txt);
}

// ---------------------------------------------------------------------------
// Bulk CBA import (Task #199): list a Drive folder tree and download file bytes
// for server-side ingestion. Listing is a control-plane operation (small JSON)
// and goes through the connector proxy. File DOWNLOADS go DIRECT to
// *.googleapis.com with a short-lived OAuth access token, because the proxy is
// OAuth control-plane only and 413s on large bodies (same reason uploads PUT
// direct to the session URI). The token is fetched from the connector's
// include_secrets connection endpoint and cached briefly; a 401 forces a
// refresh. Tokens are never logged.
// ---------------------------------------------------------------------------

const GOOGLE_DOWNLOAD_HOST = /^https:\/\/[a-z0-9.-]+\.googleapis\.com\//i;
// A Drive file/folder id is an opaque base64url-ish string. Validate before
// interpolating into an API path as defense-in-depth (no traversal / injection).
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
// Cap a single downloaded file. Matches the single-upload route's 64 MB ceiling.
const MAX_DRIVE_FILE_BYTES = 64 * 1024 * 1024;
// Safety caps for a folder crawl so a pathological tree can't run unbounded.
const MAX_TREE_FILES = 20000;
const MAX_TREE_DEPTH = 12;

export const FOLDER_MIME_TYPE = FOLDER_MIME;
export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Byte size as reported by Drive (absent for Google-native files). */
  size: number | null;
  md5Checksum: string | null;
  modifiedTime: string | null;
  /** Names of the ancestor folders under the root, e.g. ["Adams CUSD 1"]. */
  parentPath: string[];
}

export interface DriveFolderTree {
  files: DriveFile[];
  /** True when the crawl hit MAX_TREE_FILES and stopped early. */
  truncated: boolean;
}

/** Accept either a raw Drive id or a full Drive folder URL and return the id. */
export function parseDriveFolderId(input: string): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (DRIVE_ID_RE.test(s)) return s;
  // https://drive.google.com/drive/folders/<id>?... or .../folders/<id>
  const m =
    /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) ||
    /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s) ||
    /\/d\/([A-Za-z0-9_-]{10,})/.exec(s);
  return m ? m[1] : null;
}

let cachedToken: { value: string; fetchedAt: number } | null = null;
// Google OAuth access tokens live ~60 min; refresh ours well before that.
const TOKEN_SOFT_TTL_MS = 45 * 60 * 1000;

/**
 * Fetch a Google Drive OAuth access token from the connector's connection
 * endpoint (include_secrets). Cached in-process with a soft TTL; pass
 * { force: true } to bypass the cache after a 401. Never log the return value.
 */
export async function getDriveAccessToken(
  connectors: ReplitConnectors,
  opts: { force?: boolean } = {},
): Promise<string> {
  if (
    !opts.force &&
    cachedToken &&
    Date.now() - cachedToken.fetchedAt < TOKEN_SOFT_TTL_MS
  ) {
    return cachedToken.value;
  }
  const proxyUrl = connectors.getProxyUrl(); // `${baseUrl}/api/v2/proxy`
  const baseUrl = proxyUrl.replace(/\/api\/v2\/proxy$/, "");
  const headers = await connectors.getProxyHeaders("google-drive");
  const url = `${baseUrl}/api/v2/connection?include_secrets=true&connector_names=google-drive`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new DriveNotConnectedError(
      `Could not fetch Google Drive credentials (HTTP ${res.status})`,
    );
  }
  const data = (await res.json()) as {
    items?: Array<{
      settings?: {
        access_token?: string;
        oauth?: { credentials?: { access_token?: string } };
      };
    }>;
  };
  const s = data.items?.[0]?.settings;
  const token = s?.access_token || s?.oauth?.credentials?.access_token;
  if (!token) {
    throw new DriveNotConnectedError("Google Drive connection has no access token");
  }
  cachedToken = { value: token, fetchedAt: Date.now() };
  return token;
}

/** List the immediate children (files + folders) of one Drive folder. */
async function listFolderChildren(
  connectors: ReplitConnectors,
  folderId: string,
): Promise<Array<Omit<DriveFile, "parentPath">>> {
  const out: Array<Omit<DriveFile, "parentPath">> = [];
  let pageToken: string | undefined;
  const q = `'${folderId}' in parents and trashed=false`;
  do {
    const params = new URLSearchParams({
      q,
      fields:
        "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await driveApi(
      connectors,
      `/drive/v3/files?${params.toString()}`,
      { method: "GET" },
    );
    for (const f of (data.files ?? []) as Array<Record<string, unknown>>) {
      out.push({
        id: String(f.id),
        name: String(f.name ?? ""),
        mimeType: String(f.mimeType ?? ""),
        size: f.size != null ? Number(f.size) : null,
        md5Checksum: f.md5Checksum != null ? String(f.md5Checksum) : null,
        modifiedTime: f.modifiedTime != null ? String(f.modifiedTime) : null,
      });
    }
    pageToken = data.nextPageToken ? String(data.nextPageToken) : undefined;
  } while (pageToken);
  return out;
}

/**
 * Recursively list every non-folder file under `rootFolderId`, recording each
 * file's ancestor folder names (parentPath). Bounded by MAX_TREE_FILES and
 * MAX_TREE_DEPTH so a pathological tree cannot run unbounded.
 */
export async function listFolderTree(rootFolderId: string): Promise<DriveFolderTree> {
  if (!DRIVE_ID_RE.test(rootFolderId)) {
    throw new Error("Invalid Drive folder id");
  }
  const connectors = new ReplitConnectors();
  const files: DriveFile[] = [];
  let truncated = false;
  const seen = new Set<string>([rootFolderId]);
  // Process the tree level-by-level, fetching each level's folders with bounded
  // concurrency. A flat folder is one wave; a folder-per-district layout (~850
  // folders) drains in a few seconds instead of ~850 serial proxy calls, which
  // would otherwise risk the deployment's ~300s request cap.
  let level: Array<{ id: string; path: string[] }> = [{ id: rootFolderId, path: [] }];
  let depth = 0;
  while (level.length && depth <= MAX_TREE_DEPTH && !truncated) {
    // Bounded concurrency caps in-flight requests; the actual request RATE is
    // governed by the proxy rate-limit gate inside driveProxy, so a wide level
    // can't burst past the connector proxy's ~10 RPS-per-repl cap.
    const childrenByFolder = await mapWithConcurrency(level, 4, (f) =>
      listFolderChildren(connectors, f.id),
    );
    const nextLevel: Array<{ id: string; path: string[] }> = [];
    for (let i = 0; i < level.length; i++) {
      const path = level[i].path;
      for (const c of childrenByFolder[i]) {
        if (c.mimeType === FOLDER_MIME) {
          if (seen.has(c.id)) continue; // guard against shortcut cycles
          seen.add(c.id);
          nextLevel.push({ id: c.id, path: [...path, c.name] });
          continue;
        }
        if (files.length >= MAX_TREE_FILES) {
          truncated = true;
          break;
        }
        files.push({ ...c, parentPath: path });
      }
      if (truncated) break;
    }
    level = nextLevel;
    depth++;
  }
  return { files, truncated };
}

/** Run an async mapper over items with bounded concurrency, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Download a Drive file's bytes DIRECTLY from googleapis (bypassing the proxy).
 * Refreshes the access token once on a 401. Enforces MAX_DRIVE_FILE_BYTES.
 */
export async function downloadDriveFile(fileId: string): Promise<Buffer> {
  if (!DRIVE_ID_RE.test(fileId)) {
    throw new Error("Invalid Drive file id");
  }
  const connectors = new ReplitConnectors();
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  if (!GOOGLE_DOWNLOAD_HOST.test(url)) {
    throw new Error("Refusing to download from a non-googleapis host");
  }
  const fetchOnce = async (token: string): Promise<Response> =>
    fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  let token = await getDriveAccessToken(connectors);
  let res = await fetchOnce(token);
  if (res.status === 401) {
    token = await getDriveAccessToken(connectors, { force: true });
    res = await fetchOnce(token);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new DriveNotConnectedError(`Google Drive download auth failed (HTTP ${res.status})`);
    }
    throw new Error(`Google Drive download failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const lenHeader = res.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_DRIVE_FILE_BYTES) {
    throw new Error(`File exceeds ${MAX_DRIVE_FILE_BYTES} byte limit`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DRIVE_FILE_BYTES) {
    throw new Error(`File exceeds ${MAX_DRIVE_FILE_BYTES} byte limit`);
  }
  return buf;
}

/**
 * Export a native Google Sheet to CSV bytes (direct googleapis, token auth).
 * Used to read a mapping spreadsheet that the admin authored as a Google Sheet.
 */
export async function exportGoogleSheetCsv(fileId: string): Promise<string> {
  if (!DRIVE_ID_RE.test(fileId)) {
    throw new Error("Invalid Drive file id");
  }
  const connectors = new ReplitConnectors();
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent("text/csv")}`;
  const fetchOnce = async (token: string): Promise<Response> =>
    fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let token = await getDriveAccessToken(connectors);
  let res = await fetchOnce(token);
  if (res.status === 401) {
    token = await getDriveAccessToken(connectors, { force: true });
    res = await fetchOnce(token);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Sheet export failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  return res.text();
}

/**
 * Upload a single customer document into the per-district subfolder of the
 * "CollBar Customer Submissions" Drive folder.
 */
export async function uploadCustomerSubmission(
  submission: CustomerSubmission,
): Promise<UploadResult> {
  const connectors = new ReplitConnectors();

  const rootId = await ensureFolder(connectors, ROOT_FOLDER_NAME, null);

  const safeDistrict = `${submission.districtId} — ${submission.districtName}`
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  const districtFolderId = await ensureFolder(connectors, safeDistrict, rootId);

  const uploaded = await uploadResumable(connectors, districtFolderId, submission);

  return {
    fileId: uploaded.id,
    name: uploaded.name,
    webViewLink: uploaded.webViewLink ?? null,
  };
}
