import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { sourceHref } from "@/lib/api";

export interface ProvenanceValueProps {
  value: string | number | null | undefined;
  unit?: string | null;
  sourceUrl?: string | null;
  pageRef?: number | null;
  humanVerified?: boolean | null;
  // Who confirmed the figure: "district" (the district vouched for it) or
  // "internal" (CollBar staff). Drives the wording on the ✓ Verified badge.
  verifiedBy?: "district" | "internal" | string | null;
  confidence?: string | number | null;
  retrievedAt?: string | null;
  className?: string;
}

// Below this confidence an AI read is treated as genuinely low-confidence and
// stays visibly flagged for review. At or above it, an unverified read is
// presented as a credible, sourced figure (no alarm styling).
const LOW_CONFIDENCE_THRESHOLD = 0.5;

export function ProvenanceValue({
  value,
  unit,
  sourceUrl,
  pageRef,
  humanVerified,
  verifiedBy,
  confidence,
  retrievedAt,
  className,
}: ProvenanceValueProps) {
  if (value === null || value === undefined || value === "") {
    return (
      <span className="text-slate-600 text-xs italic">Not yet extracted</span>
    );
  }

  const display =
    typeof value === "number" ? value.toLocaleString() : String(value);
  const unitDisplay = unit ? ` ${unit}` : "";
  const verified = !!humanVerified;
  const confNum = confidence != null ? parseFloat(String(confidence)) : null;
  // Genuinely low-confidence reads stay flagged; everything else (high or
  // unknown confidence) is presented as a credible, sourced figure.
  const lowConfidence =
    !verified && confNum != null && confNum < LOW_CONFIDENCE_THRESHOLD;
  const confPct = confNum != null ? `${(confNum * 100).toFixed(0)}%` : null;
  const pdfLink = sourceHref(sourceUrl, pageRef);

  const verifiedLabel = verified
    ? verifiedBy === "district"
      ? "✓ Verified by district"
      : verifiedBy === "internal"
      ? "✓ Verified by CollBar"
      : "✓ Verified"
    : null;

  const retrievedDisplay = retrievedAt
    ? new Date(retrievedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 cursor-help",
            className,
          )}
        >
          <span
            className={cn(
              "font-mono",
              lowConfidence ? "text-amber-400" : "text-slate-100",
            )}
          >
            {display}
            {unitDisplay}
          </span>
          {verified ? (
            <span
              className="text-emerald-400 text-xs flex-shrink-0"
              aria-label="Verified"
            >
              ✓
            </span>
          ) : lowConfidence ? (
            <span
              className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
              aria-label="Low confidence — needs review"
            />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="bg-slate-800 border border-slate-700 text-slate-200 p-2 max-w-xs text-xs"
      >
        <div className="space-y-1">
          {pdfLink ? (
            <div>
              Source:{" "}
              <a
                href={pdfLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {pageRef != null ? `PDF p.${pageRef}` : "Source document"}
              </a>
            </div>
          ) : (
            <div className="text-slate-500">No source URL available</div>
          )}
          {retrievedDisplay && (
            <div className="text-slate-400">Retrieved: {retrievedDisplay}</div>
          )}
          <div>
            {verified ? (
              <span className="text-emerald-400">{verifiedLabel}</span>
            ) : lowConfidence ? (
              <span className="text-amber-400">
                ⚠ Low confidence{confPct ? ` · ${confPct}` : ""} — needs review
              </span>
            ) : (
              <span className="text-slate-300">
                Pulled from source PDF
                {confPct ? ` · ${confPct} confidence` : ""}
              </span>
            )}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function ProvenanceRow({
  label,
  value,
  unit,
  sourceUrl,
  pageRef,
  humanVerified,
  verifiedBy,
  confidence,
  retrievedAt,
  countyMedian,
  bandMedian,
}: { label: string; countyMedian?: number | null; bandMedian?: number | null } & ProvenanceValueProps) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-slate-800 last:border-0 gap-2">
      <span className="text-xs text-slate-400 leading-5 flex-shrink-0">{label}</span>
      <div className="flex flex-col items-end gap-0.5">
        <ProvenanceValue
          value={value}
          unit={unit}
          sourceUrl={sourceUrl}
          pageRef={pageRef}
          humanVerified={humanVerified}
          verifiedBy={verifiedBy}
          confidence={confidence}
          retrievedAt={retrievedAt}
        />
        {countyMedian != null && (
          <span className="text-[10px] text-amber-600 tabular-nums">
            county med {countyMedian.toLocaleString()}{unit ? ` ${unit}` : ""}
          </span>
        )}
        {bandMedian != null && bandMedian !== countyMedian && (
          <span className="text-[10px] text-emerald-700 tabular-nums">
            band med {bandMedian.toLocaleString()}{unit ? ` ${unit}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
