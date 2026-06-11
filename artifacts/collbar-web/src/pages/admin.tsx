import { useHealthCheck } from "@workspace/api-client-react";

const TABLES = [
  "districts",
  "source_documents",
  "contracts",
  "contract_provisions",
  "settlements",
  "factfinding_proposals",
  "extraction_runs",
  "users",
] as const;

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

export default function AdminPage() {
  const { data: health, isLoading, isError } = useHealthCheck();

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
          <span>Phase 1</span>
          <span className="w-1 h-1 rounded-full bg-slate-600" />
          <span>Database Schema</span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10 space-y-8">

        {/* API Health */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">API Health</h2>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-slate-300 text-sm">Express API Server</span>
              <span className="text-slate-600 text-xs">GET /api/healthz</span>
            </div>
            {isLoading ? (
              <span className="text-slate-500 text-xs animate-pulse">checking…</span>
            ) : (
              <StatusBadge ok={!isError && !!health} />
            )}
          </div>
        </section>

        {/* Database Tables */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
            Database Schema — Phase 1 Tables
          </h2>
          <div className="rounded-lg border border-slate-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="text-left px-4 py-2.5 text-slate-400 font-medium text-xs">Table</th>
                  <th className="text-right px-4 py-2.5 text-slate-400 font-medium text-xs">
                    Rows (populated in Phase 2+)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {TABLES.map((table) => (
                  <tr key={table} className="bg-slate-950 hover:bg-slate-900/50 transition-colors">
                    <td className="px-4 py-3 text-slate-300 text-xs">{table}</td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-slate-600 text-xs">—</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-600">
            All 8 tables created. Row counts visible in Phase 2 after corpus acquisition.
          </p>
        </section>

        {/* Phase Roadmap */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Build Phases</h2>
          <div className="space-y-2">
            {[
              { phase: "Phase 1", label: "Database Schema & Bootstrap", done: true },
              { phase: "Phase 2", label: "Acquire the Corpus (Scrapers)", done: false },
              { phase: "Phase 3", label: "LLM Extraction Pipeline", done: false },
              { phase: "Phase 4", label: "The Dashboard", done: false },
              { phase: "Phase 5", label: "Hardening", done: false },
            ].map(({ phase, label, done }) => (
              <div
                key={phase}
                className={`rounded-md border px-4 py-3 flex items-center justify-between ${
                  done
                    ? "border-emerald-800 bg-emerald-950/30"
                    : "border-slate-800 bg-slate-900/30"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-semibold ${done ? "text-emerald-400" : "text-slate-500"}`}>
                    {phase}
                  </span>
                  <span className={`text-xs ${done ? "text-slate-300" : "text-slate-500"}`}>{label}</span>
                </div>
                {done && (
                  <span className="text-xs text-emerald-500 font-medium">✓ Complete</span>
                )}
              </div>
            ))}
          </div>
        </section>

      </main>
    </div>
  );
}
