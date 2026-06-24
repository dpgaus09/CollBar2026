import { Lock } from "lucide-react";
import { useSearchParams } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useUpgradeLock } from "@/components/upgrade";
import { DEFAULT_UNIT, isCanonicalUnit } from "@/lib/bargaining-units";

export type SubNavTab = "home" | "clauses" | "comparables" | "ask-vs-got" | "final-offers" | "submit";

// Tabs that require a paid plan. Overview ("home") is always available.
const PAID_TABS = new Set<SubNavTab>(["clauses", "comparables", "ask-vs-got", "final-offers"]);

export function DashboardSubNav({ id, active }: { id: string; active: SubNavTab }) {
  const base = `${import.meta.env.BASE_URL}dashboard/${id}`;
  const { isFree } = useAuth();
  const { showUpgrade } = useUpgradeLock();

  // Carry the selected bargaining unit across tab navigation so the choice the
  // user made on one tab survives to the next. The default unit (teachers) needs
  // no param, keeping URLs clean.
  const [params] = useSearchParams();
  const rawUnit = params.get("unit");
  const unitQuery =
    rawUnit && isCanonicalUnit(rawUnit) && rawUnit !== DEFAULT_UNIT
      ? `?unit=${encodeURIComponent(rawUnit)}`
      : "";

  const tabs: { key: SubNavTab; label: string; href: string }[] = [
    { key: "home", label: "Overview", href: `${base}${unitQuery}` },
    { key: "clauses", label: "Key Clauses", href: `${base}/clauses${unitQuery}` },
    { key: "comparables", label: "Comparables", href: `${base}/comparables${unitQuery}` },
    { key: "ask-vs-got", label: "Ask vs Got", href: `${base}/ask-vs-got${unitQuery}` },
    { key: "final-offers", label: "Final Offers", href: `${base}/final-offers${unitQuery}` },
  ];

  return (
    <nav aria-label="District sections" className="border-b border-slate-800 px-6 flex -mb-px">
      {tabs.map((t) => {
        const locked = isFree && PAID_TABS.has(t.key);
        if (locked) {
          return (
            <button
              key={t.key}
              type="button"
              onClick={showUpgrade}
              title="Paid feature"
              aria-label={`${t.label} (paid feature)`}
              className="px-4 py-3 text-xs font-medium border-b-2 border-transparent text-slate-600 hover:text-slate-500 cursor-not-allowed flex items-center gap-1"
            >
              {t.label}
              <Lock className="h-3 w-3" aria-hidden="true" />
            </button>
          );
        }
        return (
          <a
            key={t.key}
            href={t.href}
            aria-current={active === t.key ? "page" : undefined}
            className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
              active === t.key
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            {t.label}
          </a>
        );
      })}
    </nav>
  );
}
