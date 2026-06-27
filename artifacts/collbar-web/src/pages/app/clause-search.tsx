import { useEffect, useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";
import {
  ClauseCard,
  SynthesisPanel,
  decodeClauseSource,
} from "@/components/clause";
import { CANONICAL_UNITS, unitLabel } from "@/lib/bargaining-units";
import {
  useActiveMatter,
  useMatters,
  useClauseSearch,
  type ClauseSearchRequest,
} from "@/hooks/use-firm";

// Mirrors the server's contract_provisions.category controlled vocabulary.
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All categories" },
  { value: "compensation", label: "Compensation" },
  { value: "insurance", label: "Insurance" },
  { value: "retirement", label: "Retirement" },
  { value: "leave", label: "Leave" },
  { value: "workday", label: "Workday & hours" },
  { value: "evaluation", label: "Evaluation" },
  { value: "rif", label: "Reduction in force" },
  { value: "grievance", label: "Grievance" },
  { value: "other", label: "Other" },
];

const SELECT_CLASS =
  "bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors";
const LABEL_CLASS =
  "block text-[11px] font-medium uppercase tracking-wide text-slate-500";

export default function ClauseSearchPage() {
  const active = useActiveMatter();
  const matters = useMatters();
  const search = useClauseSearch();

  const [source, setSource] = useState("all");
  const [unit, setUnit] = useState("teachers");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [initialized, setInitialized] = useState(false);

  // Default to the active matter once it's known; otherwise the whole workspace.
  useEffect(() => {
    if (initialized || active.isLoading) return;
    const am = active.data?.matter;
    if (am) setSource(`matter:${am.id}`);
    setInitialized(true);
  }, [initialized, active.isLoading, active.data]);

  const canSearch = query.trim().length >= 2 && !search.isPending;

  function runSearch() {
    const q = query.trim();
    if (q.length < 2) return;
    const { scope, matterId } = decodeClauseSource(source);
    const req: ClauseSearchRequest = {
      query: q,
      scope,
      bargainingUnit: unit,
      category: category || null,
    };
    if (scope === "matter" && matterId != null) req.matterId = matterId;
    search.mutate(req);
  }

  const data = search.data;
  const clauses = data?.clauses ?? [];

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-slate-100">Clause search</h2>
          <p className="text-sm text-slate-400">
            Search the verbatim contract language across your workspace. Every
            result is a real, cited clause — open the source PDF to read it in
            context. The optional AI summary only condenses the clauses shown; it
            never invents language.
          </p>
        </section>

        {/* Controls */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <label htmlFor="cs-source" className={LABEL_CLASS}>
                Search within
              </label>
              <select
                id="cs-source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className={`${SELECT_CLASS} min-w-[220px]`}
              >
                <option value="all">Entire workspace</option>
                <option value="tracked">Tracked roster</option>
                {(matters.data?.matters ?? []).length > 0 && (
                  <optgroup label="Matters">
                    {(matters.data?.matters ?? []).map((m) => (
                      <option key={m.id} value={`matter:${m.id}`}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="cs-unit" className={LABEL_CLASS}>
                Bargaining unit
              </label>
              <select
                id="cs-unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className={SELECT_CLASS}
              >
                {CANONICAL_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {unitLabel(u)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="cs-cat" className={LABEL_CLASS}>
                Category
              </label>
              <select
                id="cs-cat"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={SELECT_CLASS}
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch();
              }}
              placeholder="e.g. binding arbitration, sick leave buyback, layoff by seniority"
              aria-label="Clause search query"
              className="flex-1 bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
            />
            <button
              onClick={runSearch}
              disabled={!canSearch}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors disabled:opacity-40"
            >
              Search
            </button>
          </div>
        </section>

        {/* Results */}
        <section className="space-y-4">
          {search.isPending ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            </div>
          ) : search.isError ? (
            <p className="text-sm text-red-400">
              {search.error instanceof Error
                ? search.error.message
                : "Search failed."}
            </p>
          ) : data ? (
            clauses.length === 0 ? (
              <p className="text-sm text-slate-500">
                No clauses matched “{data.query}” in this scope. Try broadening
                the bargaining unit or removing the category filter.
              </p>
            ) : (
              <>
                {data.synthesis && <SynthesisPanel text={data.synthesis} />}
                <p className="text-[11px] text-slate-500">
                  {clauses.length} clause{clauses.length === 1 ? "" : "s"} ·
                  ranked by relevance
                </p>
                <div className="space-y-3">
                  {clauses.map((c) => (
                    <ClauseCard key={c.provisionId} clause={c} />
                  ))}
                </div>
              </>
            )
          ) : (
            <p className="text-sm text-slate-500">
              Enter a search above to find matching contract language across your
              workspace.
            </p>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}
