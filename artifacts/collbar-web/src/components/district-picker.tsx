import { useState } from "react";
import { useDistrictSearch, type DistrictLite } from "@/hooks/use-firm";

// Reusable search-to-select control for districts, used wherever the firm
// workspace needs to pick a district (roster add, matter client/peer selection).
// It hits the firm-guarded search endpoint, never the paid peer-set search.
export function DistrictPicker({
  onSelect,
  placeholder = "Search districts by name or county…",
  excludeIds = [],
}: {
  onSelect: (d: DistrictLite) => void;
  placeholder?: string;
  excludeIds?: number[];
}) {
  const [q, setQ] = useState("");
  const { data, isFetching } = useDistrictSearch(q);
  const open = q.trim().length >= 2;
  const results = (data?.districts ?? []).filter(
    (d) => !excludeIds.includes(d.id),
  );

  return (
    <div className="relative">
      <input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-slate-700 bg-slate-900 shadow-xl max-h-64 overflow-auto">
          {isFetching && results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">No matches.</div>
          ) : (
            results.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  onSelect(d);
                  setQ("");
                }}
                className="w-full text-left px-3 py-2 hover:bg-slate-800 transition-colors flex items-center justify-between gap-3"
              >
                <span className="text-sm text-slate-200 truncate">{d.name}</span>
                <span className="text-[11px] text-slate-500 shrink-0">
                  {d.county ? `${d.county} • ` : ""}
                  {d.state}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
