import { Lock, Sparkles, UploadCloud, Users, Wrench } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useUpgradeLock } from "@/components/upgrade";

// ---------------------------------------------------------------------------
// Shared top-bar tool cluster (Toolkit / Ask AI / Peer Sets / Submit Docs).
//
// Rendered identically in the dashboard home, district detail, toolkit, and
// submit top bars so they can't drift apart. Each tool is a pill-style button
// with a leading icon. Free customers see Ask AI and Peer Sets greyed with a
// lock; the click opens the upgrade modal instead of navigating. Submit Docs is
// not paid-gated and shows only for accounts linked to a district. Visual
// treatment only — no gating/routing change. A trailing divider separates the
// cluster from the account area on the right.
//
// Responsive: on narrow widths the pill text labels collapse to icon-only so
// the cluster doesn't push the account controls off-screen; full labels return
// at `lg` and up. Because the visible text disappears, every pill carries an
// explicit `aria-label` so screen-reader users always get a name, and the pill
// keeps a >=24px hit area (min-h-7) to satisfy Target Size (Minimum, 2.5.8).
// ---------------------------------------------------------------------------

const base = import.meta.env.BASE_URL;

const PILL =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 min-h-7 text-xs font-medium transition-colors lg:px-3";
const PILL_ACTIVE =
  "border-slate-700 bg-slate-800/60 text-slate-200 hover:bg-slate-700 hover:text-slate-100 hover:border-slate-600";
const PILL_LOCKED =
  "border-slate-800 bg-slate-900 text-slate-600 hover:text-slate-500 cursor-not-allowed";
const LABEL = "hidden lg:inline";

export function TopNavTools() {
  const { isFree, districtId } = useAuth();
  const { showUpgrade } = useUpgradeLock();

  return (
    <>
      <div className="flex items-center gap-1.5 lg:gap-2">
        <a
          href={`${base}toolkit`}
          title="Toolkit"
          aria-label="Toolkit"
          className={`${PILL} ${PILL_ACTIVE}`}
        >
          <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
          <span className={LABEL}>Toolkit</span>
        </a>

        {isFree ? (
          <button
            onClick={showUpgrade}
            title="Ask AI · Paid feature"
            aria-label="Ask AI (paid feature)"
            className={`${PILL} ${PILL_LOCKED}`}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            <span className={LABEL}>Ask AI</span>
            <Lock className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : (
          <a
            href={`${base}dashboard/ask`}
            title="Ask AI"
            aria-label="Ask AI"
            className={`${PILL} ${PILL_ACTIVE}`}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            <span className={LABEL}>Ask AI</span>
          </a>
        )}

        {isFree ? (
          <button
            onClick={showUpgrade}
            title="Peer Sets · Paid feature"
            aria-label="Peer Sets (paid feature)"
            className={`${PILL} ${PILL_LOCKED}`}
          >
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            <span className={LABEL}>Peer Sets</span>
            <Lock className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : (
          <a
            href={`${base}peer-sets`}
            title="Peer Sets"
            aria-label="Peer Sets"
            className={`${PILL} ${PILL_ACTIVE}`}
          >
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            <span className={LABEL}>Peer Sets</span>
          </a>
        )}

        {/* Submit Docs links to the user's OWN district submit page (where
            uploads are attributed). Hidden for accounts not linked to a
            district, where document submission is unavailable. */}
        {districtId != null && (
          <a
            href={`${base}dashboard/${districtId}/submit`}
            title="Submit Docs"
            aria-label="Submit Docs"
            className={`${PILL} ${PILL_ACTIVE}`}
          >
            <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
            <span className={LABEL}>Submit Docs</span>
          </a>
        )}
      </div>

      <span aria-hidden className="h-5 w-px bg-slate-700" />
    </>
  );
}
