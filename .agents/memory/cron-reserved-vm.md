---
name: Cron requires Reserved VM
description: node-cron schedule in api-server only fires when deployed as Reserved VM, not autoscale.
---

The api-server uses `node-cron` (schedule `0 7 * * *` America/Chicago) to run the ISBE directory refresh. In autoscale deployments, instances spin down between requests and the cron timer never fires.

**Why:** Autoscale Replit deployments do not keep a persistent process alive between requests. A cron job needs a continuously running process.

**How to apply:** The deployment type (autoscale vs Reserved VM) is selected in the **Replit Publishing UI**, not via `artifact.toml`. The `serve = "vm"` key is NOT a valid artifact.toml schema value (ARTIFACT_SYNTAX_ERROR). Before clicking Publish, the user must manually switch the deployment mode to **Reserved VM** in the Publishing settings. The admin panel card notes this requirement inline.
