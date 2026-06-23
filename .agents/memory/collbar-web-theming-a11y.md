---
name: CollBar web theming & a11y surfaces
description: Non-obvious gotchas when doing theme/design/accessibility work in artifacts/collbar-web.
---

# CollBar web (artifacts/collbar-web) theming & a11y gotchas

- **The shadcn theme tokens in `index.css` are placeholder `red` by design, not a bug.** The app renders entirely via hardcoded slate/blue Tailwind classes, so those tokens never surface. Do NOT "complete" them — it would inject red into the UI. Only `--ring`/`--sidebar-ring` (focus ring) are wired up and safe to change. **Why:** a future agent will otherwise try to fix the red and break the look.

- **The sky focus ring (`--ring`) is tuned for the dark slate UI** and is borderline (<3:1) on light backgrounds. The app is dark everywhere except `not-found.tsx` (light, but no focusable elements). If you add a light-background page with interactive controls, the ring needs rework.

- **Skip-link (App.tsx) must focus the page's `<main>`, not an app-shell wrapper.** Each page renders its own single `<main>` *after* its nav, so a wrapper around the whole router does NOT bypass nav. The skip link programmatically focuses `document.querySelector("main")` (sets tabindex=-1 + .focus()) because fragment-only navigation is unreliable. Keep every page's one-and-only `<main>`.

- **Real modals are hand-rolled, not shadcn `Dialog`** (UpgradeModal in upgrade.tsx; BuilderModal + delete-confirm in peer-sets.tsx). For focus-trap/Escape/restore work, edit those, built on `@radix-ui/react-dialog` primitives with `bg-slate-900` directly (shadcn `DialogContent` would apply the red `bg-background`). The shadcn `components/ui/*` primitives that rely on accent/background tokens are not imported in app code — don't spend a11y effort there.
