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

/**
 * Low-level call through the connector proxy. Returns the raw response so
 * callers can inspect status and headers (needed for resumable uploads, which
 * rely on a 308 status and a Location header). Throws DriveNotConnectedError
 * only when the SDK itself can't find usable credentials.
 */
async function driveProxy(
  connectors: ReplitConnectors,
  path: string,
  options: Record<string, unknown> = {},
): Promise<ProxyResponse> {
  try {
    return (await connectors.proxy("google-drive", path, options as never)) as never;
  } catch (e) {
    // The SDK throws when there is no usable connection/credentials.
    throw new DriveNotConnectedError((e as Error)?.message);
  }
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
