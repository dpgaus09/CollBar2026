import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip as RechartTooltip,
  ResponsiveContainer, ReferenceLine, CartesianGrid,
} from "recharts";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";
import { ProvenanceValue } from "@/components/provenance";

interface Proposal {
  id: number;
  case_number: string | null;
  report_date: string | null;
  union_name: string | null;
  employer_proposal_pct: string | null;
  union_proposal_pct: string | null;
  factfinder_recommendation_pct: string | null;
  year_covered: string | null;
  page_ref: number | null;
  confidence: string | null;
  human_verified: boolean;
  source_url: string | null;
  retrieved_at: string | null;
}

function SubNav({ id, active }: { id: string; active: string }) {
  const base = `${import.meta.env.BASE_URL}dashboard/${id}`;
  const tabs = [
    { key: "home", label: "Overview", href: base },
    { key: "clauses", label: "Key Clauses", href: `${base}/clauses` },
    { key: "comparables", label: "Comparables", href: `${base}/comparables` },
    { key: "ask-vs-got", label: "Ask vs Got", href: `${base}/ask-vs-got` },
    { key: "final-offers", label: "Final Offers", href: `${base}/final-offers` },
  ] as const;
  return (
    <div className="border-b border-slate-800 px-6 flex -mb-px">
      {tabs.map((t) => (
        <a key={t.key} href={t.href} className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${active === t.key ? "border-blue-500 text-blue-400" : "border-transparent text-slate-500 hover:text-slate-300"}`}>
          {t.label}
        </a>
      ))}
    </div>
  );
}

const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: { payload: { label: string; x: number; y: number } }[] }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-slate-800 border border-slate-700 rounded p-3 text-xs text-slate-200 space-y-1">
      <div className="font-medium">{d.label}</div>
      <div>Union ask: <span className="text-blue-400 font-mono">{d.x.toFixed(2)}%</span></div>
      <div>FF recommendation: <span className="text-emerald-400 font-mono">{d.y.toFixed(2)}%</span></div>
    </div>
  );
};

export default function AskVsGotPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const logout = useLogout();

  const { data, isLoading } = useQuery<{ proposals: Proposal[] }>({
    queryKey: [`/api/dashboard/districts/${id}/factfinding`],
    queryFn: () =>
      fetch(apiUrl(`/api/dashboard/districts/${id}/factfinding`), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    enabled: !!id,
  });

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) { setLocation("/login"); return; }
  }, [authLoading, isAuthenticated, setLocation]);

  if (authLoading || !isAuthenticated) return null;

  const proposals = data?.proposals ?? [];

  const chartData = proposals
    .filter((p) => p.union_proposal_pct != null && p.factfinder_recommendation_pct != null)
    .map((p) => ({
      x: parseFloat(p.union_proposal_pct!),
      y: parseFloat(p.factfinder_recommendation_pct!),
      label: p.year_covered ?? p.report_date ?? "?",
    }));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
        <a href={`${import.meta.env.BASE_URL}dashboard/${id}`} className="text-slate-500 hover:text-slate-300 text-xs">← Overview</a>
        <button onClick={() => logout.mutate()} className="text-xs text-slate-500 hover:text-red-400">Sign out</button>
      </header>
      <SubNav id={id} active="ask-vs-got" />

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        <div>
          <h1 className="text-lg font-bold text-slate-100">Ask vs Got</h1>
          <p className="text-xs text-slate-500 mt-1">
            Fact-finding proposals: union ask vs. fact-finder recommendation
          </p>
        </div>

        {isLoading && (
          <div className="text-slate-500 text-sm animate-pulse text-center py-12">Loading…</div>
        )}

        {!isLoading && proposals.length === 0 && (
          <div className="rounded-lg border border-slate-800 p-8 text-center text-slate-600 text-sm">
            No fact-finding proposals found for this district.
          </div>
        )}

        {!isLoading && chartData.length > 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-4">
              Scatter — Union Ask vs Fact-Finder Recommendation
            </h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    dataKey="x"
                    name="Union ask"
                    unit="%"
                    tick={{ fontSize: 10, fill: "#64748b" }}
                    label={{ value: "Union ask %", position: "insideBottomRight", offset: -4, fill: "#64748b", fontSize: 10 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="y"
                    name="FF recommendation"
                    unit="%"
                    tick={{ fontSize: 10, fill: "#64748b" }}
                    label={{ value: "FF rec %", angle: -90, position: "insideLeft", fill: "#64748b", fontSize: 10 }}
                  />
                  <ReferenceLine
                    stroke="#64748b"
                    strokeDasharray="4 4"
                    segment={[{ x: 0, y: 0 }, { x: 20, y: 20 }]}
                    label={{ value: "x = y", fill: "#64748b", fontSize: 9 }}
                  />
                  <RechartTooltip content={<CustomTooltip />} />
                  <Scatter data={chartData} fill="#3b82f6" opacity={0.8} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-slate-600 mt-2 text-center">
              Points above the diagonal = fact-finder recommended more than union asked
            </p>
          </div>
        )}

        {!isLoading && proposals.length > 0 && (
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr>
                  {["Case #", "Year", "Union", "Employer %", "Union ask %", "FF rec %", "Source"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-slate-400 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {proposals.map((p) => (
                  <tr key={p.id} className="bg-slate-950 hover:bg-slate-900/50">
                    <td className="px-3 py-2.5 text-slate-400 font-mono">{p.case_number ?? "—"}</td>
                    <td className="px-3 py-2.5 text-slate-400">{p.year_covered ?? p.report_date?.slice(0, 4) ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {p.union_name
                        ? <span className="text-slate-300">{p.union_name}</span>
                        : <span className="text-slate-600 italic text-xs">Not yet extracted</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <ProvenanceValue
                        value={p.employer_proposal_pct != null ? parseFloat(p.employer_proposal_pct) : null}
                        unit="%"
                        pageRef={p.page_ref}
                        confidence={p.confidence}
                        humanVerified={p.human_verified}
                        sourceUrl={p.source_url}
                        retrievedAt={p.retrieved_at}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <ProvenanceValue
                        value={p.union_proposal_pct != null ? parseFloat(p.union_proposal_pct) : null}
                        unit="%"
                        pageRef={p.page_ref}
                        confidence={p.confidence}
                        humanVerified={p.human_verified}
                        sourceUrl={p.source_url}
                        retrievedAt={p.retrieved_at}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <ProvenanceValue
                        value={p.factfinder_recommendation_pct != null ? parseFloat(p.factfinder_recommendation_pct) : null}
                        unit="%"
                        pageRef={p.page_ref}
                        confidence={p.confidence}
                        humanVerified={p.human_verified}
                        sourceUrl={p.source_url}
                        retrievedAt={p.retrieved_at}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      {p.source_url ? (
                        <a href={p.source_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-400">PDF →</a>
                      ) : <span className="text-slate-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
