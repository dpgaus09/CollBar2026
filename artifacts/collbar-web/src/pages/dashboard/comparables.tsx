import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";
import { ProvenanceValue } from "@/components/provenance";

interface ComparableItem {
  id: number;
  district_id: number;
  district_name: string;
  county: string | null;
  district_type: string | null;
  enrollment: number | null;
  from_year: string;
  to_year: string;
  base_increase_pct: string | null;
  year2_pct: string | null;
  year3_pct: string | null;
  off_schedule_payment: string | null;
  term_years: string | null;
  method: string | null;
  confidence: string | null;
  human_verified: boolean;
  page_ref: number | null;
  source_url: string | null;
  retrieved_at: string | null;
}

interface ComparablesResponse {
  items: ComparableItem[];
  total: number;
  page: number;
  pages: number;
}

interface MediansResponse {
  median_base: string | null;
  avg_base: string | null;
  n: number;
}

const BANDS = ["", "tiny", "small", "medium", "large", "xlarge"];
const BAND_LABELS: Record<string, string> = {
  "": "All sizes",
  tiny: "< 500",
  small: "500–999",
  medium: "1,000–2,499",
  large: "2,500–4,999",
  xlarge: "5,000+",
};

function SubNav({ id, active }: { id: string; active: string }) {
  const base = `${import.meta.env.BASE_URL}dashboard/${id}`;
  const tabs = [
    { key: "home", label: "Overview", href: base },
    { key: "clauses", label: "Key Clauses", href: `${base}/clauses` },
    { key: "comparables", label: "Comparables", href: `${base}/comparables` },
    { key: "ask-vs-got", label: "Ask vs Got", href: `${base}/ask-vs-got` },
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

export default function ComparablesPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading, isAdmin, districtId } = useAuth();
  const logout = useLogout();

  const [county, setCounty] = useState("");
  const [band, setBand] = useState("");
  const [districtType, setDistrictType] = useState("");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) { setLocation("/login"); return; }
    if (!isAdmin && districtId != null && districtId !== parseInt(id)) {
      setLocation(`/dashboard/${districtId}`);
    }
  }, [authLoading, isAuthenticated, isAdmin, districtId, id, setLocation]);

  const buildParams = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (county) p.set("county", county);
    if (band) p.set("band", band);
    if (districtType) p.set("districtType", districtType);
    if (yearFrom) p.set("yearFrom", yearFrom);
    if (yearTo) p.set("yearTo", yearTo);
    p.set("page", String(extra.page ?? page));
    p.set("limit", "50");
    return p;
  };

  const { data, isLoading } = useQuery<ComparablesResponse>({
    queryKey: ["/api/dashboard/comparables", county, band, districtType, yearFrom, yearTo, page],
    queryFn: () =>
      fetch(`${apiUrl("/api/dashboard/comparables")}?${buildParams()}`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
  });

  const { data: medians } = useQuery<MediansResponse>({
    queryKey: ["/api/dashboard/medians", county, band, yearFrom, yearTo],
    queryFn: () => {
      const p = new URLSearchParams();
      if (county) p.set("county", county);
      if (band) p.set("band", band);
      if (yearFrom) p.set("yearFrom", yearFrom);
      if (yearTo) p.set("yearTo", yearTo);
      return fetch(`${apiUrl("/api/dashboard/medians")}?${p}`, { credentials: "include" }).then((r) =>
        r.json(),
      );
    },
  });

  const { data: counties } = useQuery<{ counties: string[] }>({
    queryKey: ["/api/dashboard/counties"],
    queryFn: () => fetch(apiUrl("/api/dashboard/counties"), { credentials: "include" }).then((r) => r.json()),
  });

  const { data: dTypes } = useQuery<{ districtTypes: string[] }>({
    queryKey: ["/api/dashboard/district-types"],
    queryFn: () => fetch(apiUrl("/api/dashboard/district-types"), { credentials: "include" }).then((r) => r.json()),
  });

  const csvUrl = `${apiUrl("/api/dashboard/comparables")}?${buildParams({ page: "1" })}&format=csv&limit=10000`;

  if (authLoading || !isAuthenticated) return null;
  if (!isAdmin && districtId != null && districtId !== parseInt(id)) return null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
        <a href={`${import.meta.env.BASE_URL}dashboard/${id}`} className="text-slate-500 hover:text-slate-300 text-xs">← Overview</a>
        <button onClick={() => logout.mutate()} className="text-xs text-slate-500 hover:text-red-400">Sign out</button>
      </header>
      <SubNav id={id} active="comparables" />

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-slate-100">Comparable Settlements</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {data?.total.toLocaleString() ?? "—"} settlements match your filters
            </p>
          </div>
          <a
            href={csvUrl}
            className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-100 transition-colors"
          >
            ↓ Export CSV
          </a>
        </div>

        {/* Median banner */}
        {medians && (medians.median_base != null || (medians.n ?? 0) > 0) && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 px-5 py-3 flex flex-wrap gap-6 items-center">
            <div>
              <div className="text-xl font-bold font-mono text-blue-400">
                {medians.median_base != null ? `${parseFloat(medians.median_base).toFixed(2)}%` : "—"}
              </div>
              <div className="text-xs text-slate-500">Median base increase</div>
            </div>
            <div>
              <div className="text-xl font-bold font-mono text-slate-300">
                {medians.avg_base != null ? `${parseFloat(medians.avg_base).toFixed(2)}%` : "—"}
              </div>
              <div className="text-xs text-slate-500">Average base increase</div>
            </div>
            <div>
              <div className="text-xl font-bold font-mono text-slate-400">
                {(medians.n ?? 0).toLocaleString()}
              </div>
              <div className="text-xs text-slate-500">Settlements in filter</div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <select value={county} onChange={(e) => { setCounty(e.target.value); setPage(1); }}
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500">
            <option value="">All counties</option>
            {(counties?.counties ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          <select value={band} onChange={(e) => { setBand(e.target.value); setPage(1); }}
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500">
            {BANDS.map((b) => <option key={b} value={b}>{BAND_LABELS[b]}</option>)}
          </select>

          <select value={districtType} onChange={(e) => { setDistrictType(e.target.value); setPage(1); }}
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500">
            <option value="">All types</option>
            {(dTypes?.districtTypes ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>

          <input type="text" value={yearFrom} onChange={(e) => { setYearFrom(e.target.value); setPage(1); }}
            placeholder="Year from (e.g. 2020)"
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-500" />

          <input type="text" value={yearTo} onChange={(e) => { setYearTo(e.target.value); setPage(1); }}
            placeholder="Year to (e.g. 2025)"
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-500" />
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="text-slate-500 text-sm animate-pulse text-center py-12">Loading…</div>
        ) : (
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr>
                  {["District", "County", "Year", "Base %", "Yr 2 %", "Yr 3 %", "Method"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-slate-400 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {(data?.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-slate-600">
                      No settlements match your filters. Run the extraction pipeline first.
                    </td>
                  </tr>
                ) : (
                  (data?.items ?? []).map((item) => (
                    <tr key={item.id} className="bg-slate-950 hover:bg-slate-900/50">
                      <td className="px-3 py-2.5 text-slate-200">{item.district_name}</td>
                      <td className="px-3 py-2.5 text-slate-400">{item.county ?? "—"}</td>
                      <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{item.from_year}</td>
                      <td className="px-3 py-2.5">
                        <ProvenanceValue value={item.base_increase_pct != null ? parseFloat(item.base_increase_pct) : null} unit="%" humanVerified={item.human_verified} confidence={item.confidence} pageRef={item.page_ref} sourceUrl={item.source_url} retrievedAt={item.retrieved_at} />
                      </td>
                      <td className="px-3 py-2.5">
                        <ProvenanceValue value={item.year2_pct != null ? parseFloat(item.year2_pct) : null} unit="%" humanVerified={item.human_verified} confidence={item.confidence} pageRef={item.page_ref} sourceUrl={item.source_url} retrievedAt={item.retrieved_at} />
                      </td>
                      <td className="px-3 py-2.5">
                        <ProvenanceValue value={item.year3_pct != null ? parseFloat(item.year3_pct) : null} unit="%" humanVerified={item.human_verified} confidence={item.confidence} pageRef={item.page_ref} sourceUrl={item.source_url} retrievedAt={item.retrieved_at} />
                      </td>
                      <td className="px-3 py-2.5">
                        {item.method
                          ? <span className="text-slate-500">{item.method}</span>
                          : <span className="text-slate-600 italic text-xs">Not yet extracted</span>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {data && data.pages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
              className="text-xs px-3 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40">
              ← Prev
            </button>
            <span className="text-xs text-slate-500">Page {data.page} of {data.pages}</span>
            <button onClick={() => setPage((p) => Math.min(data.pages, p + 1))} disabled={page === data.pages}
              className="text-xs px-3 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40">
              Next →
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
