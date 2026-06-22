import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";

interface Comparison {
  posting_id: number;
  topic: string;
  topic_label: string | null;
  status: "diff" | "aligned" | "district_only" | "union_only";
  numeric_gap: string | null;
  gap_unit: string | null;
  district_summary: string | null;
  union_summary: string | null;
  district_value: string | null;
  district_unit: string | null;
  union_value: string | null;
  union_unit: string | null;
}

interface Posting {
  id: number;
  case_number: string | null;
  year: number | null;
  bargaining_unit: string | null;
  district_name: string | null;
  union_name: string | null;
  posted_date: string | null;
  district_offer_url: string | null;
  union_offer_url: string | null;
  page_url: string | null;
  diff_count: number;
  aligned_count: number;
  comparisons: Comparison[];
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

const STATUS_META: Record<Comparison["status"], { label: string; cls: string }> = {
  diff: { label: "In dispute", cls: "bg-amber-900/40 text-amber-300 border-amber-800" },
  aligned: { label: "Agreed", cls: "bg-emerald-900/40 text-emerald-300 border-emerald-800" },
  district_only: { label: "Board only", cls: "bg-sky-900/40 text-sky-300 border-sky-800" },
  union_only: { label: "Union only", cls: "bg-violet-900/40 text-violet-300 border-violet-800" },
};

function formatGap(gap: string | null, unit: string | null): string | null {
  if (gap == null) return null;
  const n = parseFloat(gap);
  if (!Number.isFinite(n)) return null;
  const sign = n > 0 ? "+" : "";
  const suffix = unit === "percent" ? " pts" : unit === "usd" ? "" : unit === "years" ? " yr" : unit === "days" ? " days" : "";
  const prefix = unit === "usd" ? "$" : "";
  return `${sign}${prefix}${n}${suffix}`;
}

function formatDate(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const UNIT_LABEL: Record<string, string> = {
  teachers: "Teachers",
  support_staff: "Support staff",
  custodial_maintenance: "Custodial / Maintenance",
  food_service: "Food service",
  transportation: "Transportation",
  paraprofessionals: "Paraprofessionals",
  other: "Other unit",
};

function PostingCard({ p }: { p: Posting }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900">
      <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-100">{p.case_number ?? "Final offers"}</span>
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-slate-700 text-slate-400">
              {p.bargaining_unit ? (UNIT_LABEL[p.bargaining_unit] ?? p.bargaining_unit) : "Teachers"}
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {p.union_name ?? "Union"} · posted {formatDate(p.posted_date)}
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-amber-400">{p.diff_count} in dispute</span>
          <span className="text-emerald-400">{p.aligned_count} agreed</span>
        </div>
      </div>

      <div className="px-5 py-3 border-b border-slate-800 flex items-center gap-4 text-xs">
        <span className="text-slate-500">Posted offers:</span>
        {p.district_offer_url ? (
          <a href={p.district_offer_url} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:text-sky-300">Board offer PDF →</a>
        ) : <span className="text-slate-600">Board offer —</span>}
        {p.union_offer_url ? (
          <a href={p.union_offer_url} target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300">Union offer PDF →</a>
        ) : <span className="text-slate-600">Union offer —</span>}
      </div>

      {p.comparisons.length === 0 ? (
        <div className="px-5 py-6 text-center text-slate-600 text-xs">
          Offers stored — positions not yet extracted.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-900/60 border-b border-slate-800">
              <tr>
                {["Topic", "Board position", "Union position", "Gap", "Status"].map((h) => (
                  <th key={h} className="text-left px-4 py-2 text-slate-400 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {p.comparisons.map((c) => {
                const meta = STATUS_META[c.status];
                const gap = formatGap(c.numeric_gap, c.gap_unit);
                return (
                  <tr key={c.topic} className="bg-slate-950 align-top">
                    <td className="px-4 py-3 text-slate-300 font-medium whitespace-nowrap">{c.topic_label ?? c.topic}</td>
                    <td className="px-4 py-3 text-slate-400 max-w-xs">
                      {c.district_summary ?? <span className="text-slate-600 italic">—</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-400 max-w-xs">
                      {c.union_summary ?? <span className="text-slate-600 italic">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap font-mono">
                      {gap ? <span className="text-amber-300">{gap}</span> : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function FinalOffersPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const logout = useLogout();

  const { data, isLoading, isError } = useQuery<{ postings: Posting[] }>({
    queryKey: [`/api/dashboard/districts/${id}/final-offers`],
    queryFn: () =>
      fetch(apiUrl(`/api/dashboard/districts/${id}/final-offers`), { credentials: "include" }).then((r) => {
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

  const postings = data?.postings ?? [];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
        <a href={`${import.meta.env.BASE_URL}dashboard/${id}`} className="text-slate-500 hover:text-slate-300 text-xs">← Overview</a>
        <button onClick={() => logout.mutate()} className="text-xs text-slate-500 hover:text-red-400">Sign out</button>
      </header>
      <SubNav id={id} active="final-offers" />

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div>
          <h1 className="text-lg font-bold text-slate-100">Final Offers — Board vs Union</h1>
          <p className="text-xs text-slate-500 mt-1">
            ELRB interest-arbitration postings: where the board and the union still disagree, and where they already agree.
          </p>
        </div>

        {isLoading && (
          <div className="text-slate-500 text-sm animate-pulse text-center py-12">Loading…</div>
        )}

        {!isLoading && isError && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-8 text-center text-red-300 text-sm">
            Couldn't load final offers for this district. Please refresh to try again.
          </div>
        )}

        {!isLoading && !isError && postings.length === 0 && (
          <div className="rounded-lg border border-slate-800 p-8 text-center text-slate-600 text-sm">
            No board-vs-union final offers found for this district.
          </div>
        )}

        {!isLoading && postings.map((p) => <PostingCard key={p.id} p={p} />)}
      </main>
    </div>
  );
}
