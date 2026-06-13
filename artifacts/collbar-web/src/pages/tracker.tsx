import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api";

interface BandMedian {
  band: string;
  label: string;
  median_base: number | null;
  n: number;
}

interface Settlement {
  district_name: string;
  county: string | null;
  from_year: string | null;
  base_increase_pct: string | null;
  term_years: string | null;
  human_verified: boolean;
  source_url: string | null;
  state: string | null;
  district_slug: string | null;
}

interface TrackerStats {
  total_settlements: number;
  districts_covered: number;
  median_base: number | null;
  avg_base: number | null;
  year_min: string | null;
  year_max: string | null;
  band_medians: BandMedian[];
  newest: Settlement[];
  computed_at: string;
}

function fmtPct(v: number | string | null | undefined) {
  if (v == null) return "—";
  const n = parseFloat(String(v));
  return isNaN(n) ? "—" : `${n.toFixed(2)}%`;
}
function fmtTerm(v: string | null | undefined) {
  if (!v) return "—";
  const n = parseFloat(v);
  return isNaN(n) ? "—" : `${n.toFixed(1)} yr`;
}

export default function TrackerPage() {
  const [activeState, setActiveState] = useState<"IL" | "OH">("IL");
  const { data, isLoading } = useQuery<TrackerStats>({
    queryKey: ["/api/public/tracker-stats", activeState],
    queryFn: () =>
      fetch(`${apiUrl("/api/public/tracker-stats")}?state=${activeState}`).then((r) => r.json()),
    staleTime: 60 * 60 * 1000,
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-slate-100 font-bold text-sm tracking-tight">CollBar</span>
          <span className="text-slate-600 text-xs">{activeState === "IL" ? "Illinois" : "Ohio"} K-12 Settlement Tracker</span>
        </div>
        <div className="flex items-center gap-4">
          <a href={`${import.meta.env.BASE_URL}signup`} className="text-xs text-blue-400 hover:text-blue-300">
            Free account
          </a>
          <a href={`${import.meta.env.BASE_URL}login`} className="text-xs text-slate-500 hover:text-slate-300">
            Sign in
          </a>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-3">
            {(["IL", "OH"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setActiveState(s)}
                className={`px-3 py-1 text-xs rounded font-semibold transition-colors ${activeState === s ? "bg-blue-700 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"}`}
              >
                {s === "IL" ? "Illinois" : "Ohio"}
              </button>
            ))}
          </div>
          <h1 className="text-xl font-bold text-slate-100">{activeState === "IL" ? "Illinois" : "Ohio"} K-12 Settlement Tracker</h1>
          <p className="text-xs text-slate-500 mt-1">
            Verified base-salary increase data from {activeState === "IL" ? "ISBE filings" : "SERB filings"} and public district contracts · Updated daily
          </p>
        </div>

        {isLoading ? (
          <div className="text-slate-600 text-sm animate-pulse text-center py-16">Loading…</div>
        ) : (
          <>
            {/* Stats cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "Settlements", value: data?.total_settlements.toLocaleString() ?? "—" },
                { label: "Districts covered", value: data?.districts_covered.toLocaleString() ?? "—" },
                { label: "Statewide median", value: fmtPct(data?.median_base) },
                {
                  label: "Year range",
                  value:
                    data?.year_min && data?.year_max
                      ? `${data.year_min} – ${data.year_max}`
                      : "—",
                },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-3">
                  <div className="text-lg font-bold text-blue-400 font-mono">{s.value}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Band medians */}
            <div className="rounded-lg border border-slate-800 overflow-hidden">
              <div className="bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-widest border-b border-slate-800">
                Median Base Increase — by District Size
              </div>
              <table className="w-full text-xs">
                <thead className="bg-slate-900/50">
                  <tr>
                    <th className="text-left px-4 py-2 text-slate-500 font-medium">Enrollment</th>
                    <th className="text-left px-4 py-2 text-slate-500 font-medium">Median %</th>
                    <th className="text-left px-4 py-2 text-slate-500 font-medium">n</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {(data?.band_medians ?? []).map((b) => (
                    <tr key={b.band} className="bg-slate-950 hover:bg-slate-900/50">
                      <td className="px-4 py-2.5 text-slate-300">{b.label}</td>
                      <td className="px-4 py-2.5 font-bold text-blue-400 tabular-nums">{fmtPct(b.median_base)}</td>
                      <td className="px-4 py-2.5 text-slate-500">{b.n}</td>
                    </tr>
                  ))}
                  {(data?.band_medians ?? []).length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-slate-600">
                        No data yet — extraction pipeline coming soon.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Newest settlements */}
            <div className="rounded-lg border border-slate-800 overflow-hidden">
              <div className="bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-widest border-b border-slate-800">
                Newest Settlements
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-900/50">
                    <tr>
                      {["District", "County", "Year", "Base %", "Term", "Status"].map((h) => (
                        <th key={h} className="text-left px-3 py-2 text-slate-500 font-medium whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {(data?.newest ?? []).map((s, i) => (
                      <tr key={i} className="bg-slate-950 hover:bg-slate-900/50">
                        <td className="px-3 py-2.5">
                          {s.district_slug ? (
                            <a
                              href={`${import.meta.env.BASE_URL}${(s.state ?? "il").toLowerCase()}/${s.district_slug}`}
                              className="text-slate-200 hover:text-blue-400"
                            >
                              {s.district_name}
                            </a>
                          ) : (
                            <span className="text-slate-200">{s.district_name}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-slate-400">{s.county ?? "—"}</td>
                        <td className="px-3 py-2.5 text-slate-400">{s.from_year ?? "—"}</td>
                        <td className="px-3 py-2.5 font-bold text-blue-400 tabular-nums">
                          {fmtPct(s.base_increase_pct)}
                        </td>
                        <td className="px-3 py-2.5 text-slate-400 tabular-nums">
                          {fmtTerm(s.term_years)}
                        </td>
                        <td className="px-3 py-2.5">
                          {s.human_verified ? (
                            <span className="text-xs font-medium text-green-400">✓ Verified</span>
                          ) : (
                            <span className="text-xs text-blue-400">AI</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {(data?.newest ?? []).length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-3 py-6 text-center text-slate-600">
                          No verified settlements yet — extraction pipeline coming soon.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* CTA */}
            <div className="rounded-xl border border-blue-900 bg-slate-900/50 p-8 text-center space-y-4">
              <h2 className="text-lg font-bold text-slate-100">
                Track your district's contract data for free
              </h2>
              <p className="text-sm text-slate-400">
                Free account: your district's full settlement history, key clauses, and contract expiration.
              </p>
              <div className="flex items-center justify-center gap-3">
                <a
                  href={`${import.meta.env.BASE_URL}signup`}
                  className="px-5 py-2.5 rounded bg-blue-700 hover:bg-blue-600 text-sm font-semibold text-white transition-colors"
                >
                  Create free account
                </a>
                <a
                  href={`${import.meta.env.BASE_URL}login`}
                  className="px-5 py-2.5 rounded border border-slate-700 text-sm text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
                >
                  Sign in
                </a>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
