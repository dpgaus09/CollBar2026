import { useSearchParams } from "wouter";
import { DEFAULT_UNIT, isCanonicalUnit } from "@/lib/bargaining-units";

// Single source of truth for the selected bargaining unit on a district's tabs.
// The unit lives in the URL (`?unit=`) so the selection survives navigation
// between the Overview, Key Clauses, Comparables, Ask vs Got, and Final Offers
// tabs (the sub-nav links carry the param). Because each district is reached via
// a link WITHOUT `?unit=`, switching districts naturally resets to the default
// (teachers) — no extra reset logic needed.
export function useDistrictUnit(): [string, (next: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("unit");
  const unit = isCanonicalUnit(raw) ? (raw as string) : DEFAULT_UNIT;

  const setUnit = (next: string) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        // Keep the URL clean: the default unit needs no param.
        if (next === DEFAULT_UNIT || !isCanonicalUnit(next)) {
          p.delete("unit");
        } else {
          p.set("unit", next);
        }
        return p;
      },
      { replace: true },
    );
  };

  return [unit, setUnit];
}
