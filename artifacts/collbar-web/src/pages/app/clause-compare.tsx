import { useEffect, useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";
import {
  ClauseCard,
  SynthesisPanel,
  prettyClauseKey,
  decodeClauseSource,
} from "@/components/clause";
import { CANONICAL_UNITS, unitLabel } from "@/lib/bargaining-units";
import {
  useActiveMatter,
  useMatters,
  useClauseCompare,
  type ClauseCompareRequest,
} from "@/hooks/use-firm";

const SELECT_CLASS =
  "bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors disabled:opacity-40";
const LABEL_CLASS =
  "block text-[11px] font-medium uppercase tracking-wide text-slate-500";

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
    </div>
  );
}

export default function ClauseComparePage() {
  const active = useActiveMatter();
  const matters = useMatters();

  const [source, setSource] = useState("all");
  const [unit, setUnit] = useState("teachers");
  const [provisionKey, setProvisionKey] = useState("");
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (initialized || active.isLoading) return;
    const am = active.data?.matter;
    if (am) setSource(`matter:${am.id}`);
    setInitialized(true);
  }, [initialized, active.isLoading, active.data]);

  const { scope, matterId } = decodeClauseSource(source);
  const enabled = initialized && (scope !== "matter" || matterId != null);

  // The picker is driven by a SEPARATE query (provisionKey omitted) so it stays
  // populated and stable while a specific comparison loads. The comparison query
  // only fires once a provision type is chosen — that's the expensive model path.
  const baseReq: ClauseCompareRequest = {
    scope,
    bargainingUnit: unit,
    ...(scope === "matter" && matterId != null ? { matterId } : {}),
  };
  const typesQ = useClauseCompare(baseReq, enabled);
  const compareReq: ClauseCompareRequest = { ...baseReq, provisionKey };
  const compareQ = useClauseCompare(compareReq, enabled && !!provisionKey);

  const availableTypes = typesQ.data?.availableTypes ?? [];
  const clauses = compareQ.data?.clauses ?? [];
  const synthesis = compareQ.data?.synthesis ?? null;

  // If the selected type isn't present in the current scope's catalog, clear it
  // (e.g. after switching matters) so the picker never points at a stale type.
  useEffect(() => {
    if (!provisionKey || !typesQ.data) return;
    if (!availableTypes.some((t) => t.provisionKey === provisionKey)) {
      setProvisionKey("");
    }
  }, [typesQ.data, availableTypes, provisionKey]);

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-slate-100">Clause compare</h2>
          <p className="text-sm text-slate-400">
            Line up the same provision across your districts to see exactly how
            the language differs — each clause verbatim and cited to its source
            PDF. Pick a provision type to compare.
          </p>
        </section>

        {/* Controls */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <label htmlFor="cc-source" className={LABEL_CLASS}>
                Compare within
              </label>
              <select
                id="cc-source"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  // Clear the type immediately so the (expensive) compare query
                  // never fires against the new scope with a stale selection.
                  setProvisionKey("");
                }}
                className={`${SELECT_CLASS} min-w-[220px]`}
              >
                <option value="all">Entire workspace</option>
                <option value="tracked">Tracked roster</option>
                <option value="database">Entire database</option>
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
              <label htmlFor="cc-unit" className={LABEL_CLASS}>
                Bargaining unit
              </label>
              <select
                id="cc-unit"
                value={unit}
                onChange={(e) => {
                  setUnit(e.target.value);
                  setProvisionKey("");
                }}
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
              <label htmlFor="cc-type" className={LABEL_CLASS}>
                Provision type
              </label>
              <select
                id="cc-type"
                value={provisionKey}
                onChange={(e) => setProvisionKey(e.target.value)}
                disabled={availableTypes.length === 0}
                className={`${SELECT_CLASS} min-w-[240px]`}
              >
                <option value="">Choose a provision…</option>
                {availableTypes.map((t) => (
                  <option key={t.provisionKey} value={t.provisionKey}>
                    {prettyClauseKey(t.provisionKey)} ({t.districtCount})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Results */}
        <section className="space-y-4">
          {!enabled ? (
            <p className="text-sm text-slate-500">
              Select a matter to compare its districts.
            </p>
          ) : typesQ.isLoading ? (
            <Spinner />
          ) : typesQ.isError ? (
            <p className="text-sm text-red-400">
              {typesQ.error instanceof Error
                ? typesQ.error.message
                : "Could not load comparable provisions."}
            </p>
          ) : availableTypes.length === 0 ? (
            <p className="text-sm text-slate-500">
              No comparable contract clauses in this scope yet. Try a different
              bargaining unit or add districts to your roster.
            </p>
          ) : !provisionKey ? (
            <p className="text-sm text-slate-500">
              Choose a provision type above to see it side by side across your
              districts.
            </p>
          ) : compareQ.isLoading ? (
            <Spinner />
          ) : compareQ.isError ? (
            <p className="text-sm text-red-400">
              {compareQ.error instanceof Error
                ? compareQ.error.message
                : "Could not load the comparison."}
            </p>
          ) : clauses.length === 0 ? (
            <p className="text-sm text-slate-500">
              No districts in scope have a cited clause for this provision.
            </p>
          ) : (
            <>
              {synthesis && <SynthesisPanel text={synthesis} />}
              <p className="text-[11px] text-slate-500">
                {clauses.length} district{clauses.length === 1 ? "" : "s"} ·{" "}
                {prettyClauseKey(provisionKey)}
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {clauses.map((c) => (
                  <ClauseCard key={c.provisionId} clause={c} showProvision={false} />
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}
