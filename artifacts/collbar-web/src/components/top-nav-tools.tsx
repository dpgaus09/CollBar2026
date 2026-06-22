import { Lock, Sparkles, Users, Wrench } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useUpgradeLock } from "@/components/upgrade";

// ---------------------------------------------------------------------------
// Shared top-bar tool cluster (Toolkit / Ask AI / Peer Sets).
//
// Rendered identically in the dashboard home, district detail, and toolkit top
// bars so the three can't drift apart. Each tool is a pill-style button with a
// leading icon. Free customers see Ask AI and Peer Sets greyed with a lock; the
// click opens the upgrade modal instead of navigating. Visual treatment only —
// no gating/routing change. A trailing divider separates the cluster from the
// account area on the right.
// ---------------------------------------------------------------------------

const base = import.meta.env.BASE_URL;

const PILL =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors";
const PILL_ACTIVE =
  "border-slate-700 bg-slate-800/60 text-slate-200 hover:bg-slate-700 hover:text-slate-100 hover:border-slate-600";
const PILL_LOCKED =
  "border-slate-800 bg-slate-900 text-slate-600 hover:text-slate-500 cursor-not-allowed";

export function TopNavTools() {
  const { isFree } = useAuth();
  const { showUpgrade } = useUpgradeLock();

  return (
    <>
      <div className="flex items-center gap-2">
        <a href={`${base}toolkit`} className={`${PILL} ${PILL_ACTIVE}`}>
          <Wrench className="h-3.5 w-3.5" />
          Toolkit
        </a>

        {isFree ? (
          <button
            onClick={showUpgrade}
            title="Paid feature"
            className={`${PILL} ${PILL_LOCKED}`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Ask AI
            <Lock className="h-3 w-3" />
          </button>
        ) : (
          <a href={`${base}dashboard/ask`} className={`${PILL} ${PILL_ACTIVE}`}>
            <Sparkles className="h-3.5 w-3.5" />
            Ask AI
          </a>
        )}

        {isFree ? (
          <button
            onClick={showUpgrade}
            title="Paid feature"
            className={`${PILL} ${PILL_LOCKED}`}
          >
            <Users className="h-3.5 w-3.5" />
            Peer Sets
            <Lock className="h-3 w-3" />
          </button>
        ) : (
          <a href={`${base}peer-sets`} className={`${PILL} ${PILL_ACTIVE}`}>
            <Users className="h-3.5 w-3.5" />
            Peer Sets
          </a>
        )}
      </div>

      <span aria-hidden className="h-5 w-px bg-slate-700" />
    </>
  );
}
