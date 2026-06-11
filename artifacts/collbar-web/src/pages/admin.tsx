import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useHealthCheck } from "@workspace/api-client-react";
import { useLocation } from "wouter";

const DB_TABLES = [
  "districts",
  "source_documents",
  "factfinding_proposals",
  "benchmarks",
  "contracts",
  "contract_provisions",
  "settlements",
  "users",
] as const;

interface CrawlReport {
  crawlState: {
    districtsLoaded: number;
    cbaDocsFound: number;
    cbaDocsDownloaded: number;
    cbaDocsSkipped: number;
    cbaDocsFailed: number;
    districtMatched: number;
    districtUnmatched: number;
    matchRatePct: number | null;
    ffProposalsLoaded: number;
    ffPageAccessible: boolean;
    wageSettlementDownloaded: number;
    wageSettlementFailedYears: string[];
    manualReviewCount: number;
    unmatchedEmployerCount: number;
    unmatchedEmployers: string[];
    lastUpdated: string | null;
  };
  tableCounts: Record<string, number>;
}

interface ExtractionReport {
  runCounts: Record<string, number>;
  totalContracts: number;
  provisionsByCategory: { category: string; count: number }[];
  reviewQueueCount: number;
  humanVerifiedCount: number;
  totalSettlements: number;
  settlementsByMethod: { method: string; count: number }[];
  totalCbaDocs: number;
  processedDocs: number;
}

interface ReviewQueueItem {
  id: number;
  category: string;
  provision_key: string;
  value_numeric: string | null;
  value_text: string | null;
  unit: string | null;
  clause_excerpt: string | null;
  page_ref: number | null;
  confidence: string;
  contract_id: number;
  union_name: string | null;
  unit_scope: string | null;
  effective_start: string | null;
  effective_end: string | null;
  source_url: string | null;
  district_name: string | null;
}

interface ReviewQueueResponse {
  items: ReviewQueueItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function StatusBadge({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono font-medium ${
        ok
          ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
          : "bg-red-950 text-red-400 border border-red-800"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
      {ok ? "OK" : "ERROR"}
    </span>
  );
}

function Metric({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="text-2xl font-bold text-slate-100 font-mono">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div className="text-xs text-slate-400 mt-1">{label}</div>
      {sub && <div className="text-xs text-slate-600 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function apiUrl(path: string) {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, "")}`;
}

/** Build a page-anchored PDF URL when page_ref is known. */
function pdfPageUrl(sourceUrl: string | null, pageRef: number | null): string | null {
  if (!sourceUrl) return null;
  return pageRef != null ? `${sourceUrl}#page=${pageRef}` : sourceUrl;
}

// ---------------------------------------------------------------------------
// Admin session hook — checks whether the browser has an active admin session
// ---------------------------------------------------------------------------

function useAdminSession() {
  return useQuery<{ authenticated: boolean }>({
    queryKey: ["/api/admin/session"],
    queryFn: () =>
      fetch(apiUrl("/api/admin/session"), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------

function useCrawlReport() {
  return useQuery<CrawlReport>({
    queryKey: ["/api/admin/crawl-report"],
    queryFn: () =>
      fetch(apiUrl("/api/admin/crawl-report"), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    refetchInterval: 20_000,
  });
}

function useExtractionReport() {
  return useQuery<ExtractionReport>({
    queryKey: ["/api/admin/extraction-report"],
    queryFn: () =>
      fetch(apiUrl("/api/admin/extraction-report"), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    refetchInterval: 30_000,
  });
}

function useReviewQueue(page: number, category: string) {
  return useQuery<ReviewQueueResponse>({
    queryKey: ["/api/admin/review-queue", page, category],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (category) params.set("category", category);
      return fetch(apiUrl(`/api/admin/review-queue?${params}`), { credentials: "include" }).then(
        (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Admin login modal
// ---------------------------------------------------------------------------

function AdminLoginModal({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const r = await fetch(apiUrl("/api/admin/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Login failed");
      } else {
        onSuccess();
      }
    } catch {
      setError("Network error — is the API server running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <h2 className="text-sm font-semibold text-slate-200 mb-1">Admin Authentication</h2>
        <p className="text-xs text-slate-500 mb-5">
          Enter the server-side ADMIN_TOKEN to unlock mutation endpoints.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Admin token"
            autoFocus
            className="w-full text-xs bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || !token}
            className="w-full text-xs px-3 py-2 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors"
          >
            {loading ? "Authenticating…" : "Authenticate"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview Tab
// ---------------------------------------------------------------------------

function OverviewTab() {
  const { data: health, isLoading: healthLoading, isError: healthError } = useHealthCheck();
  const { data: report } = useCrawlReport();
  const counts = report?.tableCounts ?? {};

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">API Health</h2>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-slate-300 text-sm">Express API Server</span>
            <span className="text-slate-600 text-xs">GET /api/healthz</span>
          </div>
          {healthLoading ? (
            <span className="text-slate-500 text-xs animate-pulse">checking…</span>
          ) : (
            <StatusBadge ok={!healthError && !!health} />
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Database Tables
        </h2>
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 border-b border-slate-800">
              <tr>
                <th className="text-left px-4 py-2.5 text-slate-400 font-medium text-xs">Table</th>
                <th className="text-right px-4 py-2.5 text-slate-400 font-medium text-xs">Rows</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {DB_TABLES.map((table) => {
                const n = counts[table];
                return (
                  <tr key={table} className="bg-slate-950 hover:bg-slate-900/50 transition-colors">
                    <td className="px-4 py-3 text-slate-300 text-xs">{table}</td>
                    <td className="px-4 py-3 text-right">
                      {n === undefined ? (
                        <span className="text-slate-600 text-xs">—</span>
                      ) : n < 0 ? (
                        <span className="text-red-500 text-xs">error</span>
                      ) : (
                        <span className={`text-xs font-mono ${n > 0 ? "text-emerald-400" : "text-slate-500"}`}>
                          {n.toLocaleString()}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Build Phases</h2>
        <div className="space-y-2">
          {[
            { phase: "Phase 1", label: "Database Schema & Bootstrap", done: true },
            { phase: "Phase 2", label: "Acquire the Corpus (Scrapers)", done: true },
            { phase: "Phase 3", label: "LLM Extraction Pipeline", done: false, active: true },
            { phase: "Phase 4", label: "The Dashboard", done: false },
            { phase: "Phase 5", label: "Hardening", done: false },
          ].map(({ phase, label, done, active }) => (
            <div
              key={phase}
              className={`rounded-md border px-4 py-3 flex items-center justify-between ${
                done
                  ? "border-emerald-800 bg-emerald-950/30"
                  : active
                  ? "border-blue-800 bg-blue-950/20"
                  : "border-slate-800 bg-slate-900/30"
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`text-xs font-semibold ${
                    done ? "text-emerald-400" : active ? "text-blue-400" : "text-slate-500"
                  }`}
                >
                  {phase}
                </span>
                <span
                  className={`text-xs ${
                    done ? "text-slate-300" : active ? "text-slate-300" : "text-slate-500"
                  }`}
                >
                  {label}
                </span>
              </div>
              {done && <span className="text-xs text-emerald-500 font-medium">✓ Complete</span>}
              {active && !done && (
                <span className="text-xs text-blue-400 font-medium animate-pulse">⚙ In Progress</span>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crawl Report Tab
// ---------------------------------------------------------------------------

function CrawlReportTab() {
  const { data, isLoading, isError, refetch } = useCrawlReport();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500 text-sm animate-pulse">
        Loading crawl report…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 p-6 text-red-400 text-sm">
        Failed to load crawl report. Make sure the API server is running.
      </div>
    );
  }

  const { crawlState, tableCounts } = data;
  const rate = crawlState.matchRatePct;
  const rateOk = rate !== null && rate >= 90;
  const total = crawlState.districtMatched + crawlState.districtUnmatched;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {crawlState.lastUpdated
            ? `Last updated: ${new Date(crawlState.lastUpdated).toLocaleString()}`
            : "No crawl state — run pipeline scripts to populate data."}
        </p>
        <button
          onClick={() => refetch()}
          className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1 rounded border border-slate-700 hover:border-slate-500 transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Corpus Metrics</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric label="Districts loaded" value={crawlState.districtsLoaded} sub="from FY2025 Ohio DEW XLSX" />
          <Metric
            label="CBA PDFs downloaded"
            value={crawlState.cbaDocsDownloaded}
            sub={`${crawlState.cbaDocsFound.toLocaleString()} school-sector found`}
          />
          <Metric
            label="FF proposals"
            value={crawlState.ffProposalsLoaded}
            sub={crawlState.ffPageAccessible ? "from SERB" : "page requires JS render"}
          />
          <Metric
            label="Wage settlement PDFs"
            value={crawlState.wageSettlementDownloaded}
            sub={
              crawlState.wageSettlementFailedYears.length > 0
                ? `missing: ${crawlState.wageSettlementFailedYears.join(", ")}`
                : "all years present"
            }
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">District Match Rate</h2>
        <div
          className={`rounded-lg border p-5 ${
            rate === null
              ? "border-slate-800 bg-slate-900"
              : rateOk
              ? "border-emerald-800 bg-emerald-950/20"
              : "border-amber-800 bg-amber-950/20"
          }`}
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <span
                className={`text-4xl font-bold font-mono ${
                  rate === null ? "text-slate-500" : rateOk ? "text-emerald-400" : "text-amber-400"
                }`}
              >
                {rate !== null ? `${rate}%` : "—"}
              </span>
              <span className="text-xs text-slate-500 ml-3">threshold ≥ 90%</span>
            </div>
            {rate !== null && <StatusBadge ok={rateOk} />}
          </div>
          {rate !== null && (
            <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden mb-3">
              <div
                className={`h-full rounded-full transition-all duration-500 ${rateOk ? "bg-emerald-500" : "bg-amber-500"}`}
                style={{ width: `${Math.min(100, rate)}%` }}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-5 text-xs text-slate-400">
            <span>
              Auto-matched:{" "}
              <span className="text-emerald-400 font-mono">{crawlState.districtMatched.toLocaleString()}</span>
            </span>
            <span>
              Unmatched/review:{" "}
              <span className="text-amber-400 font-mono">{crawlState.districtUnmatched.toLocaleString()}</span>
            </span>
            <span>
              Total attempted:{" "}
              <span className="text-slate-300 font-mono">{total.toLocaleString()}</span>
            </span>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Live Table Row Counts</h2>
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-900 border-b border-slate-800">
              <tr>
                <th className="text-left px-4 py-2 text-xs text-slate-400 font-medium">Table</th>
                <th className="text-right px-4 py-2 text-xs text-slate-400 font-medium">Rows</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {Object.entries(tableCounts).map(([table, n]) => (
                <tr key={table} className="bg-slate-950 hover:bg-slate-900/50">
                  <td className="px-4 py-3 text-xs text-slate-300 font-mono">{table}</td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={`text-xs font-mono ${
                        n < 0 ? "text-red-400" : n > 0 ? "text-emerald-400" : "text-slate-600"
                      }`}
                    >
                      {n < 0 ? "error" : n.toLocaleString()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {crawlState.unmatchedEmployers.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
            Unmatched Employers{" "}
            <span className="text-amber-500 normal-case font-normal">
              ({crawlState.unmatchedEmployerCount})
            </span>
          </h2>
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 max-h-48 overflow-y-auto">
            <ul className="space-y-1">
              {crawlState.unmatchedEmployers.map((emp) => (
                <li key={emp} className="text-xs text-amber-400 font-mono">
                  {emp}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extraction Report Tab
// ---------------------------------------------------------------------------

function ExtractionReportTab() {
  const { data, isLoading, isError, refetch } = useExtractionReport();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500 text-sm animate-pulse">
        Loading extraction report…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 p-6 text-red-400 text-sm">
        Failed to load extraction report.
      </div>
    );
  }

  const coveragePct =
    data.totalCbaDocs > 0
      ? Math.round((data.processedDocs / data.totalCbaDocs) * 1000) / 10
      : null;

  return (
    <div className="space-y-8">
      <div className="flex justify-end">
        <button
          onClick={() => refetch()}
          className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1 rounded border border-slate-700 hover:border-slate-500 transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Extraction Overview</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric label="Contracts extracted" value={data.totalContracts} />
          <Metric
            label="Provisions extracted"
            value={data.provisionsByCategory.reduce((s, r) => s + r.count, 0)}
          />
          <Metric label="Settlements derived" value={data.totalSettlements} />
          <Metric
            label="Review queue"
            value={data.reviewQueueCount}
            sub="confidence < 0.8, unverified"
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Extraction Runs</h2>
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-900 border-b border-slate-800">
              <tr>
                <th className="text-left px-4 py-2 text-xs text-slate-400 font-medium">Status</th>
                <th className="text-right px-4 py-2 text-xs text-slate-400 font-medium">Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {Object.entries(data.runCounts).length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-4 py-6 text-center text-xs text-slate-600">
                    No extraction runs yet — run pipeline/06_extract_contracts.py
                  </td>
                </tr>
              ) : (
                Object.entries(data.runCounts).map(([status, count]) => (
                  <tr key={status} className="bg-slate-950 hover:bg-slate-900/50">
                    <td className="px-4 py-3 text-xs font-mono">
                      <span
                        className={
                          status === "success"
                            ? "text-emerald-400"
                            : status === "failed"
                            ? "text-red-400"
                            : "text-amber-400"
                        }
                      >
                        {status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">
                      {count.toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Source Coverage
        </h2>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-400">
              {data.processedDocs.toLocaleString()} / {data.totalCbaDocs.toLocaleString()} CBA PDFs processed
            </span>
            <span
              className={`text-lg font-bold font-mono ${
                coveragePct === null
                  ? "text-slate-500"
                  : coveragePct >= 95
                  ? "text-emerald-400"
                  : "text-amber-400"
              }`}
            >
              {coveragePct !== null ? `${coveragePct}%` : "—"}
            </span>
          </div>
          {coveragePct !== null && (
            <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className={`h-full rounded-full ${coveragePct >= 95 ? "bg-emerald-500" : "bg-amber-500"}`}
                style={{ width: `${Math.min(100, coveragePct)}%` }}
              />
            </div>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Provisions by Category
        </h2>
        {data.provisionsByCategory.length === 0 ? (
          <div className="text-xs text-slate-600 py-4">No provisions yet.</div>
        ) : (
          <div className="rounded-lg border border-slate-800 overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="text-left px-4 py-2 text-xs text-slate-400 font-medium">Category</th>
                  <th className="text-right px-4 py-2 text-xs text-slate-400 font-medium">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {data.provisionsByCategory.map(({ category, count }) => (
                  <tr key={category} className="bg-slate-950 hover:bg-slate-900/50">
                    <td className="px-4 py-3 text-xs text-slate-300 font-mono">{category}</td>
                    <td className="px-4 py-3 text-right text-xs font-mono text-emerald-400">
                      {count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Settlements by Method
        </h2>
        {data.settlementsByMethod.length === 0 ? (
          <div className="text-xs text-slate-600 py-4">No settlements yet.</div>
        ) : (
          <div className="rounded-lg border border-slate-800 overflow-hidden">
            <table className="w-full">
              <tbody className="divide-y divide-slate-800/50">
                {data.settlementsByMethod.map(({ method, count }) => (
                  <tr key={method} className="bg-slate-950 hover:bg-slate-900/50">
                    <td className="px-4 py-3 text-xs text-slate-300 font-mono">{method}</td>
                    <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">
                      {count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review Queue Tab
// ---------------------------------------------------------------------------

const CATEGORIES = [
  "", "compensation", "insurance", "retirement", "leave",
  "workday", "evaluation", "rif", "grievance", "other",
];

function ConfidenceBadge({ value }: { value: string }) {
  const n = parseFloat(value);
  const color =
    n >= 0.8 ? "text-emerald-400" : n >= 0.5 ? "text-amber-400" : "text-red-400";
  return <span className={`font-mono text-xs ${color}`}>{(n * 100).toFixed(0)}%</span>;
}

function ReviewQueueTab() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState("");
  const [actionId, setActionId] = useState<number | null>(null);
  const [correcting, setCorrecting] = useState<{ id: number; current: string } | null>(null);
  const [correctedValue, setCorrectedValue] = useState("");
  const [showLogin, setShowLogin] = useState(false);

  const { data: session, refetch: refetchSession } = useAdminSession();
  const { data, isLoading, isError } = useReviewQueue(page, category);

  const mutation = useMutation({
    mutationFn: async ({
      id,
      action,
      correctedValue,
    }: {
      id: number;
      action: "approve" | "correct" | "reject";
      correctedValue?: string;
    }) => {
      const r = await fetch(apiUrl(`/api/admin/review-queue/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action, correctedValue }),
      });
      if (r.status === 401) {
        setShowLogin(true);
        throw new Error("401");
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/review-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/extraction-report"] });
      setActionId(null);
      setCorrecting(null);
      setCorrectedValue("");
    },
  });

  const act = (id: number, action: "approve" | "reject") => {
    if (!session?.authenticated) {
      setShowLogin(true);
      return;
    }
    setActionId(id);
    mutation.mutate({ id, action });
  };

  const submitCorrection = (id: number) => {
    if (!session?.authenticated) {
      setShowLogin(true);
      return;
    }
    mutation.mutate({ id, action: "correct", correctedValue });
  };

  return (
    <div className="space-y-6">
      {showLogin && (
        <AdminLoginModal
          onSuccess={() => {
            setShowLogin(false);
            refetchSession();
          }}
        />
      )}

      {/* Auth banner */}
      {!session?.authenticated && (
        <div className="flex items-center justify-between rounded-lg border border-amber-800 bg-amber-950/20 px-4 py-3">
          <span className="text-xs text-amber-400">
            Admin session required to approve / correct / reject items.
          </span>
          <button
            onClick={() => setShowLogin(true)}
            className="text-xs px-3 py-1 rounded bg-amber-800 hover:bg-amber-700 text-amber-100 transition-colors"
          >
            Log in
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400">Category</label>
          <select
            value={category}
            onChange={(e) => { setCategory(e.target.value); setPage(1); }}
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-300 focus:outline-none focus:border-blue-500"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c || "All categories"}
              </option>
            ))}
          </select>
        </div>
        <span className="text-xs text-slate-500 ml-auto">
          {data ? `${data.total.toLocaleString()} items requiring review` : ""}
        </span>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500 text-sm animate-pulse">
          Loading review queue…
        </div>
      )}

      {isError && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 p-6 text-red-400 text-sm">
          Failed to load review queue.
        </div>
      )}

      {data?.items.length === 0 && !isLoading && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/20 p-8 text-center">
          <p className="text-emerald-400 text-sm font-medium">Review queue is empty ✓</p>
          <p className="text-slate-500 text-xs mt-1">
            All provisions have confidence ≥ 0.8 or have been verified.
          </p>
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="space-y-3">
          {data.items.map((item) => {
            const pageUrl = pdfPageUrl(item.source_url, item.page_ref);
            return (
              <div
                key={item.id}
                className="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden"
              >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-800">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono text-blue-400">{item.provision_key}</span>
                    <span className="text-xs text-slate-500">{item.category}</span>
                    <ConfidenceBadge value={item.confidence} />
                  </div>
                  <div className="text-xs text-slate-500">
                    {item.district_name || "Unknown district"} •{" "}
                    {item.union_name || item.unit_scope || ""}
                    {item.effective_start ? ` • ${item.effective_start.slice(0, 4)}` : ""}
                  </div>
                </div>

                {/* Value */}
                <div className="px-4 py-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-400">Value:</span>
                    <span className="text-sm font-mono text-slate-200">
                      {item.value_numeric != null
                        ? `${item.value_numeric}${item.unit ? ` ${item.unit}` : ""}`
                        : item.value_text || "—"}
                    </span>
                    {item.page_ref != null && (
                      <span className="text-xs text-slate-600">p.{item.page_ref}</span>
                    )}
                  </div>

                  {item.clause_excerpt && (
                    <blockquote className="text-xs text-slate-400 italic border-l-2 border-slate-700 pl-3 leading-relaxed">
                      "{item.clause_excerpt}"
                    </blockquote>
                  )}

                  {pageUrl && (
                    <a
                      href={pageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:text-blue-400 truncate block"
                    >
                      {item.page_ref != null
                        ? `${item.source_url} — page ${item.page_ref}`
                        : item.source_url}
                    </a>
                  )}
                </div>

                {/* Correction form */}
                {correcting?.id === item.id && (
                  <div className="px-4 py-3 border-t border-slate-800 bg-slate-950 flex items-center gap-2">
                    <input
                      type="text"
                      value={correctedValue}
                      onChange={(e) => setCorrectedValue(e.target.value)}
                      placeholder="Enter corrected value"
                      className="flex-1 text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-blue-500"
                      autoFocus
                    />
                    <button
                      onClick={() => submitCorrection(item.id)}
                      disabled={mutation.isPending}
                      className="text-xs px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setCorrecting(null); setCorrectedValue(""); }}
                      className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Actions */}
                {correcting?.id !== item.id && (
                  <div className="px-4 py-2 border-t border-slate-800 flex items-center gap-2 bg-slate-950">
                    <button
                      onClick={() => act(item.id, "approve")}
                      disabled={mutation.isPending && actionId === item.id}
                      className="text-xs px-3 py-1 rounded bg-emerald-900 hover:bg-emerald-800 text-emerald-300 border border-emerald-800 disabled:opacity-50"
                    >
                      ✓ Approve
                    </button>
                    <button
                      onClick={() => {
                        if (!session?.authenticated) { setShowLogin(true); return; }
                        setCorrecting({ id: item.id, current: item.value_text ?? String(item.value_numeric ?? "") });
                        setCorrectedValue(item.value_text ?? String(item.value_numeric ?? ""));
                      }}
                      className="text-xs px-3 py-1 rounded bg-blue-900 hover:bg-blue-800 text-blue-300 border border-blue-800"
                    >
                      ✎ Correct
                    </button>
                    <button
                      onClick={() => act(item.id, "reject")}
                      disabled={mutation.isPending && actionId === item.id}
                      className="text-xs px-3 py-1 rounded bg-red-950 hover:bg-red-900 text-red-400 border border-red-900 disabled:opacity-50"
                    >
                      ✗ Reject
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Pagination */}
          {data.pages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
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
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell with tab routing
// ---------------------------------------------------------------------------

type TabKey = "overview" | "crawl-report" | "extraction-report" | "review-queue";

const TABS: { key: TabKey; label: string; path: string }[] = [
  { key: "overview", label: "Overview", path: "/admin" },
  { key: "crawl-report", label: "Crawl Report", path: "/admin/crawl-report" },
  { key: "extraction-report", label: "Extraction", path: "/admin/extraction-report" },
  { key: "review-queue", label: "Review Queue", path: "/admin/review-queue" },
];

function activeTab(location: string): TabKey {
  if (location.includes("review-queue")) return "review-queue";
  if (location.includes("extraction-report")) return "extraction-report";
  if (location.includes("crawl-report")) return "crawl-report";
  return "overview";
}

export default function AdminPage() {
  const [location, setLocation] = useLocation();
  const tab = activeTab(location);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-mono">
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a href="/" className="text-slate-500 hover:text-slate-300 text-sm transition-colors">
            ← CollBar
          </a>
          <span className="text-slate-700">/</span>
          <span className="text-slate-200 font-semibold text-sm">Admin</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>Phase 3</span>
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          <span>LLM Extraction</span>
        </div>
      </header>

      <div className="border-b border-slate-800 px-6">
        <nav className="flex -mb-px">
          {TABS.map(({ key, label, path }) => (
            <button
              key={key}
              onClick={() => setLocation(path)}
              className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                tab === key
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {tab === "overview" && <OverviewTab />}
        {tab === "crawl-report" && <CrawlReportTab />}
        {tab === "extraction-report" && <ExtractionReportTab />}
        {tab === "review-queue" && <ReviewQueueTab />}
      </main>
    </div>
  );
}
