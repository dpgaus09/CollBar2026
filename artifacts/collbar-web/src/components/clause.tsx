import { firmSourceHref } from "@/lib/api";
import type { ClauseRow, ClauseScope } from "@/hooks/use-firm";

// Shared presentation for the Phase 4 clause search + clause compare pages.
// A ClauseRow is always a real, stored, fully-cited clause; we only ever render
// the verbatim clause_excerpt and its provenance — never anything synthesized.

export function prettyClauseKey(s: string | null): string {
  if (!s) return "";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// The source picker encodes its choice as one string: a specific matter
// ("matter:<id>"), the tracked roster ("tracked"), or the entire firm workspace
// including matter-only districts ("all"). Maps to the server scope + matterId.
export function decodeClauseSource(v: string): {
  scope: ClauseScope;
  matterId: number | null;
} {
  if (v === "tracked" || v === "all") return { scope: v, matterId: null };
  if (v.startsWith("matter:")) {
    const id = Number(v.slice("matter:".length));
    return { scope: "matter", matterId: Number.isFinite(id) ? id : null };
  }
  return { scope: "all", matterId: null };
}

// A grounded, best-effort model summary of the clauses shown below it. Never the
// source of truth: it is omitted entirely when the model is unavailable.
export function SynthesisPanel({ text }: { text: string }) {
  return (
    <section className="rounded-xl border border-blue-900/50 bg-blue-950/30 p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-300">
          AI summary
        </span>
        <span className="text-[10px] text-slate-500">
          grounded only in the cited clauses below
        </span>
      </div>
      <p className="text-sm leading-relaxed text-slate-200 whitespace-pre-wrap">
        {text}
      </p>
      <p className="text-[11px] text-slate-500">
        Citations like [#123] map to the clause cards below. The verbatim clauses
        are the source of truth.
      </p>
    </section>
  );
}

export function ClauseCard({
  clause,
  showProvision = true,
}: {
  clause: ClauseRow;
  showProvision?: boolean;
}) {
  const pdf = firmSourceHref(clause.sourceUrl, clause.pageRef);
  const conf =
    clause.confidence != null
      ? `${Math.round(Number(clause.confidence) * 100)}% confidence`
      : null;
  const meta = [
    showProvision ? prettyClauseKey(clause.provisionKey) : "",
    showProvision ? prettyClauseKey(clause.category) : "",
    clause.county ? `${clause.county}, ${clause.state}` : clause.state,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-100 truncate">
            {clause.districtName}
          </p>
          {meta && (
            <p className="text-[11px] text-slate-500 truncate">{meta}</p>
          )}
        </div>
        <span className="shrink-0 font-mono text-[10px] text-slate-600">
          #{clause.provisionId}
        </span>
      </div>

      <blockquote className="rounded-md border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm leading-relaxed text-slate-300 whitespace-pre-wrap">
        {clause.clauseExcerpt}
      </blockquote>

      <div className="flex items-center justify-between gap-3 border-t border-slate-800 pt-2.5">
        {clause.humanVerified ? (
          <span className="text-xs text-emerald-400">
            ✓ Reviewed &amp; verified
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Machine-extracted{conf ? ` · ${conf}` : ""}
          </span>
        )}
        {pdf ? (
          <a
            href={pdf}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 transition-colors"
          >
            {clause.pageRef != null ? `Source PDF · p.${clause.pageRef}` : "Source PDF"}
          </a>
        ) : (
          <span className="text-[11px] text-slate-600">No source link</span>
        )}
      </div>
    </article>
  );
}
