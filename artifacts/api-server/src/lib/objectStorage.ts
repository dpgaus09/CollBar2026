import { Storage } from "@google-cloud/storage";
import type { File } from "@google-cloud/storage";

// Replit Object Storage (App Storage) — GCS-backed, authenticated via the
// Replit sidecar. Uploaded CBA PDFs are persisted here so they survive across
// deployments and stateless autoscale instances (the local filesystem does
// not). Do NOT change the credentials block — it is the Replit sidecar setup.
const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function getPrivateObjectDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR not set — object storage is not provisioned.",
    );
  }
  return dir;
}

// Split "/<bucket>/<object/path>" into its bucket and object-name parts.
function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  if (parts.length < 3) {
    throw new Error("Invalid object path: must contain a bucket name");
  }
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

// Resolve a logical key (e.g. "il_cba/<hash>.pdf") to a GCS File handle under
// the bucket's private object dir.
function fileForKey(key: string): File {
  let dir = getPrivateObjectDir();
  if (!dir.endsWith("/")) dir = `${dir}/`;
  const { bucketName, objectName } = parseObjectPath(`${dir}${key}`);
  return objectStorageClient.bucket(bucketName).file(objectName);
}

// The deterministic object key for an uploaded CBA PDF, derived from its
// content hash. The admin upload route, the backfill migration, and the
// document-serving route all use this same convention. The hash is validated as
// a 64-char hex SHA-256 so a malformed DB value can never resolve to an
// unexpected object path.
export function uploadedCbaKey(fileHash: string): string {
  if (!/^[0-9a-f]{64}$/i.test(fileHash)) {
    throw new Error(`Invalid file hash for object key: ${fileHash}`);
  }
  return `il_cba/${fileHash}.pdf`;
}

export async function objectExists(key: string): Promise<boolean> {
  const [exists] = await fileForKey(key).exists();
  return exists;
}

export async function uploadBuffer(
  key: string,
  buf: Buffer,
  contentType = "application/pdf",
): Promise<void> {
  await fileForKey(key).save(buf, {
    contentType,
    metadata: { contentType },
  });
}

// Download an object's full bytes into a Buffer. Returns null (instead of
// throwing) when the object does not exist, so callers can fall back to a
// local copy. Used by the extraction engine to fetch a source PDF before
// rendering it for vision extraction.
export async function downloadBuffer(key: string): Promise<Buffer | null> {
  const file = fileForKey(key);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [buf] = await file.download();
  return buf;
}

// Stream an object to an Express response. Returns false (without writing a
// body) when the object does not exist, so the caller can fall back / 404.
// `disposition` is the full Content-Disposition value (default inline); pass an
// `attachment; filename="..."` value to force a download.
export async function streamObjectTo(
  key: string,
  res: import("express").Response,
  contentType = "application/pdf",
  disposition = "inline",
): Promise<boolean> {
  const file = fileForKey(key);
  const [exists] = await file.exists();
  if (!exists) return false;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", disposition);
  try {
    const [metadata] = await file.getMetadata();
    if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
  } catch {
    // metadata is best-effort; streaming still works without Content-Length.
  }
  await new Promise<void>((resolve, reject) => {
    file
      .createReadStream()
      .on("error", reject)
      .on("end", resolve)
      .pipe(res);
  });
  return true;
}

// Build a safe RFC-6266 Content-Disposition attachment header. The ASCII
// fallback filename is sanitized and a UTF-8 filename* is included so names with
// non-ASCII characters survive. Used by the work-product export download route.
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
