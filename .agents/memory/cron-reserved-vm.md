---
name: Cron requires Reserved VM
description: node-cron schedule in api-server only fires when deployed as Reserved VM, not autoscale.
---

The api-server uses `node-cron` (schedule `0 7 * * *` America/Chicago) to run the ISBE directory refresh. In autoscale deployments, instances spin down between requests and the cron timer never fires.

**Why:** Autoscale Replit deployments do not keep a persistent process alive between requests. A cron job needs a continuously running process.

**How to apply:** Before deploying to production for the first time (or when enabling cron jobs), add `serve = "vm"` to the `[services.production]` section of `artifacts/api-server/.replit-artifact/artifact.toml`. The admin panel card notes this requirement inline.
