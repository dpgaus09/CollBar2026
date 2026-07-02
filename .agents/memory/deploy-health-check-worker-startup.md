---
name: Deploy health-check vs boot-time extraction load
description: Why an always-on (Reserved VM) publish can fail at the promote/health-check phase when the extraction worker starts heavy work on boot, and the startup-grace-delay fix.
---

An always-on deploy (Reserved VM / `gce`) can FAIL at the **promote/health-check** phase even though the build compiled fine.

**Signature:** build logs end at `Waiting for deployment to be ready` then the build is marked `failed`; `getDeploymentInfo` shows `isDeployed:true, hasSuccessfulBuild:false`; no runtime logs captured (the failed VM is torn down). This is NOT a compile error — the image built and the VM was created.

**Root cause:** the in-process extraction worker (`worker.ts`) starts right after `app.listen`. With a non-empty queue it immediately claims a job and runs heavy mupdf PDF render (~150 DPI) + Claude Vision. On a small VM (e.g. `e2-small` 0.5 vCPU / 2 GB) this starves the single-core event loop and/or OOMs the process, so the trivial `/api/healthz` probe never gets a stable 200 within the promote window → publish fails. Earlier publishes of the SAME code succeeded only because the queue was empty then (empty queue → worker idles at boot → probe passes instantly).

**Fix (two halves, BOTH needed):**
1. Code: production-only **startup grace delay** before the worker claims any jobs (`EXTRACTION_WORKER_STARTUP_DELAY_MS`, default 60s in prod, 0 in dev/test). Placed at the top of `runLoop`, interruptible in `POLL_INTERVAL_MS` chunks so shutdown isn't blocked. Lets the deploy go live before extraction load hits.
2. Infra: size the Reserved VM adequately (≥2 vCPU / ≥4 GB). The delay only DEFERS the load; a too-small VM still OOM/crash-loops after go-live. VM size is chosen in the Publishing UI, not in code.

**Why:** switching Autoscale→Reserved VM to let the worker run is exactly what can block the publish if the box is tiny and the queue is full.

**How to apply:** if a VM publish stalls at `Waiting for deployment to be ready`, suspect boot-time background work vs the health probe BEFORE suspecting a build error. Zero-code bridge for one publish: set `EXTRACTION_WORKER_DISABLED=1` or pause extraction via the admin flag before publishing, then re-enable/resume after go-live.
