// Cost accounting for the extraction engine.
//
// Two jobs:
//   1. costFromUsage — exact per-call cost from the API's reported token usage
//      (image input is already counted in input_tokens, so this covers it).
//   2. estimate* — a pre-bulk estimate from page counts, so the future re-run
//      queue (Task #175) can show "this will cost ~$X" before spending credits.

// USD per million tokens. Estimates — update if Anthropic pricing changes.
export const PRICING: Record<
  string,
  { inputPerMTok: number; outputPerMTok: number }
> = {
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
};

const DEFAULT_PRICING = { inputPerMTok: 1.0, outputPerMTok: 5.0 };

function priceFor(model: string): { inputPerMTok: number; outputPerMTok: number } {
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  return key ? PRICING[key] : DEFAULT_PRICING;
}

export function costFromUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = priceFor(model);
  return (
    (inputTokens / 1e6) * p.inputPerMTok + (outputTokens / 1e6) * p.outputPerMTok
  );
}

// Anthropic's image-token approximation: tokens ~= (width_px * height_px) / 750.
export function imageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

// US Letter aspect (8.5 x 11) — used to estimate image tokens from a long edge
// when we only know the cap, not the real page dimensions.
const LETTER_ASPECT = 8.5 / 11;

function imageTokensForLongEdge(longEdgePx: number): number {
  const w = longEdgePx * LETTER_ASPECT;
  return imageTokens(w, longEdgePx);
}

export interface CostEstimate {
  pages: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// Estimate the salary-vision cost for one document: a low-res triage pass over
// every page plus a high-res extraction pass over up to `maxExtractPages`. The
// defaults mirror the salary domain's render/triage params.
export function estimateSalaryDocCost(
  pageCount: number,
  opts?: {
    model?: string;
    maxExtractPages?: number;
    triageLongEdge?: number;
    extractLongEdge?: number;
    promptTokens?: number;
    outputTokensPerExtractPage?: number;
    skipTriageUnderPages?: number;
  },
): CostEstimate {
  const model = opts?.model ?? "claude-haiku-4-5";
  const maxExtractPages = opts?.maxExtractPages ?? 12;
  const triageLongEdge = opts?.triageLongEdge ?? 900;
  const extractLongEdge = opts?.extractLongEdge ?? 1600;
  const promptTokens = opts?.promptTokens ?? 600;
  const outPerPage = opts?.outputTokensPerExtractPage ?? 400;
  const skipTriageUnder = opts?.skipTriageUnderPages ?? 6;

  const doesTriage = pageCount > skipTriageUnder;
  const extractPages = Math.min(pageCount, maxExtractPages);

  let inputTokens = 0;
  let outputTokens = 0;

  if (doesTriage) {
    inputTokens += pageCount * imageTokensForLongEdge(triageLongEdge);
    inputTokens += promptTokens; // batched triage prompt overhead
    outputTokens += 64; // triage returns a tiny page-number array
  }
  inputTokens += extractPages * imageTokensForLongEdge(extractLongEdge);
  inputTokens += promptTokens;
  outputTokens += extractPages * outPerPage;

  return {
    pages: pageCount,
    inputTokens,
    outputTokens,
    costUsd: costFromUsage(model, inputTokens, outputTokens),
  };
}

export function estimateCorpusCost(
  pageCounts: number[],
  opts?: Parameters<typeof estimateSalaryDocCost>[1],
): CostEstimate {
  return pageCounts.reduce<CostEstimate>(
    (acc, n) => {
      const e = estimateSalaryDocCost(n, opts);
      return {
        pages: acc.pages + e.pages,
        inputTokens: acc.inputTokens + e.inputTokens,
        outputTokens: acc.outputTokens + e.outputTokens,
        costUsd: acc.costUsd + e.costUsd,
      };
    },
    { pages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}
