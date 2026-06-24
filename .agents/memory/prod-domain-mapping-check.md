---
name: "Mods not reaching prod" = domain mapping, not a failed publish
description: First check when a user says published changes aren't live; the deployment URL vs the URL they actually view.
---

# "My mods aren't moving to production" — check the domain mapping first

A successful publish does NOT mean the user can see it at the URL they're
looking at. Before debugging the build/DB-diff, confirm *where* the live app is:

1. `getDeploymentInfo()` is authoritative. Use `primaryUrl` (the real prod URL)
   and `additionalUrls` (linked custom/extra domains). Empty `additionalUrls`
   means **no custom domain is attached**.
2. `listDeploymentBuilds()` shows whether publishes actually succeeded
   (status `success`) and when — compare to when the user last published.
3. curl the candidate URLs. A plain **HTTP 404** from a `*.replit.app` /
   custom domain means DNS reached Replit's edge but **no live deployment is
   mapped to that hostname** (a linking problem, not DNS, not a code bug).

Observed 2026-06-24: builds were succeeding and the app was current at the
deployment's `primaryUrl`, but the user's expected custom domain + the
"obvious" `*.replit.app` name both 404'd because neither was linked to the
deployment. Fix is user-side in Deployments → Settings → custom domains (needs
DNS verification); the agent cannot link a domain via tools.
