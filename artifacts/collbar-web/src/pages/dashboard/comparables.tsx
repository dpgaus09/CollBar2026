import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";
import { ProvenanceValue } from "@/components/provenance";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  insurance_changed: boolean | null;
  term_years: string | null;
  method: string | null;
  confidence: string | null;
  human_verified: boolean;
  page_ref: number | null;
  source_url: string | null;
  retrieved_at: string | null;
}

interface ComparablesMedians {
  median_base: string | null;
  median_yr2: string | null;
  median_yr3: string | null;
  median_lump: string | null;
  median_term: string | null;
  avg_base: string | null;
  n: number;
  district_count: number;
}

interface ComparablesResponse {
  items: ComparableItem[];
  total: number;
  page: number;
  pages: number;
  medians: ComparablesMedians | null;
  peer_set_name: string | null;
}

interface PeerSet {
  id: number;
  name: string;
  district_count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BANDS = ["", "tiny", "small", "medium", "large", "xlarge"];
const BAND_LABELS: Record<string, string> = {
  "": "All sizes",
  tiny: "< 500",
  small: "500–999",
  medium: "1,000–2,499",
  large: "2,500–4,999",
  xlarge: "5,000+",
};

// ---------------------------------------------------------------------------
// Sub-nav (shared with district.tsx pattern)
// ---------------------------------------------------------------------------

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
        <a
          key={t.key}
          href={t.href}
          className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
            active === t.key
              ? "border-blue-500 text-blue-400"
              : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtPct(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = parseFloat(String(v));
  return isNaN(n) ? "—" : `${n.toFixed(2)}%`;
}

function fmtMoney(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = parseFloat(String(v));
  return isNaN(n) ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// ---------------------------------------------------------------------------
// District state hook
// ---------------------------------------------------------------------------

function useDistrictState(id: string) {
  return useQuery<{ state: string }>({
    queryKey: [`/api/dashboard/districts/${id}/state`, id],
    queryFn: () =>
      fetch(apiUrl(`/api/dashboard/districts/${id}`), { credentials: "include" })
        .then((r) => r.json())
        .then((d: { state?: string }) => ({ state: d.state ?? "OH" })),
    enabled: !!id,
  });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ComparablesPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const logout = useLogout();

  // Read filters + peer_set_id from URL search params so a deep link from the
  // Ask page (?county=&band=&districtType=&yearFrom=&yearTo=) lands pre-filtered.
  const initialParams = (() => {
    if (typeof window === "undefined")
      return { peerSetId: "", county: "", band: "", districtType: "", yearFrom: "", yearTo: "" };
    const sp = new URLSearchParams(window.location.search);
    return {
      peerSetId: sp.get("peer_set_id") ?? "",
      county: sp.get("county") ?? "",
      band: sp.get("band") ?? "",
      districtType: sp.get("districtType") ?? "",
      yearFrom: sp.get("yearFrom") ?? "",
      yearTo: sp.get("yearTo") ?? "",
    };
  })();
  const initialPeerSetId = initialParams.peerSetId;

  const [county, setCounty] = useState(initialParams.county);
  const [band, setBand] = useState(initialParams.band);
  const [districtType, setDistrictType] = useState(initialParams.districtType);
  const [yearFrom, setYearFrom] = useState(initialParams.yearFrom);
  const [yearTo, setYearTo] = useState(initialParams.yearTo);
  const [page, setPage] = useState(1);
  const [selectedPeerSetId, setSelectedPeerSetId] = useState(initialPeerSetId);

  const { data: districtStateData } = useDistrictState(id);
  const districtState = districtStateData?.state ?? null;

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) { setLocation("/login"); return; }
  }, [authLoading, isAuthenticated, setLocation]);

  // Peer sets list
  const { data: peerSetsData } = useQuery<{ peerSets: PeerSet[] }>({
    queryKey: ["/api/peer-sets"],
    queryFn: () =>
      fetch(apiUrl("/api/peer-sets"), { credentials: "include" }).then((r) => r.json()),
    enabled: isAuthenticated,
  });

  const buildParams = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (districtState) p.set("state", districtState);
    if (county) p.set("county", county);
    if (band) p.set("band", band);
    if (districtType) p.set("districtType", districtType);
    if (yearFrom) p.set("yearFrom", yearFrom);
    if (yearTo) p.set("yearTo", yearTo);
    if (selectedPeerSetId) p.set("peer_set_id", selectedPeerSetId);
    p.set("page", String(extra.page ?? page));
    p.set("limit", "50");
    return p;
  };

  const { data, isLoading } = useQuery<ComparablesResponse>({
    queryKey: [
      "/api/dashboard/comparables",
      county, band, districtType, yearFrom, yearTo, page, selectedPeerSetId,
    ],
    queryFn: () =>
      fetch(`${apiUrl("/api/dashboard/comparables")}?${buildParams()}`, {
        credentials: "include",
      }).then((r) => r.json()),
  });

  const { data: counties } = useQuery<{ counties: string[] }>({
    queryKey: ["/api/dashboard/counties", districtState],
    queryFn: () => {
      const p = new URLSearchParams();
      if (districtState) p.set("state", districtState);
      return fetch(`${apiUrl("/api/dashboard/counties")}?${p}`, { credentials: "include" }).then((r) => r.json());
    },
  });

  const { data: dTypes } = useQuery<{ districtTypes: string[] }>({
    queryKey: ["/api/dashboard/district-types", districtState],
    queryFn: () => {
      const p = new URLSearchParams();
      if (districtState) p.set("state", districtState);
      return fetch(`${apiUrl("/api/dashboard/district-types")}?${p}`, { credentials: "include" }).then((r) => r.json());
    },
  });

  const csvUrl = `${apiUrl("/api/dashboard/comparables")}?${buildParams({ page: "1" })}&format=csv&limit=10000`;

  const pdfUrl = selectedPeerSetId
    ? `${apiUrl(`/api/peer-sets/${selectedPeerSetId}/export/pdf`)}?district_id=${id}`
    : null;

  const medians = data?.medians ?? null;

  if (authLoading || !isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
        <a
          href={`${import.meta.env.BASE_URL}dashboard/${id}`}
          className="text-slate-500 hover:text-slate-300 text-xs"
        >
          ← Overview
        </a>
        <button
          onClick={() => logout.mutate()}
          className="text-xs text-slate-500 hover:text-red-400"
        >
          Sign out
        </button>
      </header>
      <SubNav id={id} active="comparables" />

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-5">

        {/* Title row */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-slate-100">Comparable Settlements</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {data?.total.toLocaleString() ?? "—"} settlements ·{" "}
              {data?.peer_set_name
                ? <span className="text-blue-400">{data.peer_set_name}</span>
                : "all districts"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {pdfUrl && (
              <a
                href={pdfUrl}
                className="text-xs px-3 py-1.5 rounded border border-blue-700 text-blue-400 hover:bg-blue-900/40 transition-colors"
              >
                ↓ Board Packet PDF
              </a>
            )}
            <a
              href={csvUrl}
              className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-100 transition-colors"
            >
              ↓ Export CSV
            </a>
          </div>
        </div>

        {/* Peer set bar */}
        <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-lg px-4 py-2.5">
          <span className="text-xs text-slate-400 flex-shrink-0">Peer Set:</span>
          <select
            value={selectedPeerSetId}
            onChange={(e) => { setSelectedPeerSetId(e.target.value); setPage(1); }}
            className="flex-1 text-xs bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-300 focus:outline-none focus:border-blue-500"
          >
            <option value="">— None (show all matching filters) —</option>
            {(peerSetsData?.peerSets ?? []).map((ps) => (
              <option key={ps.id} value={String(ps.id)}>
                {ps.name} ({ps.district_count ?? "?"} districts)
              </option>
            ))}
          </select>
          <a
            href={`${import.meta.env.BASE_URL}peer-sets`}
            className="text-xs text-slate-500 hover:text-blue-400 flex-shrink-0"
          >
            Manage →
          </a>
        </div>

        {/* Medians banner */}
        {medians && medians.n > 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 px-5 py-3 flex flex-wrap gap-6 items-center">
            <div>
              <div className="text-xl font-bold font-mono text-blue-400">
                {fmtPct(medians.median_base)}
              </div>
              <div className="text-xs text-slate-500">Median base %</div>
            </div>
            {medians.median_yr2 != null && (
              <div>
                <div className="text-xl font-bold font-mono text-blue-300">
                  {fmtPct(medians.median_yr2)}
                </div>
                <div className="text-xs text-slate-500">Median yr 2 %</div>
              </div>
            )}
            {medians.median_yr3 != null && (
              <div>
                <div className="text-xl font-bold font-mono text-slate-400">
                  {fmtPct(medians.median_yr3)}
                </div>
                <div className="text-xs text-slate-500">Median yr 3 %</div>
              </div>
            )}
            {medians.median_lump != null && (
              <div>
                <div className="text-lg font-bold font-mono text-slate-400">
                  {fmtMoney(medians.median_lump)}
                </div>
                <div className="text-xs text-slate-500">Median lump sum</div>
              </div>
            )}
            {medians.median_term != null && (
              <div>
                <div className="text-lg font-bold font-mono text-slate-400">
                  {medians.median_term != null
                    ? `${parseFloat(String(medians.median_term)).toFixed(1)} yr`
                    : "—"}
                </div>
                <div className="text-xs text-slate-500">Median term</div>
              </div>
            )}
            <div className="ml-auto">
              <div className="text-xl font-bold font-mono text-slate-500">
                {medians.district_count ?? medians.n}
              </div>
              <div className="text-xs text-slate-500">Districts</div>
            </div>
          </div>
        )}

        {/* Filters (hidden when peer set active, but still shown for extra refinement) */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <select
            value={county}
            onChange={(e) => { setCounty(e.target.value); setPage(1); }}
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500"
          >
            <option value="">All counties</option>
            {(counties?.counties ?? []).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <select
            value={band}
            onChange={(e) => { setBand(e.target.value); setPage(1); }}
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500"
          >
            {BANDS.map((b) => (
              <option key={b} value={b}>{BAND_LABELS[b]}</option>
            ))}
          </select>

          <select
            value={districtType}
            onChange={(e) => { setDistrictType(e.target.value); setPage(1); }}
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500"
          >
            <option value="">All types</option>
            {(dTypes?.districtTypes ?? []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <input
            type="text"
            value={yearFrom}
            onChange={(e) => { setYearFrom(e.target.value); setPage(1); }}
            placeholder="Year from (e.g. 2020)"
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />

          <input
            type="text"
            value={yearTo}
            onChange={(e) => { setYearTo(e.target.value); setPage(1); }}
            placeholder="Year to (e.g. 2025)"
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="text-slate-500 text-sm animate-pulse text-center py-12">
            Loading…
          </div>
        ) : (
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr>
                  {[
                    "District", "County", "Year",
                    "Base %", "Yr 2 %", "Yr 3 %",
                    "Lump Sum", "Ins.", "Term",
                    "Method",
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left px-3 py-2 text-slate-400 font-medium whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {(data?.items ?? []).length === 0 ? (
                  <tr>
                    <td
                      colSpan={10}
                      className="px-3 py-6 text-center text-slate-600"
                    >
                      No settlements match your filters.
                      {selectedPeerSetId
                        ? " The selected peer set may be empty."
                        : " Run the extraction pipeline first."}
                    </td>
                  </tr>
                ) : (
                  (data?.items ?? []).map((item) => (
                    <tr
                      key={item.id}
                      className="bg-slate-950 hover:bg-slate-900/50"
                    >
                      <td className="px-3 py-2.5 text-slate-200 whitespace-nowrap">
                        {item.district_name}
                      </td>
                      <td className="px-3 py-2.5 text-slate-400">
                        {item.county ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">
                        {item.from_year}
                      </td>
                      <td className="px-3 py-2.5">
                        <ProvenanceValue
                          value={
                            item.base_increase_pct != null
                              ? parseFloat(item.base_increase_pct)
                              : null
                          }
                          unit="%"
                          humanVerified={item.human_verified}
                          confidence={item.confidence}
                          pageRef={item.page_ref}
                          sourceUrl={item.source_url}
                          retrievedAt={item.retrieved_at}
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <ProvenanceValue
                          value={
                            item.year2_pct != null
                              ? parseFloat(item.year2_pct)
                              : null
                          }
                          unit="%"
                          humanVerified={item.human_verified}
                          confidence={item.confidence}
                          pageRef={item.page_ref}
                          sourceUrl={item.source_url}
                          retrievedAt={item.retrieved_at}
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <ProvenanceValue
                          value={
                            item.year3_pct != null
                              ? parseFloat(item.year3_pct)
                              : null
                          }
                          unit="%"
                          humanVerified={item.human_verified}
                          confidence={item.confidence}
                          pageRef={item.page_ref}
                          sourceUrl={item.source_url}
                          retrievedAt={item.retrieved_at}
                        />
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 font-mono tabular-nums">
                        {item.off_schedule_payment != null
                          ? fmtMoney(item.off_schedule_payment)
                          : <span className="text-slate-600 italic">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {item.insurance_changed == null ? (
                          <span className="text-slate-600">—</span>
                        ) : item.insurance_changed ? (
                          <span className="text-amber-400">Yes</span>
                        ) : (
                          <span className="text-slate-500">No</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-slate-400 tabular-nums">
                        {item.term_years != null
                          ? `${parseFloat(item.term_years).toFixed(1)} yr`
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        {item.method ? (
                          <span className="text-slate-500">{item.method}</span>
                        ) : (
                          <span className="text-slate-600 italic">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>

              {/* Medians footer row */}
              {medians && medians.n > 0 && (data?.items ?? []).length > 0 && (
                <tfoot>
                  <tr className="bg-slate-900/60 border-t-2 border-blue-900">
                    <td
                      colSpan={3}
                      className="px-3 py-2 text-xs font-medium text-blue-400"
                    >
                      Peer set median
                    </td>
                    <td className="px-3 py-2 text-xs font-bold text-blue-400 tabular-nums">
                      {fmtPct(medians.median_base)}
                    </td>
                    <td className="px-3 py-2 text-xs font-bold text-blue-400 tabular-nums">
                      {fmtPct(medians.median_yr2)}
                    </td>
                    <td className="px-3 py-2 text-xs font-bold text-blue-400 tabular-nums">
                      {fmtPct(medians.median_yr3)}
                    </td>
                    <td className="px-3 py-2 text-xs font-bold text-blue-400 tabular-nums">
                      {fmtMoney(medians.median_lump)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">—</td>
                    <td className="px-3 py-2 text-xs font-bold text-blue-400 tabular-nums">
                      {medians.median_term != null
                        ? `${parseFloat(String(medians.median_term)).toFixed(1)} yr`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      n = {medians.district_count ?? medians.n}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}

        {/* Pagination */}
        {data && data.pages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="text-xs px-3 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40"
            >
              ← Prev
            </button>
            <span className="text-xs text-slate-500">
              Page {data.page} of {data.pages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
              disabled={page === data.pages}
              className="text-xs px-3 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
