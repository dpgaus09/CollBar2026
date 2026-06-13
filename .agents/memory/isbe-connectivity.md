---
name: ISBE connectivity from repl sandbox
description: isbe.net is blocked from the Replit sandbox; the refresh script can only be tested after deployment.
---

Attempting to reach `https://www.isbe.net` from the Replit workspace times out with `ConnectTimeoutError`. This is a sandbox network restriction, not a code bug.

**Why:** Replit sandboxes restrict outbound HTTPS to certain external hosts; isbe.net is blocked.

**How to apply:** Do not try to run `12_refresh_il_directory.py` (with or without `--dry-run`) from the repl. Verify by running it manually from a deployed Reserved VM or triggering the admin "Run now" button on the production admin panel. Unit-test parsing logic separately using a locally saved XLS file.
