import { useEffect, useMemo, useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { prettyClauseKey } from "@/components/clause";
import { CANONICAL_UNITS, unitLabel } from "@/lib/bargaining-units";
import {
  useActiveMatter,
  useMatters,
  useClauseCompare,
  useExports,
  useGenerateExport,
  downloadExport,
  type ExportType,
  type ExportFormat,
  type FirmExport,
  type ClauseCompareRequest,
} from "@/hooks/use-firm";

const SELECT_CLASS =
  "bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors disabled:opacity-40";
const LABEL_CLASS =
  "block text-[11px] font-medium uppercase tracking-wide text-slate-500";

const MAX_PROVISION_KEYS = 15;

const TYPE_OPTIONS: { value: ExportType; label: string; blurb: string }[] = [
  {
    value: "comparison_memo",
    label: "Comparison memo",
    blurb: "Narrative memo lining up the matter's districts across key terms.",
  },
  {
    value: "benchmark_exhibit",
    label: "Benchmark exhibit",
    blurb: "Tabular exhibit of the same figures, formatted as an attachment.",
  },
  {
    value: "clause_appendix",
    label: "Clause appendix",
    blurb: "Verbatim clause language for selected provisions, side by side.",
  },
];

const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "Word (DOCX)" },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.map((t) => [t.value, t.label]),
);

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "export"
  );
}

function exportFilename(e: Pick<FirmExport, "title" | "type" | "format">): string {
  return `${slugify(e.title || TYPE_LABEL[e.type] || "export")}.${e.format}`;
}

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
    </div>
  );
}

export default function ExportsPage() {
  const active = useActiveMatter();
  const matters = useMatters();
  const list = useExports();
  const generate = useGenerateExport();

  const [matterId, setMatterId] = useState<number | null>(null);
  const [type, setType] = useState<ExportType>("comparison_memo");
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [unit, setUnit] = useState("teachers");
  const [title, setTitle] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Seed the matter from the active matter once data is ready.
  useEffect(() => {
    if (initialized || active.isLoading || matters.isLoading) return;
    const am = active.data?.matter;
    if (am) setMatterId(am.id);
    else {
      const first = matters.data?.matters?.[0];
      if (first) setMatterId(first.id);
    }
    setInitialized(true);
  }, [initialized, active.isLoading, active.data, matters.isLoading, matters.data]);

  // The clause appendix needs a provision picker driven by the matter's catalog
  // (same source the server validates against). Only fetch it for that type.
  const isClauseAppendix = type === "clause_appendix";
  const clauseReq: ClauseCompareRequest = {
    scope: "matter",
    bargainingUnit: unit,
    ...(matterId != null ? { matterId } : {}),
  };
  const typesQ = useClauseCompare(
    clauseReq,
    isClauseAppendix && matterId != null,
  );
  const availableTypes = useMemo(
    () => typesQ.data?.availableTypes ?? [],
    [typesQ.data],
  );

  // Drop any selected provisions no longer offered (e.g. after switching matter
  // or unit) so we never submit a stale key the server would reject.
  useEffect(() => {
    if (!typesQ.data) return;
    setSelectedKeys((keys) =>
      keys.filter((k) => availableTypes.some((t) => t.provisionKey === k)),
    );
  }, [typesQ.data, availableTypes]);

  function toggleKey(key: string) {
    setSelectedKeys((keys) =>
      keys.includes(key)
        ? keys.filter((k) => k !== key)
        : keys.length >= MAX_PROVISION_KEYS
          ? keys
          : [...keys, key],
    );
  }

  const canGenerate =
    matterId != null &&
    !generate.isPending &&
    (!isClauseAppendix || selectedKeys.length > 0);

  async function handleGenerate() {
    setFormError(null);
    if (matterId == null) {
      setFormError("Select a matter to export.");
      return;
    }
    if (isClauseAppendix && selectedKeys.length === 0) {
      setFormError("Select at least one provision for the clause appendix.");
      return;
    }
    try {
      const created = await generate.mutateAsync({
        matterId,
        type,
        format,
        bargainingUnit: unit,
        ...(isClauseAppendix ? { provisionKeys: selectedKeys } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      // Hand the freshly generated file straight to the browser.
      try {
        await downloadExport(created.id, exportFilename(created));
      } catch {
        /* Generation succeeded and the row is listed; a failed auto-download is
           recoverable via the Download button below. */
      }
    } catch (e) {
      setFormError(
        e instanceof Error ? e.message : "Could not generate the export.",
      );
    }
  }

  async function handleDownload(e: FirmExport) {
    setDownloadError(null);
    setDownloadingId(e.id);
    try {
      await downloadExport(e.id, exportFilename(e));
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : "Could not download the export.",
      );
    } finally {
      setDownloadingId(null);
    }
  }

  const hasMatters = (matters.data?.matters ?? []).length > 0;
  const exports = list.data?.exports ?? [];

  return (
    <WorkspaceShell>
      <div className="space-y-8">
        <section className="space-y-1">
          <h2 className="text-lg font-semibold text-slate-100">Exports</h2>
          <p className="text-sm text-slate-400">
            Generate a client-ready memo, exhibit, or clause appendix from a
            matter. Every figure and clause carries its citation — district,
            source document, page, and retrieval date — exactly as shown on
            screen. Files are saved here so you can re-download them anytime.
          </p>
        </section>

        {/* Generate form */}
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-4">
          {!hasMatters ? (
            <p className="text-sm text-slate-500">
              Create a matter first — exports are generated from a matter's
              districts.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1">
                  <label htmlFor="ex-matter" className={LABEL_CLASS}>
                    Matter
                  </label>
                  <select
                    id="ex-matter"
                    value={matterId ?? ""}
                    onChange={(e) => {
                      setMatterId(
                        e.target.value ? Number(e.target.value) : null,
                      );
                      // Drop selections immediately so a fast Generate can't
                      // submit the prior matter's provision keys.
                      setSelectedKeys([]);
                    }}
                    className={`${SELECT_CLASS} min-w-[220px]`}
                  >
                    {(matters.data?.matters ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label htmlFor="ex-type" className={LABEL_CLASS}>
                    Document
                  </label>
                  <select
                    id="ex-type"
                    value={type}
                    onChange={(e) => setType(e.target.value as ExportType)}
                    className={`${SELECT_CLASS} min-w-[200px]`}
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label htmlFor="ex-unit" className={LABEL_CLASS}>
                    Bargaining unit
                  </label>
                  <select
                    id="ex-unit"
                    value={unit}
                    onChange={(e) => {
                      setUnit(e.target.value);
                      setSelectedKeys([]);
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
                  <label htmlFor="ex-format" className={LABEL_CLASS}>
                    Format
                  </label>
                  <select
                    id="ex-format"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as ExportFormat)}
                    className={SELECT_CLASS}
                  >
                    {FORMAT_OPTIONS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <p className="text-[11px] text-slate-500">
                {TYPE_OPTIONS.find((t) => t.value === type)?.blurb}
              </p>

              <div className="space-y-1 max-w-md">
                <label htmlFor="ex-title" className={LABEL_CLASS}>
                  Title <span className="normal-case text-slate-600">(optional)</span>
                </label>
                <input
                  id="ex-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  placeholder="Defaults to the document type and matter name"
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
                />
              </div>

              {/* Clause appendix provision picker */}
              {isClauseAppendix && (
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Provisions to include
                    </p>
                    <span className="text-[11px] text-slate-500">
                      {selectedKeys.length}/{MAX_PROVISION_KEYS} selected
                    </span>
                  </div>
                  {matterId == null ? (
                    <p className="text-xs text-slate-500">Select a matter first.</p>
                  ) : typesQ.isLoading ? (
                    <p className="text-xs text-slate-500">Loading provisions…</p>
                  ) : typesQ.isError ? (
                    <p className="text-xs text-red-400">
                      {typesQ.error instanceof Error
                        ? typesQ.error.message
                        : "Could not load provisions."}
                    </p>
                  ) : availableTypes.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      No cited clauses available for this matter and unit. Try a
                      different bargaining unit.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {availableTypes.map((t) => {
                        const checked = selectedKeys.includes(t.provisionKey);
                        const atCap =
                          !checked && selectedKeys.length >= MAX_PROVISION_KEYS;
                        return (
                          <label
                            key={t.provisionKey}
                            className={`inline-flex items-center gap-1.5 text-xs select-none ${
                              atCap
                                ? "text-slate-600 cursor-not-allowed"
                                : "text-slate-300 cursor-pointer"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={atCap}
                              onChange={() => toggleKey(t.provisionKey)}
                              className="accent-blue-600"
                            />
                            {prettyClauseKey(t.provisionKey)} ({t.districtCount})
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  className="inline-flex items-center gap-2 rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:hover:bg-blue-700"
                >
                  {generate.isPending && (
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
                  )}
                  {generate.isPending ? "Generating…" : "Generate export"}
                </button>
                {formError && (
                  <span className="text-xs text-red-400">{formError}</span>
                )}
              </div>
            </>
          )}
        </section>

        {/* Prior exports */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-200">Prior exports</h3>
          {downloadError && (
            <p className="text-xs text-red-400">{downloadError}</p>
          )}
          {list.isLoading ? (
            <Spinner />
          ) : list.isError ? (
            <p className="text-sm text-red-400">
              {list.error instanceof Error
                ? list.error.message
                : "Could not load exports."}
            </p>
          ) : exports.length === 0 ? (
            <p className="text-sm text-slate-500">
              No exports yet. Generate one above and it will appear here.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-900 text-left text-xs font-semibold text-slate-300">
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      Document
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      Matter
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5">Type</th>
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      Format
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5">
                      Created
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5">By</th>
                    <th className="border-b border-slate-800 px-3 py-2.5 text-right">
                      Size
                    </th>
                    <th className="border-b border-slate-800 px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {exports.map((e) => (
                    <tr
                      key={e.id}
                      className="even:bg-slate-900/40 hover:bg-slate-900/70 transition-colors"
                    >
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-100 font-medium">
                        {e.title || TYPE_LABEL[e.type]}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-300">
                        {e.matterName || "—"}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-300 whitespace-nowrap">
                        {TYPE_LABEL[e.type] ?? e.type}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-400 uppercase">
                        {e.format}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-400 whitespace-nowrap">
                        {formatDate(e.createdAt)}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-slate-400 whitespace-nowrap">
                        {e.generatedByName ?? "—"}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-right text-slate-400 whitespace-nowrap">
                        {formatBytes(e.fileSize)}
                      </td>
                      <td className="border-b border-slate-800 px-3 py-2.5 align-top text-right">
                        <button
                          onClick={() => handleDownload(e)}
                          disabled={downloadingId === e.id}
                          className="text-xs text-slate-200 hover:text-white border border-slate-700 rounded-md px-3 py-1.5 hover:bg-slate-800 transition-colors disabled:opacity-40"
                        >
                          {downloadingId === e.id ? "Downloading…" : "Download"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}
