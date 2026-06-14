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
  "alerts",
  "cdss_staging",
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
    cbaIndexedCount: number;
    cbaMatchedCount: number;
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
  auditSampleCount: number;
  auditReviewedCount: number;
  auditAgreementRate: number | null;
  stateDocMap: Record<string, { total: number; processed: number }>;
  stateRunMap: Record<string, Record<string, number>>;
}

interface CronJobStatus {
  running: boolean;
  pid: number | null;
  tail: string[];
  lastRunAt: string | null;
  lastStatus: "running" | "success" | "error" | null;
}

interface IlCbaCoverage {
  districtsWithUrl: number;
  attempted: number;
  found: number;
  failed: number;
  skipped: number;
  noUrl: number;
  coveragePct: number | null;
  lastUpdated: string | null;
}

interface IlCbaDistrictLogItem {
  district_name: string;
  county: string | null;
  enrollment: number | null;
  website_url: string | null;
  state_district_id: string;
  crawl_status: string;
  last_attempted: string | null;
  storage_key: string | null;
  pdf_url: string | null;
  found_via: string | null;
  last_settlement_year: string | number | null;
}

interface IlCbaDistrictLogResponse {
  items: IlCbaDistrictLogItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

interface DirectoryRefreshStatus {
  running: boolean;
  pid: number | null;
  il_with_url: number;
  latest: {
    id: number;
    run_at: string;
    file_hash: string | null;
    row_count: number | null;
    new_districts: number | null;
    updated_districts: number | null;
    with_website: number | null;
    changed: boolean | null;
    status: string;
    error: string | null;
  } | null;
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
  is_audit_sample: boolean;
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

function LoginRequiredCard({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="rounded-lg border border-amber-800/60 bg-amber-950/10 p-10 text-center space-y-3">
      <p className="text-amber-300 text-sm font-medium">Admin login required</p>
      <p className="text-slate-500 text-xs">Sign in with your ADMIN_TOKEN to view this data.</p>
      <button
        onClick={onLogin}
        className="text-xs px-4 py-2 rounded bg-amber-800 hover:bg-amber-700 text-amber-100 transition-colors"
      >
        Log in
      </button>
    </div>
  );
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
    retry: false,
  });
}

function useIlCbaCoverage() {
  return useQuery<IlCbaCoverage>({
    queryKey: ["/api/admin/il-cba-coverage"],
    queryFn: () =>
      fetch(apiUrl("/api/admin/il-cba-coverage"), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    refetchInterval: 30_000,
    retry: false,
  });
}

function useIlCbaDistrictLog(page: number, status: string, search: string, sort: string, dir: string) {
  return useQuery<IlCbaDistrictLogResponse>({
    queryKey: ["/api/admin/il-cba-district-log", page, status, search, sort, dir],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "50", sort, dir });
      if (status) params.set("status", status);
      if (search) params.set("search", search);
      return fetch(apiUrl(`/api/admin/il-cba-district-log?${params}`), { credentials: "include" }).then(
        (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
      );
    },
    retry: false,
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
    retry: false,
  });
}

function useDirectoryRefreshStatus() {
  return useQuery<DirectoryRefreshStatus>({
    queryKey: ["/api/admin/directory-refresh-status"],
    queryFn: () =>
      fetch(apiUrl("/api/admin/directory-refresh-status"), { credentials: "include" }).then(
        (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
      ),
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : 30_000),
    retry: false,
  });
}

function useIlCrawlStatus() {
  return useQuery<CronJobStatus>({
    queryKey: ["/api/admin/il-crawl-status"],
    queryFn: () =>
      fetch(apiUrl("/api/admin/il-crawl-status"), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : 30_000),
    retry: false,
  });
}

function useExtractionCronStatus() {
  return useQuery<CronJobStatus>({
    queryKey: ["/api/admin/extraction-cron-status"],
    queryFn: () =>
      fetch(apiUrl("/api/admin/extraction-cron-status"), { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : 30_000),
    retry: false,
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
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Admin login redirect helper
// ---------------------------------------------------------------------------

function goToLogin() {
  window.location.href = `${import.meta.env.BASE_URL}login`;
}

// ---------------------------------------------------------------------------
// Overview Tab
// ---------------------------------------------------------------------------

function OverviewTab() {
  const { data: health, isLoading: healthLoading, isError: healthError } = useHealthCheck();
  const { data: report } = useCrawlReport();
  const { data: extraction } = useExtractionReport();
  const counts = report?.tableCounts ?? {};

  const totalCbaDocs = extraction?.totalCbaDocs ?? 0;
  const processedDocs = extraction?.processedDocs ?? 0;
  const phase3Done = totalCbaDocs > 0 && processedDocs >= totalCbaDocs;
  const phase3Active = processedDocs > 0 && !phase3Done;
  const phase3Pending = totalCbaDocs > 0 && processedDocs === 0;

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
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Pipeline Status</h2>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="text-2xl font-bold font-mono text-emerald-400">
              {(counts["districts"] ?? 0).toLocaleString()}
            </div>
            <div className="text-xs text-slate-400 mt-1">Districts in DB</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <div className="text-2xl font-bold font-mono text-blue-400">
              {totalCbaDocs.toLocaleString()}
            </div>
            <div className="text-xs text-slate-400 mt-1">PDFs indexed by scraper</div>
          </div>
          <div
            className={`rounded-lg border p-4 ${
              phase3Pending
                ? "border-amber-800 bg-amber-950/20"
                : phase3Active
                ? "border-blue-800 bg-blue-950/10"
                : "border-slate-800 bg-slate-900"
            }`}
          >
            <div
              className={`text-2xl font-bold font-mono ${
                phase3Pending
                  ? "text-amber-400"
                  : phase3Done
                  ? "text-emerald-400"
                  : "text-blue-400"
              }`}
            >
              {processedDocs} / {totalCbaDocs}
            </div>
            <div className="text-xs text-slate-400 mt-1">PDFs extracted by LLM</div>
            {phase3Pending && (
              <div className="text-xs text-amber-500/80 mt-2 font-mono leading-snug">
                Not started — run:
                <br />
                <code className="text-amber-400">python3 pipeline/06_extract_contracts.py</code>
              </div>
            )}
          </div>
        </div>
        {phase3Pending && (
          <div className="rounded-lg border border-amber-800/60 bg-amber-950/10 px-4 py-3 text-xs text-amber-300 leading-relaxed">
            <span className="font-semibold text-amber-200">Why are contracts and settlements empty?</span>{" "}
            The scraper has indexed {totalCbaDocs} PDFs but the LLM extraction pipeline has never been
            run. Contracts, settlements, and provisions stay empty until you run{" "}
            <code className="font-mono text-amber-400">python3 pipeline/06_extract_contracts.py</code>
            {" "}(requires <code className="font-mono text-amber-400">ANTHROPIC_API_KEY</code> to be set).
          </div>
        )}
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
            {
              phase: "Phase 3",
              label: "LLM Extraction Pipeline",
              done: phase3Done,
              active: phase3Active || phase3Pending,
              sub: totalCbaDocs > 0
                ? `${processedDocs.toLocaleString()} / ${totalCbaDocs.toLocaleString()} docs extracted`
                : "No PDFs indexed yet",
            },
            { phase: "Phase 4", label: "The Dashboard", done: true },
            { phase: "Phase 5", label: "Hardening", done: true },
          ].map(({ phase, label, done, active, sub }) => (
            <div
              key={phase}
              className={`rounded-md border px-4 py-3 flex items-center justify-between ${
                done
                  ? "border-emerald-800 bg-emerald-950/30"
                  : active
                  ? "border-amber-800 bg-amber-950/10"
                  : "border-slate-800 bg-slate-900/30"
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`text-xs font-semibold ${
                    done ? "text-emerald-400" : active ? "text-amber-400" : "text-slate-500"
                  }`}
                >
                  {phase}
                </span>
                <div>
                  <span
                    className={`text-xs ${
                      done ? "text-slate-300" : active ? "text-slate-300" : "text-slate-500"
                    }`}
                  >
                    {label}
                  </span>
                  {sub && (
                    <div className="text-xs text-slate-500 mt-0.5">{sub}</div>
                  )}
                </div>
              </div>
              {done && <span className="text-xs text-emerald-500 font-medium whitespace-nowrap">✓ Complete</span>}
              {active && !done && (
                <span className="text-xs text-amber-400 font-medium whitespace-nowrap">⚠ Pending</span>
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

// ---------------------------------------------------------------------------
// IL CBA District Log status badge
// ---------------------------------------------------------------------------

function CrawlStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    found:         { label: "found",         cls: "bg-emerald-950 text-emerald-400 border-emerald-800" },
    failed:        { label: "failed",        cls: "bg-red-950 text-red-400 border-red-800" },
    search_failed: { label: "search failed", cls: "bg-orange-950 text-orange-400 border-orange-800" },
    no_url:        { label: "no URL",        cls: "bg-slate-900 text-slate-500 border-slate-700" },
    skip:          { label: "skip",          cls: "bg-slate-900 text-slate-500 border-slate-700" },
    not_crawled:   { label: "not crawled",   cls: "bg-amber-950 text-amber-400 border-amber-800" },
  };
  const { label, cls } = map[status] ?? { label: status, cls: "bg-slate-900 text-slate-400 border-slate-700" };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono border ${cls}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// IL CBA District Log table (within CrawlReportTab)
// ---------------------------------------------------------------------------

type SortCol = "district_name" | "enrollment" | "crawl_status" | "last_attempted" | "last_settlement_year";
type SortDir = "asc" | "desc";

function IlCbaDistrictLogTable() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("enrollment");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const handleSearchChange = (val: string) => {
    setSearchInput(val);
    setPage(1);
  };

  // Debounce search to avoid hammering API on every keystroke
  const applySearch = () => {
    setDebouncedSearch(searchInput);
    setPage(1);
  };

  const handleSort = (col: SortCol) => {
    if (col === sortCol) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "district_name" || col === "crawl_status" ? "asc" : "desc");
    }
    setPage(1);
  };

  const SortIcon = ({ col }: { col: SortCol }) => {
    if (col !== sortCol) return <span className="text-slate-700 ml-1">↕</span>;
    return <span className="text-blue-400 ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  const thCls = "text-left px-3 py-2 text-slate-400 font-medium whitespace-nowrap cursor-pointer select-none hover:text-slate-200 transition-colors";
  const thClsRight = "text-right px-3 py-2 text-slate-400 font-medium whitespace-nowrap cursor-pointer select-none hover:text-slate-200 transition-colors";

  const { data, isLoading, isError } = useIlCbaDistrictLog(page, statusFilter, debouncedSearch, sortCol, sortDir);

  const STATUS_OPTIONS = [
    { value: "",             label: "All statuses" },
    { value: "found",        label: "Found" },
    { value: "failed",       label: "Failed" },
    { value: "search_failed",label: "Search failed" },
    { value: "no_url",       label: "No URL" },
    { value: "not_crawled",  label: "Not crawled yet" },
  ];

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex flex-1 min-w-[180px] items-center gap-1 rounded border border-slate-700 bg-slate-950 px-2 py-1">
          <span className="text-slate-600 text-xs">🔍</span>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySearch()}
            placeholder="Search district name…"
            className="flex-1 bg-transparent text-xs text-slate-200 placeholder-slate-600 focus:outline-none"
          />
          {searchInput && (
            <button
              onClick={() => { setSearchInput(""); setDebouncedSearch(""); setPage(1); }}
              className="text-slate-600 hover:text-slate-400 text-xs"
            >
              ✕
            </button>
          )}
        </div>
        <button
          onClick={applySearch}
          className="text-xs px-3 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition-colors"
        >
          Search
        </button>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="text-xs bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-300 focus:outline-none focus:border-blue-500"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {data && (
          <span className="text-xs text-slate-500 ml-auto whitespace-nowrap">
            {data.total.toLocaleString()} districts
            {statusFilter && ` · filter: ${statusFilter}`}
          </span>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="py-8 text-center text-xs text-slate-500 animate-pulse">Loading districts…</div>
      ) : isError ? (
        <div className="py-6 text-center text-xs text-red-400">Failed to load district log.</div>
      ) : !data || data.items.length === 0 ? (
        <div className="py-8 text-center text-xs text-slate-600">No districts match the current filters.</div>
      ) : (
        <>
          <div className="rounded-lg border border-slate-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className={thCls} onClick={() => handleSort("district_name")}>
                    District<SortIcon col="district_name" />
                  </th>
                  <th className="text-left px-3 py-2 text-slate-400 font-medium whitespace-nowrap">County</th>
                  <th className={thClsRight} onClick={() => handleSort("enrollment")}>
                    Enrollment<SortIcon col="enrollment" />
                  </th>
                  <th className="text-left px-3 py-2 text-slate-400 font-medium whitespace-nowrap">Website URL</th>
                  <th className={thCls} onClick={() => handleSort("crawl_status")}>
                    Status<SortIcon col="crawl_status" />
                  </th>
                  <th className={thCls} onClick={() => handleSort("last_attempted")}>
                    Last Attempted<SortIcon col="last_attempted" />
                  </th>
                  <th className="text-left px-3 py-2 text-slate-400 font-medium whitespace-nowrap">Storage Key</th>
                  <th className={thClsRight} onClick={() => handleSort("last_settlement_year")}>
                    Last Settlement<SortIcon col="last_settlement_year" />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {data.items.map((row) => (
                  <tr key={row.state_district_id || row.district_name} className="bg-slate-950 hover:bg-slate-900/50 transition-colors">
                    <td className="px-3 py-2.5 text-slate-200 font-medium max-w-[180px]">
                      <span className="truncate block" title={row.district_name}>
                        {row.district_name}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">
                      {row.county ?? <span className="text-slate-700">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-400 font-mono whitespace-nowrap">
                      {row.enrollment != null ? row.enrollment.toLocaleString() : <span className="text-slate-700">—</span>}
                    </td>
                    <td className="px-3 py-2.5 max-w-[140px]">
                      {row.website_url ? (
                        <a
                          href={row.website_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 font-mono text-xs truncate block transition-colors"
                          title={row.website_url}
                        >
                          {row.website_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                        </a>
                      ) : (
                        <span className="text-slate-700">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <CrawlStatusBadge status={row.crawl_status} />
                    </td>
                    <td className="px-3 py-2.5 text-slate-500 font-mono whitespace-nowrap">
                      {row.last_attempted
                        ? new Date(row.last_attempted).toLocaleDateString()
                        : <span className="text-slate-700">—</span>}
                    </td>
                    <td className="px-3 py-2.5 max-w-[160px]">
                      {row.storage_key ? (
                        row.pdf_url ? (
                          <a
                            href={row.pdf_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-500 hover:text-sky-400 font-mono truncate block transition-colors"
                            title={row.storage_key}
                          >
                            {row.storage_key.split("/").pop()}
                          </a>
                        ) : (
                          <span className="text-slate-400 font-mono truncate block" title={row.storage_key}>
                            {row.storage_key.split("/").pop()}
                          </span>
                        )
                      ) : (
                        <span className="text-slate-700">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap">
                      {row.last_settlement_year != null ? (
                        <span className="text-slate-300">{row.last_settlement_year}</span>
                      ) : (
                        <span className="text-slate-700">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.pages > 1 && (
            <div className="flex items-center justify-between pt-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="text-xs px-3 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ← Prev
              </button>
              <span className="text-xs text-slate-500">
                Page {data.page} of {data.pages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
                disabled={page >= data.pages}
                className="text-xs px-3 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DirectoryRefreshCard() {
  const queryClient = useQueryClient();
  const { data, refetch } = useDirectoryRefreshStatus();

  const runNow = useMutation({
    mutationFn: () =>
      fetch(apiUrl("/api/admin/run-directory-refresh"), {
        method: "POST",
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/directory-refresh-status"] });
      refetch();
    },
  });

  const running   = data?.running ?? false;
  const latest    = data?.latest ?? null;
  const ilWithUrl = data?.il_with_url ?? 0;

  const statusColor =
    running                          ? "text-amber-400"
    : latest?.status === "success"   ? "text-emerald-400"
    : latest?.status === "no_change" ? "text-sky-400"
    : latest?.status === "error"     ? "text-red-400"
    : "text-slate-500";

  const statusLabel = running ? "running…" : (latest?.status ?? "never run");

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {running && (
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            )}
            <span className={`text-sm font-mono font-medium ${statusColor}`}>{statusLabel}</span>
          </div>
          <div className="text-xs text-slate-500">
            {latest?.run_at
              ? `Last run: ${new Date(latest.run_at).toLocaleString()}`
              : "No runs yet — click Run now to test"}
          </div>
        </div>
        <button
          onClick={() => runNow.mutate()}
          disabled={running || runNow.isPending}
          className="shrink-0 text-xs px-3 py-1.5 rounded border border-slate-700 hover:border-sky-600 text-slate-400 hover:text-sky-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {running ? "Running…" : runNow.isPending ? "Starting…" : "Run now"}
        </button>
      </div>

      {latest && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="space-y-0.5">
            <div className="text-slate-500">With website URL</div>
            <div className="text-slate-200 font-mono font-semibold">
              {ilWithUrl.toLocaleString()}
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-slate-500">Rows parsed</div>
            <div className="text-slate-200 font-mono font-semibold">
              {latest.row_count !== null ? latest.row_count.toLocaleString() : "—"}
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-slate-500">New districts</div>
            <div className="text-slate-200 font-mono font-semibold">
              {latest.new_districts !== null ? latest.new_districts.toLocaleString() : "—"}
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-slate-500">Updated</div>
            <div className="text-slate-200 font-mono font-semibold">
              {latest.updated_districts !== null ? latest.updated_districts.toLocaleString() : "—"}
            </div>
          </div>
        </div>
      )}

      {latest?.changed === false && latest?.status === "no_change" && (
        <p className="text-xs text-sky-400">
          File unchanged since last run — no districts updated.
        </p>
      )}

      {latest?.status === "error" && latest?.error && (
        <p className="text-xs text-red-400 font-mono truncate" title={latest.error}>
          ✗ {latest.error}
        </p>
      )}
    </div>
  );
}

function ScheduledAutomationsCard() {
  const queryClient = useQueryClient();
  const { data: crawlData, refetch: refetchCrawl } = useIlCrawlStatus();
  const { data: cronData, refetch: refetchCron } = useExtractionCronStatus();

  const runCrawl = useMutation({
    mutationFn: () =>
      fetch(apiUrl("/api/admin/start-il-crawl"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/il-crawl-status"] });
      refetchCrawl();
    },
  });

  const runCron = useMutation({
    mutationFn: () =>
      fetch(apiUrl("/api/admin/run-extraction-cron"), {
        method: "POST",
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/extraction-cron-status"] });
      refetchCron();
    },
  });

  const jobs = [
    {
      label: "IL CBA Crawl",
      schedule: "2 AM · 1st & 15th of month",
      running: crawlData?.running ?? false,
      lastRunAt: crawlData?.lastRunAt ?? null,
      lastStatus: crawlData?.lastStatus ?? null,
      tail: crawlData?.tail ?? [],
      mutate: () => runCrawl.mutate(),
      isPending: runCrawl.isPending,
    },
    {
      label: "Extraction Cron",
      schedule: "3 AM · nightly",
      running: cronData?.running ?? false,
      lastRunAt: cronData?.lastRunAt ?? null,
      lastStatus: cronData?.lastStatus ?? null,
      tail: cronData?.tail ?? [],
      mutate: () => runCron.mutate(),
      isPending: runCron.isPending,
    },
  ];

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 p-5 divide-y divide-slate-800">
      {jobs.map((job) => {
        const statusColor =
          job.running               ? "text-amber-400"
          : job.lastStatus === "success" ? "text-emerald-400"
          : job.lastStatus === "error"   ? "text-red-400"
          : "text-slate-500";
        const statusLabel =
          job.running               ? "running…"
          : job.lastStatus === "success" ? "success"
          : job.lastStatus === "error"   ? "error"
          : "never run";

        return (
          <div key={job.label} className="py-4 first:pt-0 last:pb-0 space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  {job.running && (
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  )}
                  <span className="text-sm font-mono font-medium text-slate-200">{job.label}</span>
                  <span className="text-xs text-slate-600">{job.schedule}</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className={statusColor}>{statusLabel}</span>
                  {job.lastRunAt && (
                    <span className="text-slate-500">
                      Last run: {new Date(job.lastRunAt).toLocaleString()}
                    </span>
                  )}
                </div>
                {!job.running && job.tail.length > 0 && (
                  <div className="text-xs text-slate-600 font-mono truncate max-w-md" title={job.tail[job.tail.length - 1]}>
                    {job.tail[job.tail.length - 1]?.slice(0, 120)}
                  </div>
                )}
              </div>
              <button
                onClick={job.mutate}
                disabled={job.running || job.isPending}
                className="shrink-0 text-xs px-3 py-1.5 rounded border border-slate-700 hover:border-sky-600 text-slate-400 hover:text-sky-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {job.running ? "Running…" : job.isPending ? "Starting…" : "Run now"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CrawlReportTab() {
  const [showLogin, setShowLogin] = useState(false);
  const { data: session, refetch: refetchSession } = useAdminSession();
  const { data, isLoading, isError, refetch } = useCrawlReport();
  const { data: ilCba } = useIlCbaCoverage();
  const [showDistrictLog, setShowDistrictLog] = useState(false);

  if (!session?.authenticated) {
    return (
      <>
        {showLogin && (
          <AdminLoginModal
            onSuccess={() => { setShowLogin(false); refetchSession(); refetch(); }}
          />
        )}
        <LoginRequiredCard onLogin={() => setShowLogin(true)} />
      </>
    );
  }

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
        Failed to load crawl report. Make sure the API server is running and try refreshing.
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
          <Metric label="Districts loaded" value={crawlState.districtsLoaded} sub="from ISBE district directory" />
          <Metric
            label="CBA PDFs downloaded"
            value={crawlState.cbaDocsDownloaded}
            sub={`${crawlState.cbaDocsFound.toLocaleString()} school-sector found`}
          />
          <Metric
            label="FF proposals"
            value={crawlState.ffProposalsLoaded}
            sub={crawlState.ffPageAccessible ? "from ILRB/IDOL" : "page requires JS render"}
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

      {/* Coverage funnel */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">CBA Coverage Funnel</h2>
        <div className="rounded-lg border border-slate-800 bg-slate-950 p-5 space-y-3">
          {[
            {
              label: "School-sector docs found (IL crawl)",
              value: crawlState.cbaDocsFound,
              pct: null,
              color: "text-slate-300",
            },
            {
              label: "PDFs indexed in DB (cumulative)",
              value: crawlState.cbaIndexedCount,
              pct: crawlState.cbaDocsFound > 0
                ? Math.round((crawlState.cbaIndexedCount / crawlState.cbaDocsFound) * 1000) / 10
                : null,
              color: "text-sky-400",
            },
            {
              label: "Matched to a district (auto)",
              value: crawlState.cbaMatchedCount,
              pct: crawlState.cbaDocsFound > 0
                ? Math.round((crawlState.cbaMatchedCount / crawlState.cbaDocsFound) * 1000) / 10
                : null,
              color: "text-emerald-400",
            },
          ].map((row) => (
            <div key={row.label}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-slate-400">{row.label}</span>
                <div className="flex items-center gap-3">
                  {row.pct !== null && (
                    <span className="text-xs text-slate-500 font-mono">{row.pct}%</span>
                  )}
                  <span className={`text-sm font-mono font-semibold ${row.color}`}>
                    {row.value.toLocaleString()}
                  </span>
                </div>
              </div>
              {row.pct !== null && crawlState.cbaDocsFound > 0 && (
                <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      row.color.includes("emerald") ? "bg-emerald-500" : "bg-sky-500"
                    }`}
                    style={{ width: `${Math.min(100, row.pct)}%` }}
                  />
                </div>
              )}
            </div>
          ))}
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

      {/* IL CBA Crawl Coverage */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          IL CBA Crawl Coverage
        </h2>
        {ilCba ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric
                label="Districts with URL"
                value={ilCba.districtsWithUrl}
                sub={`${ilCba.noUrl.toLocaleString()} still missing URL`}
              />
              <Metric
                label="Attempted"
                value={ilCba.attempted}
                sub="this + prior runs"
              />
              <Metric
                label="PDFs found"
                value={ilCba.found}
                sub={ilCba.coveragePct !== null ? `${ilCba.coveragePct}% of crawlable` : "—"}
              />
              <Metric
                label="No PDF found"
                value={ilCba.failed}
                sub="eligible for FOIA"
              />
            </div>

            {ilCba.districtsWithUrl > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-slate-400">CBA PDF coverage (crawlable districts)</span>
                  <span className="text-xs font-mono text-slate-400">
                    {ilCba.coveragePct !== null ? `${ilCba.coveragePct}%` : "—"}
                  </span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500 bg-sky-500"
                    style={{ width: `${Math.min(100, ilCba.coveragePct ?? 0)}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">
                {ilCba.lastUpdated
                  ? `Last crawled: ${new Date(ilCba.lastUpdated).toLocaleString()}`
                  : "No crawl data — run pipeline/11_crawl_il_cbas.py"}
              </span>
              <a
                href={apiUrl("/api/admin/il-cba-unfound.csv")}
                download="il_cba_unfound.csv"
                className="text-xs px-3 py-1.5 rounded border border-slate-700 hover:border-sky-600 text-slate-400 hover:text-sky-400 transition-colors"
              >
                ↓ Download Unfound List (CSV)
              </a>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-5 text-xs text-slate-500">
            No IL CBA crawl data yet — run{" "}
            <code className="font-mono text-slate-400">pipeline/11_crawl_il_cbas.py</code> to
            begin collecting district CBAs.
          </div>
        )}
      </section>

      {/* ISBE Directory Refresh */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          ISBE Directory Refresh
        </h2>
        <p className="text-xs text-slate-500">
          Downloads the ISBE district directory daily at 7 AM Central and upserts district
          website URLs, names, and county info. SHA-256 deduplicated — unchanged files are
          logged but not reprocessed. Schedule fires only on a reserved VM deployment.
        </p>
        <DirectoryRefreshCard />
      </section>

      {/* Scheduled Automations */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Scheduled Automations
        </h2>
        <p className="text-xs text-slate-500">
          These jobs run automatically on the API server. IL CBA Crawl re-crawls all district
          websites on the 1st and 15th of each month at 2 AM Central. Extraction Cron processes
          any unextracted CBA PDFs nightly at 3 AM Central. Both skip if already running.
        </p>
        <ScheduledAutomationsCard />
      </section>

      {/* Per-district crawl log */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
            IL District-by-District Log
          </h2>
          <button
            onClick={() => setShowDistrictLog((v) => !v)}
            className="text-xs px-3 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition-colors"
          >
            {showDistrictLog ? "▲ Hide" : "▼ Show all 956 districts"}
          </button>
        </div>
        {!showDistrictLog ? (
          <p className="text-xs text-slate-600">
            Expand to see a searchable, filterable table of every IL district with its crawl status,
            last attempted date, storage key, and last settlement year.
          </p>
        ) : (
          <IlCbaDistrictLogTable />
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extraction Report Tab
// ---------------------------------------------------------------------------

function ExtractionReportTab() {
  const [showLogin, setShowLogin] = useState(false);
  const { data: session, refetch: refetchSession } = useAdminSession();
  const { data, isLoading, isError, refetch } = useExtractionReport();

  if (!session?.authenticated) {
    return (
      <>
        {showLogin && (
          <AdminLoginModal
            onSuccess={() => { setShowLogin(false); refetchSession(); refetch(); }}
          />
        )}
        <LoginRequiredCard onLogin={() => setShowLogin(true)} />
      </>
    );
  }

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
        Failed to load extraction report. Make sure the API server is running and try refreshing.
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
            sub="low-confidence + audit samples"
          />
        </div>
      </section>

      {/* Audit quality sampling */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Audit Quality Sampling</h2>
        <div className="rounded-lg border border-slate-800 bg-slate-950 p-5">
          <div className="grid grid-cols-3 gap-6 mb-4">
            <div>
              <p className="text-xs text-slate-500 mb-1">Provisions flagged (5% sample)</p>
              <p className="text-2xl font-bold font-mono text-slate-200">
                {data.auditSampleCount.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Human-reviewed</p>
              <p className="text-2xl font-bold font-mono text-sky-400">
                {data.auditReviewedCount.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-1">Agreement rate</p>
              <p className={`text-2xl font-bold font-mono ${
                data.auditAgreementRate === null
                  ? "text-slate-600"
                  : data.auditAgreementRate >= 90
                  ? "text-emerald-400"
                  : data.auditAgreementRate >= 75
                  ? "text-amber-400"
                  : "text-red-400"
              }`}>
                {data.auditAgreementRate !== null ? `${data.auditAgreementRate}%` : "—"}
              </p>
            </div>
          </div>
          {data.auditSampleCount > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-slate-500">
                  Review progress ({data.auditReviewedCount} / {data.auditSampleCount})
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  {data.auditSampleCount > 0
                    ? Math.round((data.auditReviewedCount / data.auditSampleCount) * 100)
                    : 0}%
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-sky-500 transition-all duration-500"
                  style={{
                    width: `${Math.min(100, (data.auditReviewedCount / data.auditSampleCount) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
          {data.auditSampleCount === 0 && (
            <p className="text-xs text-slate-600">
              No audit samples yet — run 06_extract_contracts.py to populate.
            </p>
          )}
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

      {/* Per-state extraction breakdown */}
      {(data.stateDocMap && Object.keys(data.stateDocMap).length > 0) && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
            Extraction by State
          </h2>
          <div className="rounded-lg border border-slate-800 overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="text-left px-4 py-2 text-xs text-slate-400 font-medium">State</th>
                  <th className="text-right px-4 py-2 text-xs text-slate-400 font-medium">CBA PDFs</th>
                  <th className="text-right px-4 py-2 text-xs text-slate-400 font-medium">Processed</th>
                  <th className="text-right px-4 py-2 text-xs text-slate-400 font-medium">Coverage</th>
                  <th className="text-right px-4 py-2 text-xs text-slate-400 font-medium">Runs (success)</th>
                  <th className="text-right px-4 py-2 text-xs text-slate-400 font-medium">Runs (failed)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {["OH", "IL", ...Object.keys(data.stateDocMap).filter((s) => s !== "OH" && s !== "IL")].map((state) => {
                  const docs = data.stateDocMap[state];
                  if (!docs) return null;
                  const pct = docs.total > 0 ? Math.round((docs.processed / docs.total) * 1000) / 10 : null;
                  const runs = data.stateRunMap?.[state] ?? {};
                  return (
                    <tr key={state} className="bg-slate-950 hover:bg-slate-900/50">
                      <td className="px-4 py-3 text-xs font-bold text-slate-200">{state}</td>
                      <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">{docs.total.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">{docs.processed.toLocaleString()}</td>
                      <td className={`px-4 py-3 text-right text-xs font-mono font-bold ${
                        pct === null ? "text-slate-600" : pct >= 95 ? "text-emerald-400" : pct > 0 ? "text-amber-400" : "text-slate-500"
                      }`}>
                        {pct !== null ? `${pct}%` : "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-xs font-mono text-emerald-400">
                        {(runs["success"] ?? 0).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right text-xs font-mono text-red-400">
                        {(runs["failed"] ?? 0).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

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

      {isError && session?.authenticated && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 p-6 text-red-400 text-sm">
          Failed to load review queue. Try refreshing.
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
                    {item.is_audit_sample && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-violet-950 text-violet-400 border border-violet-800">
                        AUDIT
                      </span>
                    )}
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
// EIS Cross-Check Tab
// ---------------------------------------------------------------------------

interface EisXCheckItem {
  district_name: string;
  state_district_id: string;
  slug: string;
  settlement_id: number;
  from_year: string;
  to_year: string;
  base_increase_pct: string | null;
  eis_avg_salary: string | null;
  eis_prev_avg_salary: string | null;
  eis_observed_change_pct: string | null;
  eis_flag: boolean;
}

interface EisXCheckResponse {
  items: EisXCheckItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

function useEisXCheck(page: number, flaggedOnly: boolean) {
  return useQuery<EisXCheckResponse>({
    queryKey: ["/api/admin/il-eis-crosscheck", page, flaggedOnly],
    queryFn: () => {
      const p = new URLSearchParams({
        page: String(page),
        limit: "100",
        flagged_only: String(flaggedOnly),
      });
      return fetch(apiUrl(`/api/admin/il-eis-crosscheck?${p}`), { credentials: "include" }).then(
        (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
      );
    },
    retry: false,
  });
}

function DiffBadge({ our, eis }: { our: string | null; eis: string | null }) {
  if (our == null || eis == null) return <span className="text-slate-600">—</span>;
  const diff = Math.abs(parseFloat(our) - parseFloat(eis));
  const color = diff > 5 ? "text-red-400" : diff > 2 ? "text-amber-400" : "text-emerald-400";
  return (
    <span className={`font-mono ${color}`}>
      {diff.toFixed(1)} pp
    </span>
  );
}

function EisXCheckTab() {
  const [page, setPage] = useState(1);
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const { data: session } = useAdminSession();
  const { data, isLoading, isError } = useEisXCheck(page, flaggedOnly);

  if (!session?.authenticated) return <LoginRequiredCard onLogin={() => {}} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-xs text-slate-400">
            IL settlements cross-checked against ISBE EIS actual salary data. Sorted by largest gap.
          </p>
          {data && (
            <p className="text-xs text-slate-600">
              {data.total.toLocaleString()} settlement{data.total !== 1 ? "s" : ""}{" "}
              {flaggedOnly ? "flagged (diff > 2 pp)" : "with EIS coverage"}
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(e) => { setFlaggedOnly(e.target.checked); setPage(1); }}
            className="accent-amber-500"
          />
          Flagged only (diff &gt; 2 pp)
        </label>
      </div>

      {isLoading && <div className="text-xs text-slate-600 py-4">Loading…</div>}
      {isError && <div className="text-xs text-red-400 py-4">Failed to load EIS cross-check data.</div>}

      {data && data.items.length === 0 && (
        <div className="text-xs text-slate-600 py-4">No settlements match the current filter.</div>
      )}

      {data && data.items.length > 0 && (
        <div className="rounded-lg border border-slate-800 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900">
                <th className="px-3 py-2 text-left text-slate-400 font-medium">District</th>
                <th className="px-3 py-2 text-center text-slate-400 font-medium">Period</th>
                <th className="px-3 py-2 text-right text-slate-400 font-medium">Our Pct</th>
                <th className="px-3 py-2 text-right text-slate-400 font-medium">EIS Observed</th>
                <th className="px-3 py-2 text-right text-slate-400 font-medium">Gap</th>
                <th className="px-3 py-2 text-center text-slate-400 font-medium">EIS Avg Sal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {data.items.map((item) => {
                const ourPct = item.base_increase_pct != null ? parseFloat(item.base_increase_pct) : null;
                const eisPct = item.eis_observed_change_pct != null ? parseFloat(item.eis_observed_change_pct) : null;
                return (
                  <tr
                    key={item.settlement_id}
                    className={`hover:bg-slate-900/40 ${item.eis_flag ? "bg-amber-950/10" : "bg-slate-950"}`}
                  >
                    <td className="px-3 py-2.5">
                      <a
                        href={apiUrl(`/dashboard/${item.slug ?? item.state_district_id}`)}
                        className="text-blue-400 hover:text-blue-300 font-medium"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {item.district_name}
                      </a>
                    </td>
                    <td className="px-3 py-2.5 text-center text-slate-400 font-mono">
                      {item.from_year}
                      {item.to_year && item.to_year !== item.from_year ? ` → ${item.to_year}` : ""}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-200">
                      {ourPct != null ? `+${ourPct.toFixed(2)}%` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                      {eisPct != null ? `${eisPct > 0 ? "+" : ""}${eisPct.toFixed(2)}%` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <DiffBadge our={item.base_increase_pct} eis={item.eis_observed_change_pct} />
                    </td>
                    <td className="px-3 py-2.5 text-center text-slate-400 font-mono">
                      {item.eis_avg_salary != null
                        ? `$${Math.round(parseFloat(item.eis_avg_salary)).toLocaleString()}`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="text-xs px-3 py-1 rounded border border-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-xs text-slate-500">
            {page} / {data.pages}
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

      <p className="text-[10px] text-slate-700 italic pt-2">
        EIS observed change = YoY change in ISBE EIS district-level FTE-weighted avg teacher salary.
        Gap &gt; 2 pp may indicate salary schedule restructuring rather than a uniform base increase.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell with tab routing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Alerts Tab
// ---------------------------------------------------------------------------

interface AlertItem {
  id: number;
  alert_type: string;
  doc_name: string | null;
  source_url: string | null;
  detected_at: string;
  status: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  notes: string | null;
  district_name: string | null;
}

interface AlertsResponse {
  items: AlertItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  pendingCount: number;
}

function useAlerts(page: number, status: string) {
  return useQuery<AlertsResponse>({
    queryKey: ["/api/admin/alerts", page, status],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: "50", status });
      return fetch(apiUrl(`/api/admin/alerts?${params}`), { credentials: "include" }).then(
        (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        },
      );
    },
    refetchInterval: 30_000,
    retry: false,
  });
}

function AlertTypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    new_doc: "bg-blue-950 text-blue-400 border-blue-800",
    changed_doc: "bg-amber-950 text-amber-400 border-amber-800",
    new_settlement: "bg-emerald-950 text-emerald-400 border-emerald-800",
  };
  const labels: Record<string, string> = {
    new_doc: "New doc",
    changed_doc: "Changed",
    new_settlement: "Settlement",
  };
  const cls = styles[type] ?? "bg-slate-900 text-slate-400 border-slate-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {labels[type] ?? type}
    </span>
  );
}

function AlertsTab() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("pending");
  const [showLogin, setShowLogin] = useState(false);
  const [ackId, setAckId] = useState<number | null>(null);

  const { data: session, refetch: refetchSession } = useAdminSession();
  const { data, isLoading, isError, refetch } = useAlerts(page, statusFilter);

  const ackMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(apiUrl(`/api/admin/alerts/${id}/acknowledge`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      if (r.status === 401) { setShowLogin(true); throw new Error("401"); }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/alerts"] });
      setAckId(null);
    },
  });

  const acknowledge = (id: number) => {
    if (!session?.authenticated) { setShowLogin(true); return; }
    setAckId(id);
    ackMutation.mutate(id);
  };

  return (
    <div className="space-y-6">
      {showLogin && (
        <AdminLoginModal
          onSuccess={() => { setShowLogin(false); refetchSession(); }}
        />
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-400">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            className="text-xs bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-300 focus:outline-none focus:border-blue-500"
          >
            <option value="pending">Pending</option>
            <option value="acknowledged">Acknowledged</option>
          </select>
          {data && statusFilter === "pending" && data.pendingCount > 0 && (
            <span className="text-xs text-amber-400 font-mono">
              {data.pendingCount} pending
            </span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1 rounded border border-slate-700 hover:border-slate-500 transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      {!session?.authenticated && (
        <div className="flex items-center justify-between rounded-lg border border-amber-800 bg-amber-950/20 px-4 py-3">
          <span className="text-xs text-amber-400">
            Admin session required to acknowledge alerts.
          </span>
          <button
            onClick={() => setShowLogin(true)}
            className="text-xs px-3 py-1 rounded bg-amber-800 hover:bg-amber-700 text-amber-100 transition-colors"
          >
            Log in
          </button>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500 text-sm animate-pulse">
          Loading alerts…
        </div>
      )}

      {isError && session?.authenticated && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 p-6 text-red-400 text-sm">
          Failed to load alerts. Try refreshing.
        </div>
      )}

      {data?.items.length === 0 && !isLoading && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/20 p-8 text-center">
          <p className="text-emerald-400 text-sm font-medium">
            {statusFilter === "pending" ? "No pending alerts ✓" : "No acknowledged alerts"}
          </p>
          <p className="text-slate-500 text-xs mt-1">
            {statusFilter === "pending"
              ? "Run the nightly cron (pipeline/08_cron_incremental.py) to detect new IL CBA documents."
              : "Acknowledged alerts will appear here."}
          </p>
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="space-y-2">
          {data.items.map((alert) => (
            <div
              key={alert.id}
              className="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden"
            >
              <div className="flex items-start justify-between px-4 py-3 gap-3">
                <div className="flex flex-col gap-1.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <AlertTypeBadge type={alert.alert_type} />
                    {alert.district_name && (
                      <span className="text-xs text-slate-400 font-mono">
                        {alert.district_name}
                      </span>
                    )}
                    <span className="text-xs text-slate-600">
                      {new Date(alert.detected_at).toLocaleString()}
                    </span>
                  </div>
                  {alert.doc_name && (
                    <p className="text-xs text-slate-300 truncate">{alert.doc_name}</p>
                  )}
                  {alert.source_url && (
                    <a
                      href={alert.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:text-blue-400 truncate block"
                    >
                      {alert.source_url}
                    </a>
                  )}
                  {alert.acknowledged_at && (
                    <p className="text-xs text-slate-600">
                      Acknowledged {new Date(alert.acknowledged_at).toLocaleString()}
                      {alert.acknowledged_by ? ` by ${alert.acknowledged_by}` : ""}
                    </p>
                  )}
                </div>
                {statusFilter === "pending" && (
                  <button
                    onClick={() => acknowledge(alert.id)}
                    disabled={ackMutation.isPending && ackId === alert.id}
                    className="shrink-0 text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500 disabled:opacity-50 transition-colors"
                  >
                    {ackMutation.isPending && ackId === alert.id ? "…" : "Acknowledge"}
                  </button>
                )}
              </div>
            </div>
          ))}

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
// Customers Tab
// ---------------------------------------------------------------------------

interface Customer {
  id: number;
  name: string | null;
  email: string;
  active: boolean;
  district_id: number | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  has_password: boolean;
}

function CustomersTab() {
  const { data: session } = useAdminSession();
  const isAuthenticated = session?.authenticated === true;
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<{ customers: Customer[] }>({
    queryKey: ["/api/admin/customers"],
    queryFn: () =>
      fetch(apiUrl("/api/admin/customers"), { credentials: "include" }).then(
        (r) => r.json(),
      ),
    enabled: isAuthenticated,
  });

  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);

  const [pwModal, setPwModal] = useState<{ id: number; email: string } | null>(null);
  const [newPw, setNewPw] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwModal) return;
    setPwError("");
    setPwSaving(true);
    try {
      const r = await fetch(apiUrl(`/api/admin/customers/${pwModal.id}/password`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password: newPw }),
      });
      const body = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok) {
        setPwError(body.error ?? "Failed to set password");
      } else {
        setPwModal(null);
        setNewPw("");
        qc.invalidateQueries({ queryKey: ["/api/admin/customers"] });
      }
    } catch {
      setPwError("Network error");
    } finally {
      setPwSaving(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError("");
    setAdding(true);
    try {
      const r = await fetch(apiUrl("/api/admin/customers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: newName.trim(), email: newEmail.trim() }),
      });
      const body = (await r.json()) as { customer?: Customer; error?: string };
      if (!r.ok) {
        setAddError(body.error ?? "Failed to add customer");
      } else {
        setNewName("");
        setNewEmail("");
        setShowAdd(false);
        qc.invalidateQueries({ queryKey: ["/api/admin/customers"] });
      }
    } catch {
      setAddError("Network error");
    } finally {
      setAdding(false);
    }
  };

  const toggleActive = async (id: number, active: boolean) => {
    await fetch(apiUrl(`/api/admin/customers/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ active }),
    });
    qc.invalidateQueries({ queryKey: ["/api/admin/customers"] });
  };

  const removeCustomer = async (id: number, email: string) => {
    if (!confirm(`Remove ${email} from approved customers?`)) return;
    await fetch(apiUrl(`/api/admin/customers/${id}`), {
      method: "DELETE",
      credentials: "include",
    });
    qc.invalidateQueries({ queryKey: ["/api/admin/customers"] });
  };

  if (!isAuthenticated) {
    return (
      <div className="rounded-xl border border-amber-800/50 bg-amber-950/10 p-6 text-center space-y-3">
        <p className="text-amber-300 text-sm">Sign in to manage customers.</p>
        <button
          onClick={goToLogin}
          className="inline-block text-xs px-4 py-2 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
        >
          Sign in →
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Approved Customers</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Manage customer accounts. Use "Set Password" to enable login for each user.
          </p>
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="text-xs px-3 py-1.5 rounded border border-slate-600 text-slate-300 hover:border-blue-500 hover:text-blue-300 transition-colors"
        >
          {showAdd ? "Cancel" : "+ Add customer"}
        </button>
      </div>

      {showAdd && (
        <form
          onSubmit={handleAdd}
          className="rounded-lg border border-slate-700 bg-slate-900 p-4 space-y-3"
        >
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="Full name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              className="flex-1 text-xs bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
            />
            <input
              type="email"
              placeholder="email@district.org"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
              className="flex-1 text-xs bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
            />
            <button
              type="submit"
              disabled={adding}
              className="text-xs px-4 py-2 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
          {addError && <p className="text-xs text-red-400">{addError}</p>}
        </form>
      )}

      {isLoading && (
        <p className="text-xs text-slate-500">Loading customers…</p>
      )}
      {error && (
        <p className="text-xs text-red-400">Failed to load customers.</p>
      )}

      {data && data.customers.length === 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-6 text-center">
          <p className="text-xs text-slate-500">No customers yet. Add one above.</p>
        </div>
      )}

      {data && data.customers.length > 0 && (
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900">
                <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Name</th>
                <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Email</th>
                <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Status</th>
                <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Password</th>
                <th className="text-left px-4 py-2.5 text-slate-400 font-medium">Last sign-in</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.customers.map((c, i) => (
                <tr
                  key={c.id}
                  className={`border-b border-slate-800/50 ${i % 2 === 0 ? "bg-slate-950" : "bg-slate-900/30"}`}
                >
                  <td className="px-4 py-2.5 text-slate-200">{c.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-slate-400 font-mono">{c.email}</td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => toggleActive(c.id, !c.active)}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                        c.active
                          ? "bg-emerald-900/50 text-emerald-400 hover:bg-red-900/50 hover:text-red-400"
                          : "bg-slate-800 text-slate-500 hover:bg-emerald-900/50 hover:text-emerald-400"
                      }`}
                    >
                      {c.active ? "Active" : "Inactive"}
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => { setPwModal({ id: c.id, email: c.email }); setNewPw(""); setPwError(""); }}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                        c.has_password
                          ? "bg-slate-800 text-slate-400 hover:bg-blue-900/50 hover:text-blue-300"
                          : "bg-amber-900/50 text-amber-400 hover:bg-blue-900/50 hover:text-blue-300"
                      }`}
                    >
                      {c.has_password ? "Change" : "Set password"}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">
                    {c.last_sign_in_at
                      ? new Date(c.last_sign_in_at).toLocaleDateString()
                      : "Never"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => removeCustomer(c.id, c.email)}
                      className="text-slate-600 hover:text-red-400 transition-colors text-[10px]"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pwModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">Set Password</h2>
              <p className="text-xs text-slate-500 mt-0.5 font-mono">{pwModal.email}</p>
            </div>
            <form onSubmit={handleSetPassword} className="space-y-3">
              <input
                type="password"
                autoFocus
                placeholder="New password (min 8 characters)"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                required
                minLength={8}
                className="w-full text-xs bg-slate-950 border border-slate-700 rounded px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500"
              />
              {pwError && <p className="text-xs text-red-400">{pwError}</p>}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={pwSaving}
                  className="flex-1 text-xs px-3 py-2 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 transition-colors"
                >
                  {pwSaving ? "Saving…" : "Save password"}
                </button>
                <button
                  type="button"
                  onClick={() => setPwModal(null)}
                  className="text-xs px-3 py-2 rounded border border-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell with tab routing
// ---------------------------------------------------------------------------

type TabKey = "overview" | "crawl-report" | "extraction-report" | "review-queue" | "alerts" | "eis-crosscheck" | "customers";

function useAlertsPendingCount() {
  return useQuery<{ pendingCount: number }>({
    queryKey: ["/api/admin/alerts/pending-count"],
    queryFn: () =>
      fetch(apiUrl("/api/admin/alerts?limit=1&status=pending"), { credentials: "include" })
        .then((r) => (r.ok ? r.json() : { pendingCount: 0 }))
        .then((d: AlertsResponse) => ({ pendingCount: d.pendingCount ?? 0 })),
    refetchInterval: 60_000,
    retry: false,
  });
}

const TABS: { key: TabKey; label: string; path: string }[] = [
  { key: "overview", label: "Overview", path: "/admin" },
  { key: "crawl-report", label: "Crawl Report", path: "/admin/crawl-report" },
  { key: "extraction-report", label: "Extraction", path: "/admin/extraction-report" },
  { key: "review-queue", label: "Review Queue", path: "/admin/review-queue" },
  { key: "alerts", label: "Alerts", path: "/admin/alerts" },
  { key: "eis-crosscheck", label: "EIS Cross-Check", path: "/admin/eis-crosscheck" },
  { key: "customers", label: "Customers", path: "/admin/customers" },
];

function activeTab(location: string): TabKey {
  if (location.includes("/admin/alerts")) return "alerts";
  if (location.includes("review-queue")) return "review-queue";
  if (location.includes("extraction-report")) return "extraction-report";
  if (location.includes("crawl-report")) return "crawl-report";
  if (location.includes("eis-crosscheck")) return "eis-crosscheck";
  if (location.includes("customers")) return "customers";
  return "overview";
}

export default function AdminPage() {
  const [location, setLocation] = useLocation();
  const tab = activeTab(location);
  const { data: alertsData } = useAlertsPendingCount();
  const pendingAlerts = alertsData?.pendingCount ?? 0;
  const { data: session } = useAdminSession();

  const isAuthenticated = session?.authenticated === true;

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
        <div className="flex items-center gap-3">
          {isAuthenticated ? (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Admin session active
            </span>
          ) : (
            <button
              onClick={goToLogin}
              className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:border-blue-600 hover:text-blue-300 transition-colors"
            >
              Log in
            </button>
          )}
        </div>
      </header>

      {!isAuthenticated && (
        <div className="border-b border-amber-800/60 bg-amber-950/20 px-6 py-3 flex items-center justify-between">
          <span className="text-xs text-amber-300">
            Sign in to see live pipeline data and table counts.
          </span>
          <button
            onClick={goToLogin}
            className="text-xs px-3 py-1 rounded bg-amber-800 hover:bg-amber-700 text-amber-100 transition-colors"
          >
            Log in
          </button>
        </div>
      )}

      <div className="border-b border-slate-800 px-6">
        <nav className="flex -mb-px">
          {TABS.map(({ key, label, path }) => (
            <button
              key={key}
              onClick={() => setLocation(path)}
              className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                tab === key
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              {label}
              {key === "alerts" && pendingAlerts > 0 && (
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 text-slate-950 text-[10px] font-bold">
                  {pendingAlerts > 9 ? "9+" : pendingAlerts}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {tab === "overview" && <OverviewTab />}
        {tab === "crawl-report" && <CrawlReportTab />}
        {tab === "extraction-report" && <ExtractionReportTab />}
        {tab === "review-queue" && <ReviewQueueTab />}
        {tab === "alerts" && <AlertsTab />}
        {tab === "eis-crosscheck" && <EisXCheckTab />}
        {tab === "customers" && <CustomersTab />}
      </main>
    </div>
  );
}
