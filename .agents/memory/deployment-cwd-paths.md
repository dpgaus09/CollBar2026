---
name: Deployment CWD vs dev CWD for repo-root paths
description: Why process.cwd()-relative paths to the repo-root pipeline/ dir break only in the published deployment, and how to resolve them safely.
---

In the **published deployment**, the API server process runs with CWD = the
workspace root (`/home/runner/workspace`). In **dev**, pnpm runs the same package
from its own dir (`artifacts/api-server`). So a path built as
`join(process.cwd(), "..", "..", "pipeline", ...)` resolves correctly in dev but
becomes `/home/pipeline` (nonexistent) in prod.

**Why:** this caused the user-reported failure
`python3: can't open file '/home/pipeline/06_extract_contracts.py'` when the admin
"Upload CBA" / retry-extraction routes spawned the Python pipeline.

**How to apply:** resolve repo-root resources (the `pipeline/` dir and its
state/data/log files) by walking *up* from `process.cwd()` until a known anchor
exists (e.g. a dir containing `pipeline/06_extract_contracts.py`), with an env
override (`COLLBAR_PIPELINE_DIR`) and a last-resort fallback. Never assume the CWD
is the package dir. Same caution applies to any other repo-root path the API server
reads/spawns.
