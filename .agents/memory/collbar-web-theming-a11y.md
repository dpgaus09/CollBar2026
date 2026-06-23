---
name: CollBar web theming & a11y surfaces
description: Why shadcn theme tokens look broken (red) but don't surface, and where real focusable UI actually lives in collbar-web.
---

# CollBar web (artifacts/collbar-web) theming & accessibility surfaces

**The shadcn/Tailwind theme tokens in `src/index.css` are placeholder `red`** (`--background`, `--accent`, `--popover`, `--muted`, `--accent-foreground`, etc., in both `:root` and `.dark`). They are NOT a bug to "fix": the app renders entirely via **hardcoded slate/blue Tailwind utility classes** (e.g. `bg-slate-900`, `text-slate-100`, `bg-blue-700`), so the red tokens never reach the screen.

**Only `--ring` / `--sidebar-ring` are real** — set to `199 89% 60%` (sky) and consumed by the global `:focus-visible { outline: 2px solid hsl(var(--ring)) }` rule in `@layer base`. That sky ring has >3:1 contrast on the slate-950/900 dark backgrounds. Touching `--ring` is safe and focus-only; do not "complete" the other tokens unless you intend a full theme — it would surface red.

**The shadcn `components/ui/*` primitives that depend on `bg-accent`/`bg-background` for focus/hover are dead code** — `dropdown-menu`, `select`, `command`, `context-menu`, `menubar`, `popover`, `hover-card`, plus `checkbox`/`radio-group`/`slider`/`switch` are **not imported anywhere in app code** (verify with `rg "from \"@/components/ui/<name>\"" -g '*.tsx' | rg -v /ui/`). So their bare `outline-none`+red-accent focus fallback and their <24px sizes never reach users. Don't spend a11y effort there.

**Real modals are hand-rolled, not shadcn `Dialog`.** For WCAG focus-trapping, the ones that matter are: `components/upgrade.tsx` (`UpgradeModal`), and `pages/peer-sets.tsx` (`BuilderModal` + the delete-confirm). These were rebuilt on `@radix-ui/react-dialog` primitives (Root/Portal/Overlay/Content/Title/Close) using `bg-slate-900` directly — NOT shadcn `DialogContent`, which would apply `bg-background` (=red). `BuilderModal` uses `onInteractOutside preventDefault` to avoid accidental form-data loss; the confirm dialog allows outside-click dismiss.

**Why:** a future agent doing design/theme/a11y work will otherwise either try to "fix" the red tokens (introducing red into the UI) or waste time editing unused `ui/*` primitives instead of the hand-rolled modals that users actually reach.

**How to apply:** for focus/contrast work, edit `--ring` and the `@layer base` rules in `index.css`. For modal/landmark/aria work, edit the page/component files and the hand-rolled modals, not `components/ui/*`. `LockedPage` (upgrade.tsx) is the gated-page render path for free users and must carry the page's single `<main>` landmark.
