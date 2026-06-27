import { useEffect, useMemo, useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { firmSourceHref } from "@/lib/api";
import {
  useActiveMatter,
  useMatters,
  useRoster,
  useCompareMatrix,
  type CompareCell,
  type CompareColumn,
  type CompareRequest,
} from "@/hooks/use-firm";

// Bargaining-unit options mirror the server-side whitelist (parseUnit). The
// matrix never mixes units; teachers is the default everywhere.
const UNIT_OPTIONS: { value: string; label: string }[] = [
  { value: "teachers", label: "Teachers" },
  { value: "paraprofessionals", label: "Paraprofessionals" },
  { value: "support_staff", label: "Support staff" },
  { value: "custodial_maintenance", label: "Custodial & maintenance" },
  { value: "secretarial_clerical", label: "Secretarial & clerical" },
  { value: "transportation", label: "Transportation" },
  { value: "food_service", label: "Food service" },
  { value: "nurses", label: "Nurses" },
  { value: "administrators", label: "Administrators" },
  { value: "other", label: "Other" },
];

function prettifyText(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Render a stored cell value according to its kind. Inputs are already the
// stored figure (e.g. pct = 3.25 means 3.25%); we only format, never compute.
function formatCellValue(cell: CompareCell): string {
  const v = cell.value;
  switch (cell.kind) {
    case "pct":
      return `${Number(v)}%`;
    case "money":
      return `$${Number(v).toLocaleString()}`;
    case "count":
      return Math.round(Number(v)).toLocaleString();
    case "years":
      return `${Number(v)} yr`;
    case "bool":
      return v ? "Yes" : "No";
    case "text":
      return prettifyText(String(v));
    default:
      return String(v);
  }
}

interface ActiveCell {
  cell: CompareCell;
  column: CompareColumn;
  districtName: string;
}

export default function ComparePage() {
  const active = useActiveMatter();
  const matters = useMatters();
  const roster = useRoster();

  const [mode, setMode] = useState<"matter" | "roster">("matter");
  const [matterId, setMatterId] = useState<number | null>(null);
  const [unit, setUnit] = useState("teachers");
  // null = use the server's default column set; once chosen, an explicit list.
  const [selectedColumns, setSelectedColumns] = useState<string[] | null>(null);
  const [showColumns, setShowColumns] = useState(false);
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Seed the source selection from the active matter once data is ready. If
  // there's no active matter, fall back to comparing the whole roster.
  useEffect(() => {
    if (initialized || active.isLoading) return;
    const am = active.data?.matter;
    if (am) {
      setMode("matter");
      setMatterId(am.id);
    } else {
      setMode("roster");
    }
    setInitialized(true);
  }, [initialized, active.isLoading, active.data]);

  const rosterIds = useMemo(
    () => (roster.data?.roster ?? []).map((r) => r.districtId),
    [roster.data],
  );

  const req: CompareRequest = useMemo(() => {
    const base: CompareRequest = {
      bargainingUnit: unit,
      columns: selectedColumns ?? undefined,
    };
    if (mode === "matter" && matterId != null) return { ...base, matterId };
    return { ...base, districtIds: rosterIds };
  }, [mode, matterId, unit, selectedColumns, rosterIds]);

  const enabled =
    initialized &&
    (mode === "matter" ? matterId != null : rosterIds.length > 0);

  const matrix = useCompareMatrix(req, enabled);

  // Close the cell detail on Escape.
  useEffect(() => {
    if (!activeCell) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActiveCell(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeCell]);

  const data = matrix.data;
  const columns = data?.columns ?? [];
  const catalog = data?.catalog ?? [];
  const districts = data?.districts ?? [];

  // Which catalog ids are currently active (explicit selection or server default).
  const activeColumnIds = selectedColumns ?? columns.map((c) => c.id);

  function toggleColumn(id: string) {
    const current = selectedColumns ?? columns.map((c) => c.id);
    const next = current.includes(id)
      ? current.filter((c) => c !== id)
      : [...current, id];
    // Never let the user clear every column (server would 400).
    if (next.length === 0) return;
    setSelectedColumns(next);
  }

  // Group the catalog for the picker.
  const catalogGroups = useMemo(() => {
    const groups: { group: string; columns: CompareColumn[] }[] = [];
    for (const col of catalog) {
      let g = groups.find((x) => x.group === col.group);
      if (!g) {
        g = { group: col.group, columns: [] };
        groups.push(g);
      }
      g.columns.push(col);
    }
    return groups;
  }, [catalog]);

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-slate-100">
            Cross-district comparison
          </h2>
          <p className="text-sm text-slate-400">
            Line up districts side by side across settlement and contract terms.
            Every figure is pulled from a source document — click any cell to read
            the exact clause and open the PDF.
          </p>
        </section>

        {/* Controls */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            {/* Source: matter vs roster */}
            <div className="space-y-1">
              <label
                htmlFor="compare-source"
                className="block text-[11px] font-medium uppercase tracking-wide text-slate-500"
              >
                Compare
              </label>
              <select
                id="compare-source"
                value={mode === "matter" ? `matter:${matterId ?? ""}` : "roster"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "roster") {
                    setMode("roster");
                  } else {
                    setMode("matter");
                    setMatterId(Number(v.split(":")[1]));
                  }
                }}
                className="bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 min-w-[220px] focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
              >
                <optgroup label="Matters">
                  {(matters.data?.matters ?? []).map((m) => (
                    <option key={m.id} value={`matter:${m.id}`}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
                <option value="roster">Entire roster</option>
              </select>
            </div>

            {/* Bargaining unit */}
            <div className="space-y-1">
              <label
                htmlFor="compare-unit"
                className="block text-[11px] font-medium uppercase tracking-wide text-slate-500"
              >
                Bargaining unit
              </label>
              <select
                id="compare-unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
              >
                {UNIT_OPTIONS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Column picker toggle */}
            <button
              onClick={() => setShowColumns((s) => !s)}
              disabled={catalog.length === 0}
              className="ml-auto text-xs text-slate-300 hover:text-white border border-slate-700 rounded-md px-3 py-2 hover:bg-slate-800 transition-colors disabled:opacity-40"
            >
              {showColumns ? "Hide columns" : "Choose columns"}
              {columns.length > 0 ? ` (${columns.length})` : ""}
            </button>
          </div>

          {showColumns && catalogGroups.length > 0 && (
            <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-3">
              {catalogGroups.map((g) => (
                <div key={g.group} className="space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    {prettifyText(g.group)}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {g.columns.map((col) => {
                      const checked = activeColumnIds.includes(col.id);
                      return (
                        <label
                          key={col.id}
                          className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleColumn(col.id)}
                            className="accent-blue-600"
                          />
                          {col.label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-emerald-400">✓</span> Reviewed &amp; verified
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Machine-extracted (unreviewed)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-slate-600">—</span> No cited value
          </span>
        </div>

        {/* Matrix */}
        <section>
          {matrix.isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            </div>
          ) : matrix.isError ? (
            <p className="text-sm text-red-400">
              {matrix.error instanceof Error
                ? matrix.error.message
                : "Could not load comparison."}
            </p>
          ) : !enabled ? (
            <p className="text-sm text-slate-500">
              {mode === "roster"
                ? "Your roster is empty. Add districts on the Roster tab to compare them."
                : "Select a matter to compare its districts."}
            </p>
          ) : districts.length === 0 || columns.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing to compare yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-900">
                    <th className="sticky left-0 z-10 bg-slate-900 border-b border-r border-slate-800 px-3 py-2.5 text-left text-xs font-semibold text-slate-300 min-w-[180px]">
                      District
                    </th>
                    {columns.map((col) => (
                      <th
                        key={col.id}
                        className="border-b border-slate-800 px-3 py-2.5 text-left text-xs font-semibold text-slate-300 whitespace-nowrap"
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {districts.map((d) => {
                    const row = data?.cells[String(d.districtId)] ?? {};
                    return (
                      <tr
                        key={d.districtId}
                        className="even:bg-slate-900/40 hover:bg-slate-900/70 transition-colors"
                      >
                        <td className="sticky left-0 z-10 bg-inherit border-r border-slate-800 px-3 py-2.5 align-top">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-200 font-medium leading-tight">
                              {d.name}
                            </span>
                            {d.role && (
                              <span
                                className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${
                                  d.role === "client"
                                    ? "bg-blue-900/60 text-blue-300"
                                    : "bg-slate-800 text-slate-400"
                                }`}
                              >
                                {d.role}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            {d.county ? `${d.county} • ` : ""}
                            {d.state}
                          </p>
                        </td>
                        {columns.map((col) => {
                          const cell = row[col.id];
                          if (!cell) {
                            return (
                              <td
                                key={col.id}
                                className="px-3 py-2.5 align-top text-slate-600"
                              >
                                —
                              </td>
                            );
                          }
                          return (
                            <td key={col.id} className="px-3 py-2.5 align-top">
                              <button
                                onClick={() =>
                                  setActiveCell({
                                    cell,
                                    column: col,
                                    districtName: d.name,
                                  })
                                }
                                className="inline-flex items-center gap-1.5 text-left hover:underline decoration-slate-600 underline-offset-2"
                                title="View source clause"
                              >
                                <span className="font-mono text-slate-100 whitespace-nowrap">
                                  {formatCellValue(cell)}
                                </span>
                                {cell.humanVerified ? (
                                  <span
                                    className="text-emerald-400 text-xs flex-shrink-0"
                                    aria-label="Reviewed and verified"
                                  >
                                    ✓
                                  </span>
                                ) : (
                                  <span
                                    className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
                                    aria-label="Machine-extracted, unreviewed"
                                  />
                                )}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {activeCell && (
        <CellDetail
          active={activeCell}
          unitLabel={data?.bargainingUnit ?? unit}
          onClose={() => setActiveCell(null)}
        />
      )}
    </WorkspaceShell>
  );
}

function CellDetail({
  active,
  unitLabel,
  onClose,
}: {
  active: ActiveCell;
  unitLabel: string;
  onClose: () => void;
}) {
  const { cell, column, districtName } = active;
  const pdfLink = firmSourceHref(cell.sourceUrl, cell.pageRef);
  const confPct =
    cell.confidence != null
      ? `${(Number(cell.confidence) * 100).toFixed(0)}%`
      : null;
  const retrieved = cell.retrievedAt
    ? new Date(cell.retrievedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${column.label} — ${districtName}`}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-100">{column.label}</p>
            <p className="text-[11px] text-slate-500">
              {districtName} • {prettifyText(unitLabel)}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-200 text-lg leading-none"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl text-slate-100">
              {formatCellValue(cell)}
            </span>
            {cell.humanVerified ? (
              <span className="text-xs text-emerald-400">
                ✓ Reviewed &amp; verified
                {cell.verifiedBy === "district"
                  ? " by district"
                  : cell.verifiedBy === "internal"
                  ? " by CollBar"
                  : ""}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                Machine-extracted — not yet reviewed
                {confPct ? ` · ${confPct} confidence` : ""}
              </span>
            )}
          </div>

          {/* Verbatim source clause (provision cells only). */}
          {column.source === "provision" ? (
            cell.clauseExcerpt ? (
              <div className="space-y-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Source clause
                </p>
                <blockquote className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {cell.clauseExcerpt}
                </blockquote>
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic">
                No clause text stored for this term.
              </p>
            )
          ) : (
            <p className="text-xs text-slate-500 italic">
              Settlement figure — see the source document for full context.
            </p>
          )}

          <div className="flex items-center justify-between border-t border-slate-800 pt-3">
            <span className="text-[11px] text-slate-500">
              {retrieved ? `Retrieved ${retrieved}` : "Retrieval date unknown"}
            </span>
            {pdfLink ? (
              <a
                href={pdfLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 transition-colors"
              >
                {cell.pageRef != null
                  ? `Open source PDF · p.${cell.pageRef}`
                  : "Open source document"}
              </a>
            ) : (
              <span className="text-[11px] text-slate-600">
                No source link available
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
