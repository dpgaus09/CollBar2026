import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ProvenanceValueProps {
  value: string | number | null | undefined;
  unit?: string | null;
  sourceUrl?: string | null;
  pageRef?: number | null;
  humanVerified?: boolean | null;
  confidence?: string | number | null;
  retrievedAt?: string | null;
  className?: string;
}

export function ProvenanceValue({
  value,
  unit,
  sourceUrl,
  pageRef,
  humanVerified,
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
  const isUnverified = !humanVerified;
  const confNum = confidence != null ? parseFloat(String(confidence)) : null;
  const pdfLink =
    sourceUrl && pageRef != null
      ? `${sourceUrl}#page=${pageRef}`
      : sourceUrl ?? null;

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
              isUnverified ? "text-amber-400" : "text-slate-100",
            )}
          >
            {display}
            {unitDisplay}
          </span>
          {isUnverified && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
              aria-label="Unverified"
            />
          )}
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
          {confNum != null && (
            <div>
              Confidence:{" "}
              <span
                className={
                  confNum >= 0.8
                    ? "text-emerald-400"
                    : confNum >= 0.5
                    ? "text-amber-400"
                    : "text-red-400"
                }
              >
                {(confNum * 100).toFixed(0)}%
              </span>
            </div>
          )}
          <div>
            {humanVerified ? (
              <span className="text-emerald-400">✓ Human verified</span>
            ) : (
              <span className="text-amber-400">
                ⚠ LLM extracted — awaiting verification
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
  confidence,
  retrievedAt,
}: { label: string } & ProvenanceValueProps) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
      <span className="text-xs text-slate-400">{label}</span>
      <ProvenanceValue
        value={value}
        unit={unit}
        sourceUrl={sourceUrl}
        pageRef={pageRef}
        humanVerified={humanVerified}
        confidence={confidence}
        retrievedAt={retrievedAt}
      />
    </div>
  );
}
