---
name: Google Drive connector proxy pattern
description: How to call the Replit Google Drive integration from api-server (proxy SDK, multipart upload, sandbox import gotcha)
---

Customer document uploads forward files to the admin's connected Google Drive via the
Replit **google-drive** connector, NOT raw googleapis.

- Client: `import { ReplitConnectors } from "@replit/connectors-sdk"; new ReplitConnectors().proxy("google-drive", path, opts)`.
  The proxy injects/refreshes OAuth and returns a **raw Response** — call `.text()`/`.json()`/`.ok`/`.status` yourself.
  Base maps to googleapis.com, so `path` is like `/drive/v3/files...`.
- Instantiate a fresh `ReplitConnectors` per call (the SDK handles token refresh internally; do not cache a client).
- Folder ensure: `files.list` with `q=name='..' and mimeType='application/vnd.google-apps.folder' and trashed=false and '<parent>' in parents`, reuse or create.
- Multipart upload: POST `/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink`,
  header `Content-Type: multipart/related; boundary=<b>`, body = Buffer.concat of the JSON metadata part + the file-bytes part + closing boundary. Binary Buffers forward correctly through the proxy.
- Scopes granted include broader read (docs) plus drive.file, so files.list returns existing items, not only app-created ones.

**Sandbox import gotcha:** the SDK is installed under `artifacts/api-server` (pnpm, not hoisted), so `code_execution`
(which runs from workspace root) CANNOT `await import("@replit/connectors-sdk")`. Run probe scripts from inside the
package dir instead (`cd artifacts/api-server && node probe.mjs`). This package has no `tsx`; run TS probes as a one-off
`pnpm exec vitest run <file>.test.ts`, not `tsx`.

**Why:** chosen over raw googleapis so no API key/OAuth client is managed in-app; the connector owns credentials.
