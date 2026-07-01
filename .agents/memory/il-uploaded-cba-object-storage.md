---
name: Uploaded CBA PDFs must live in Object Storage
description: Why uploaded CBA PDFs are served from Replit Object Storage, not local disk, and the upload invariant that keeps prod links working.
---

# Uploaded CBA PDFs → Replit Object Storage

Uploaded CBA PDFs (`source_documents` rows with `source_url LIKE 'upload://%'`) are
served to the customer dashboard via `GET /dashboard/document?src=upload://...`.

**Rule:** the durable copy lives in Replit Object Storage (GCS App Storage, via the
Replit sidecar), keyed `il_cba/<file_hash>.pdf` (`uploadedCbaKey`). Once past the
`storage_key` gate the serving route streams from object storage by `file_hash`
FIRST; the local `storage_key` (`local:<absPath>`) is only a dev fallback.

**Serving gate (subtle):** the serving routes (`dashboard.ts`, `firm-compare.ts`)
404 (`"Document not found"`) when `source_documents.storage_key` IS NULL *before*
they ever try object storage by `file_hash`. So a NULL `storage_key` breaks the
source link even when the bytes are present in the bucket. Any ingest path that
writes bytes to object storage MUST also set/backfill a non-NULL `storage_key`
(e.g. `linkUploadedCba` backfills it on its dedup paths), and an import
precondition can safely use `storage_key != NULL` as the "servable" signal.

**Why:** the local filesystem under `pipeline/data/il_cba/` is dev-only — it is
excluded from the deploy image (`.replitignore`) AND ephemeral on autoscale. A row
whose only copy is `local:` returns `{"error":"Document file missing"}` in prod.
This was a recurring production bug.

**How to apply:**
- The admin upload route MUST treat the object-storage write as a required
  precondition. If `uploadBuffer` fails, return an error and DO NOT insert the
  `source_documents` row — never persist a doc you cannot serve in prod.
- `storage_key` intentionally stays `local:` so the dev Python extractor
  (`resolve_pdf_path`) keeps working unchanged; do not repurpose it for the object
  key.
- The bucket is shared between dev and prod, so backfilling/uploading from dev
  immediately makes objects readable by prod — but prod still needs a redeploy to
  pick up new serving code.
- `uploadedCbaKey` validates a 64-char hex hash; pass real SHA-256 hashes only.

**Backfilling / one-off object-storage scripts:** the `code_execution` sandbox
resolves modules from the workspace root and CANNOT import `@google-cloud/storage`
(it's only under `artifacts/api-server/node_modules`). Run a standalone `.mjs`
script located inside `artifacts/api-server/` (e.g. `node artifacts/api-server/x.mjs`)
so Node resolves the dep from that package. The sandbox also does not expose
`process.env`, so read env-driven config (e.g. `PRIVATE_OBJECT_DIR`) from the
real shell/node process, not the sandbox.
