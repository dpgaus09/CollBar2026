import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api";
import { DEFAULT_UNIT, unitLabel } from "@/lib/bargaining-units";

export interface AvailableUnit {
  bargaining_unit: string;
  n: number;
}

// Fetches the set of bargaining units that exist for a district (the union of
// settlement + contract units, teachers first). availableUnits is the same
// regardless of the selected unit, so we always fetch with the default unit and
// let react-query cache it per district.
function useAvailableUnits(districtId: string, enabled: boolean) {
  return useQuery<AvailableUnit[]>({
    queryKey: ["/api/dashboard/districts", districtId, "available-units"],
    queryFn: async () => {
      const params = new URLSearchParams({ bargainingUnit: DEFAULT_UNIT });
      const res = await fetch(
        `${apiUrl(`/api/dashboard/districts/${districtId}/settlements`)}?${params}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { availableUnits?: AvailableUnit[] };
      return json.availableUnits ?? [];
    },
    enabled: enabled && !!districtId,
  });
}

// Shared bargaining-unit control used at the top of every district tab. The
// selection is held in the URL (`?unit=`) via useDistrictUnit, so it persists
// as the user moves between Overview, Key Clauses, Comparables, Ask vs Got, and
// Final Offers. A district can have several CBAs (teachers, support staff,
// custodial…); each is a distinct group and benchmarks never mix units.
export function UnitSwitcher({
  districtId,
  unit,
  onChange,
  availableUnits,
}: {
  districtId: string;
  unit: string;
  onChange: (u: string) => void;
  // When the parent already has the unit list (the Overview fetches it with the
  // settlements query) pass it in to avoid a duplicate request.
  availableUnits?: AvailableUnit[];
}) {
  const { data: fetched } = useAvailableUnits(districtId, availableUnits === undefined);
  const units = availableUnits ?? fetched ?? [];

  if (units.length === 0) return null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="shrink-0">
          <div className="text-xs text-slate-400 uppercase tracking-widest font-semibold">
            Bargaining Unit
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {units.length > 1
              ? "Switch to view this district for each group"
              : "This district has one bargaining unit on file"}
          </div>
        </div>
        {units.length === 1 ? (
          <div className="inline-flex items-center gap-1.5 self-start rounded-md bg-slate-800 px-3.5 py-1.5 text-sm font-medium text-slate-200 sm:self-auto">
            {unitLabel(units[0].bargaining_unit)}
            <span className="text-slate-500">({units[0].n})</span>
          </div>
        ) : (
          <div role="group" aria-label="Bargaining unit" className="flex flex-wrap gap-1.5">
            {units.map((u) => {
              const active = unit === u.bargaining_unit;
              return (
                <button
                  key={u.bargaining_unit}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange(u.bargaining_unit)}
                  className={`rounded-md border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? "border-blue-500 bg-blue-500/15 text-blue-200 shadow-sm"
                      : "border-slate-700 bg-slate-800/40 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                  }`}
                >
                  {unitLabel(u.bargaining_unit)}
                  <span className={`ml-1 ${active ? "text-blue-300/70" : "text-slate-600"}`}>
                    ({u.n})
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
