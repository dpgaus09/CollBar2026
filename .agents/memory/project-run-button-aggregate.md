---
name: Project run button aggregate
description: How the platform-managed "Project" runButton workflow aggregates agent workflows, and what you can/can't change about it.
---

The Run button maps to a platform-reserved parallel meta-workflow named **"Project"** in `.replit` (`runButton = "Project"`).

Rules observed (Replit pnpm multi-artifact repl):
- "Project" auto-aggregates **every agent leaf workflow** (each `author = "agent"` workflow) as a parallel `task = "workflow.run"`. `removeWorkflow(name)` drops that leaf AND its reference inside "Project"; `configureWorkflow(name)` (re)adds it to "Project".
- `autoStart: false` does **not** remove a workflow from the "Project" aggregate — the leaf still appears as a Project task. autoStart only controls whether it starts immediately on configure.
- "Project" **never** includes the artifact service workflows (e.g. `artifacts/collbar-web: web`, `artifacts/api-server: API Server`). Those auto-start independently of the Run button / `.replit`.
- You **cannot** edit "Project": `.replit` is write-locked, `removeWorkflow("Project")` fails ("not found" — it only sees leaf workflows), and `configureWorkflow({name:"Project"})` fails with `PROHIBITED_ACTION: "Project" is a prohibited name`.

**Consequence:** You can't have an agent workflow that is "available to run manually but excluded from the Run button." Any agent leaf workflow is part of Run. The only lever to stop a job from running on Run is to delete it as a workflow entirely (it can still be triggered another way, e.g. an API endpoint that spawns the script).

**How to apply:** If a task asks to keep pipeline jobs as workflows but exclude them from the default Run, explain this platform constraint. Best you can do is make them run-once (no `sleep infinity`) so a Run click triggers them once and they exit, rather than holding the container.
