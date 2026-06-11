import { useQuery } from "@tanstack/react-query";
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

function useCrawlReport() {
  return useQuery<CrawlReport>({
    queryKey: ["/api/admin/crawl-report"],
    queryFn: () =>
      fetch(`${import.meta.env.BASE_URL}api/admin/crawl-report`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    refetchInterval: 20_000,
  });
}

function OverviewTab() {
  const { data: health, isLoading: healthLoading, isError: healthError } = useHealthCheck();
  const { data: report } = useCrawlReport();
  const counts = report?.tableCounts ?? {};

  return (
    <div className="space-y-8">
      {/* API Health */}
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

      {/* Database Tables */}
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

      {/* Build Phases */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Build Phases</h2>
        <div className="space-y-2">
          {[
            { phase: "Phase 1", label: "Database Schema & Bootstrap", done: true },
            { phase: "Phase 2", label: "Acquire the Corpus (Scrapers)", done: false, active: true },
            { phase: "Phase 3", label: "LLM Extraction Pipeline", done: false },
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
      {/* Header bar */}
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

      {/* Key metric cards */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Corpus Metrics</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Metric
            label="Districts loaded"
            value={crawlState.districtsLoaded}
            sub="from FY2025 Ohio DEW XLSX"
          />
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

      {/* District match rate */}
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
            <span>
              Manual review CSV:{" "}
              <span className="text-slate-300 font-mono">{crawlState.manualReviewCount}</span>
            </span>
          </div>
        </div>
      </section>

      {/* Download stats */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Download Stats</h2>
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full">
            <tbody className="divide-y divide-slate-800/50">
              {(
                [
                  ["CBA docs found (school sector T/NT)", crawlState.cbaDocsFound],
                  ["CBA PDFs downloaded", crawlState.cbaDocsDownloaded],
                  ["CBA PDFs skipped (already cached)", crawlState.cbaDocsSkipped],
                  ["CBA PDFs failed", crawlState.cbaDocsFailed],
                ] as [string, number][]
              ).map(([label, val]) => (
                <tr key={label} className="bg-slate-950 hover:bg-slate-900/50">
                  <td className="px-4 py-3 text-xs text-slate-400">{label}</td>
                  <td className="px-4 py-3 text-right text-xs font-mono text-slate-300">
                    {val.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Table row counts */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
          Live Table Row Counts
        </h2>
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

      {/* Unmatched employers */}
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
            {crawlState.unmatchedEmployerCount > 50 && (
              <p className="text-xs text-slate-600 mt-2 pt-2 border-t border-slate-800">
                …and {crawlState.unmatchedEmployerCount - 50} more. Full list in{" "}
                <code>pipeline/data/unmatched_employers.csv</code>
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

export default function AdminPage() {
  const [location, setLocation] = useLocation();
  const isCrawl = location.includes("crawl-report");

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
          <span>Phase 2</span>
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          <span>Corpus Acquisition</span>
        </div>
      </header>

      {/* Tab strip */}
      <div className="border-b border-slate-800 px-6">
        <nav className="flex -mb-px">
          {(
            [
              { label: "Overview", path: "/admin", match: !isCrawl },
              { label: "Crawl Report", path: "/admin/crawl-report", match: isCrawl },
            ] as { label: string; path: string; match: boolean }[]
          ).map(({ label, path, match }) => (
            <button
              key={path}
              onClick={() => setLocation(path)}
              className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                match
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
        {isCrawl ? <CrawlReportTab /> : <OverviewTab />}
      </main>
    </div>
  );
}
