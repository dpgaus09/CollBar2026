---
name: Google Drive connector proxy pattern
description: How to call the Replit Google Drive integration from api-server (proxy SDK, the ~1MB proxy body limit, resumable direct-PUT upload, sandbox import gotcha)
---

Customer document uploads forward files to the admin's connected Google Drive via the
Replit **google-drive** connector, NOT raw googleapis.

- Client: `import { ReplitConnectors } from "@replit/connectors-sdk"; new ReplitConnectors().proxy("google-drive", path, opts)`.
  The proxy injects/refreshes OAuth and returns a **raw Response** — call `.text()`/`.json()`/`.ok`/`.status` yourself.
  Base maps to googleapis.com, so `path` is like `/drive/v3/files...`.
- Instantiate a fresh `ReplitConnectors` per call (the SDK handles token refresh internally; do not cache a client).
- Folder ensure: `files.list` with `q=name='..' and mimeType='application/vnd.google-apps.folder' and trashed=false and '<parent>' in parents`, reuse or create.
- Scopes granted include broader read (docs) plus drive.file, so files.list returns existing items, not only app-created ones.

**The proxy CANNOT carry file bytes — it is for the OAuth-authorized control plane only.**
The connector proxy edge (Cloudflare in front of replit.com) enforces an **~1 MB request-body
limit** (returns nginx **413** above ~1 MB) AND **blocks partial/resumable continuation chunks**
(returns a bare Cloudflare **403 "Forbidden"**; identifiable by `server: cloudflare` +
`set-cookie ... Domain=replit.com`). So multipart/simple single-request uploads die at 413 and
proxy-routed resumable chunking dies at 403 — neither can ship real files.

**Working upload pattern (proxy-init + direct-PUT):**
1. OPEN a resumable session **through the proxy** (needs OAuth):
   POST `/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink`,
   headers `X-Upload-Content-Type`, `X-Upload-Content-Length`, JSON body `{name, parents}`.
   Read the **`Location`** response header → the Google session URI (absolute googleapis.com URL
   with `upload_id`/`session_crd`).
2. PUT the full file bytes **DIRECTLY to that session URI via global `fetch()`, bypassing the
   proxy** (no proxy = no 1 MB cap). The session URI is a one-time capability that self-authorizes,
   so **no Authorization header** is needed. A single PUT handles the whole file (verified to 32 MB).
   Validate the URI is `https://*.googleapis.com/` before the direct PUT (SSRF defense).
- Direct-to-Google has no proxy limits, so a single PUT is fine for the 32 MB submit cap; only add
  Content-Range chunking/resume if the cap grows large enough that a single PUT becomes fragile.

**Sandbox import gotcha:** the SDK is installed under `artifacts/api-server` (pnpm, not hoisted), so `code_execution`
(which runs from workspace root) CANNOT `await import("@replit/connectors-sdk")`. Run probe scripts from inside the
package dir instead (`cd artifacts/api-server && node probe.mjs`). This package has no `tsx`, but Node 24 runs
`.ts` files directly via type-stripping — name a one-off probe `probe.ts` and run `node probe.ts` to import real
`.ts` modules (e.g. exercising the exported upload helper end-to-end).

**Why:** chosen over raw googleapis so no API key/OAuth client is managed in-app; the connector owns credentials.
