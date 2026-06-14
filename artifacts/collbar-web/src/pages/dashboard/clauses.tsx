import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { apiUrl } from "@/lib/api";
import { ProvenanceValue } from "@/components/provenance";

interface Provision {
  id: number;
  category: string;
  provision_key: string;
  value_numeric: string | null;
  value_text: string | null;
  unit: string | null;
  clause_excerpt: string | null;
  page_ref: number | null;
  confidence: string | null;
  human_verified: boolean;
  source_url: string | null;
  retrieved_at: string | null;
}

const CATEGORIES = ["", "compensation", "insurance", "retirement", "leave", "workday", "evaluation", "rif", "grievance", "other"];

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

function ConfidenceBadge({ v }: { v: string | null }) {
  if (!v) return null;
  const n = parseFloat(v);
  const color = n >= 0.8 ? "text-emerald-400" : n >= 0.5 ? "text-amber-400" : "text-red-400";
  return <span className={`text-xs font-mono ${color}`}>{(n * 100).toFixed(0)}%</span>;
}

export default function ClausesPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const logout = useLogout();

  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery<{ provisions: Provision[] }>({
    queryKey: [`/api/dashboard/districts/${id}/provisions`],
    queryFn: () =>
      fetch(apiUrl(`/api/dashboard/districts/${id}/provisions`), { credentials: "include" }).then((r) => {
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

  const provisions = (data?.provisions ?? []).filter((p) => {
    if (category && p.category !== category) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        p.provision_key.toLowerCase().includes(q) ||
        (p.clause_excerpt ?? "").toLowerCase().includes(q) ||
        (p.value_text ?? "").toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-3 flex items-center justify-between bg-slate-950">
        <div className="flex items-center gap-3 min-w-0">
          <a href={`${import.meta.env.BASE_URL}dashboard/${id}`} className="text-slate-500 hover:text-slate-300 text-xs">← Overview</a>
        </div>
        <button onClick={() => logout.mutate()} className="text-xs text-slate-500 hover:text-red-400">Sign out</button>
      </header>
      <SubNav id={id} active="clauses" />

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="text-lg font-bold text-slate-100">Key Clauses</h1>
          <span className="text-xs text-slate-500 ml-auto">
            {provisions.length.toLocaleString()} provision{provisions.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex flex-wrap gap-3">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-300 focus:outline-none focus:border-blue-500"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c || "All categories"}</option>
            ))}
          </select>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search provisions…"
            className="flex-1 min-w-40 text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
        </div>

        {isLoading && (
          <div className="text-slate-500 text-sm animate-pulse text-center py-12">Loading provisions…</div>
        )}

        {!isLoading && provisions.length === 0 && (
          <div className="rounded-lg border border-slate-800 p-8 text-center text-slate-600 text-sm">
            No provisions match your filters.
          </div>
        )}

        <div className="space-y-2">
          {provisions.map((p) => {
            const pdfUrl = p.source_url && p.page_ref != null ? `${p.source_url}#page=${p.page_ref}` : p.source_url;
            return (
              <div key={p.id} className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-2">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-blue-400">
                      {p.provision_key.replace(/_/g, " ")}
                    </span>
                    <span className="text-xs text-slate-500 capitalize px-1.5 py-0.5 rounded bg-slate-800">
                      {p.category}
                    </span>
                    {!p.human_verified && (
                      <span className="flex items-center gap-1 text-xs text-amber-500">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                        unverified
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <ConfidenceBadge v={p.confidence} />
                    {pdfUrl && (
                      <a href={pdfUrl} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-blue-500 hover:text-blue-400">
                        {p.page_ref != null ? `p.${p.page_ref}` : "PDF"}
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">Value:</span>
                  <ProvenanceValue
                    value={p.value_numeric != null ? parseFloat(p.value_numeric) : p.value_text}
                    unit={p.unit}
                    sourceUrl={p.source_url}
                    pageRef={p.page_ref}
                    humanVerified={p.human_verified}
                    confidence={p.confidence}
                    retrievedAt={p.retrieved_at}
                  />
                </div>
                {p.clause_excerpt && (
                  <blockquote className="text-xs text-slate-400 italic border-l-2 border-slate-700 pl-3 leading-relaxed">
                    "{p.clause_excerpt}"
                  </blockquote>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
