import { useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { DistrictPicker } from "@/components/district-picker";
import {
  useRoster,
  useAddToRoster,
  useRemoveFromRoster,
  type DistrictLite,
} from "@/hooks/use-firm";

export default function RosterPage() {
  const { data, isLoading } = useRoster();
  const add = useAddToRoster();
  const remove = useRemoveFromRoster();

  const [pending, setPending] = useState<DistrictLite | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");

  const roster = data?.roster ?? [];
  const rosterIds = roster.map((r) => r.districtId);

  const handleAdd = () => {
    if (!pending) return;
    setError("");
    add.mutate(
      { districtId: pending.id, label: label.trim() || null },
      {
        onSuccess: () => {
          setPending(null);
          setLabel("");
        },
        onError: (e) => setError(e instanceof Error ? e.message : "Failed to add"),
      },
    );
  };

  return (
    <WorkspaceShell>
      <div className="space-y-8">
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-slate-100">Client roster</h2>
          <p className="text-sm text-slate-400">
            The districts your firm is tracking. Add a district to keep it handy
            for matters, comparisons, and alerts.
          </p>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-200">Add a district</h3>
          {pending ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-md border border-slate-700 bg-slate-950 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-slate-200 truncate">{pending.name}</p>
                  <p className="text-[11px] text-slate-500">
                    {pending.county ? `${pending.county} • ` : ""}
                    {pending.state}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setPending(null);
                    setLabel("");
                  }}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Change
                </button>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Optional note (e.g. 'Lead counsel: J. Smith')"
                  className="flex-1 bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
                />
                <button
                  onClick={handleAdd}
                  disabled={add.isPending}
                  className="py-2 px-4 rounded-md bg-blue-700 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50 transition-colors"
                >
                  {add.isPending ? "Adding…" : "Add to roster"}
                </button>
              </div>
            </div>
          ) : (
            <DistrictPicker onSelect={setPending} excludeIds={rosterIds} />
          )}
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-200">
              Tracked districts
            </h3>
            <span className="text-xs text-slate-500">
              {isLoading ? "…" : `${roster.length}`}
            </span>
          </div>
          {isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : roster.length === 0 ? (
            <p className="text-sm text-slate-500">
              No districts yet. Add one above to start building your roster.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {roster.map((r) => (
                <li
                  key={r.districtId}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-slate-200 truncate">{r.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {r.county ? `${r.county} • ` : ""}
                      {r.state}
                      {r.enrollment != null
                        ? ` • ${r.enrollment.toLocaleString()} students`
                        : ""}
                    </p>
                    {r.label && (
                      <p className="text-[11px] text-slate-400 mt-0.5 italic">
                        {r.label}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => remove.mutate(r.districtId)}
                    disabled={remove.isPending}
                    className="text-xs text-slate-400 hover:text-red-300 border border-slate-700 rounded-md px-2.5 py-1 hover:border-red-800/60 transition-colors disabled:opacity-50"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}
