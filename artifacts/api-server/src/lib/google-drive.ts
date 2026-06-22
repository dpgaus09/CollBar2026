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

/**
 * Run a Drive API request through the connector proxy. Throws a
 * DriveNotConnectedError for auth/connection problems (so callers can surface a
 * "not connected" message) and a generic Error for other API failures.
 */
async function driveApi(
  connectors: ReplitConnectors,
  path: string,
  options: Record<string, unknown> = {},
): Promise<any> {
  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    res = (await connectors.proxy("google-drive", path, options as never)) as never;
  } catch (e) {
    // The SDK throws when there is no usable connection/credentials.
    throw new DriveNotConnectedError((e as Error)?.message);
  }
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

  const boundary = "collbar_boundary_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: submission.fileName, parents: [districtFolderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(meta),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${submission.mimeType}\r\n\r\n`),
    submission.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const uploaded = await driveApi(
    connectors,
    "/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );

  return {
    fileId: uploaded.id,
    name: uploaded.name,
    webViewLink: uploaded.webViewLink ?? null,
  };
}
