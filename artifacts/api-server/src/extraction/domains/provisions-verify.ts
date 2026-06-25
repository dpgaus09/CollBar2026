// Option B (Task #174) for provisions: corroborate numeric provision values
// against the digital text layer of the page they were extracted from. Vision
// stays authoritative — we NEVER overwrite a value. A value the text cannot
// corroborate has its confidence capped (so it routes to the <0.8 review queue).
//
// contract_provisions has no review_reason column, so a mismatch is recorded via
// the confidence cap + logs only.
//
// Verification is unit-aware and CAUTIOUS: only "$" (money) and "%" (percent)
// values are checked, because small integers (days/hours/counts) collide with
// article numbers, years, and step counts in the text and would over-flag.

import type { PdfDoc } from "../pdf/renderer";
import { logger } from "../../lib/logger";
import type { ExtractedContract, ProvisionItem } from "../types";

const MONEY_TOKEN_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,7}(?:\.\d+)?/g;
const PERCENT_TOKEN_RE = /(\d+(?:\.\d+)?)\s*(?:%|percent)/gi;

const MIN_PAGE_TEXT_CHARS = 40;
const MONEY_SLACK = 1; // $1 slack absorbs cents rounding
const PERCENT_SLACK = 0.01;
const VERIFY_CONFIDENCE_CAP = 0.6;

export const PROVISION_VERIFY_REASON = "text_verify_mismatch"; // logged only

interface PageNumbers {
  money: Set<number>;
  percent: number[];
}

function pageNumbers(text: string): PageNumbers {
  const money = new Set<number>();
  for (const m of text.match(MONEY_TOKEN_RE) ?? []) {
    const n = Math.round(Number(m.replace(/,/g, "")));
    if (Number.isFinite(n) && n > 0) money.add(n);
  }
  const percent: number[] = [];
  let pm: RegExpExecArray | null;
  PERCENT_TOKEN_RE.lastIndex = 0;
  while ((pm = PERCENT_TOKEN_RE.exec(text)) !== null) {
    const n = Number(pm[1]);
    if (Number.isFinite(n)) percent.push(n);
  }
  return { money, percent };
}

type Kind = "money" | "percent" | "skip";

function kindOf(p: ProvisionItem): Kind {
  const u = (p.unit ?? "").toLowerCase();
  if (/%|percent|pct/.test(u)) return "percent";
  if (/\$|dollar|usd/.test(u)) return "money";
  return "skip"; // days / hours / counts: too collision-prone to verify
}

function moneyMatch(set: Set<number>, value: number): boolean {
  const v = Math.round(value);
  for (let d = -MONEY_SLACK; d <= MONEY_SLACK; d++) {
    if (set.has(v + d)) return true;
  }
  return false;
}

function percentMatch(values: number[], value: number): boolean {
  return values.some((x) => Math.abs(x - value) <= PERCENT_SLACK);
}

export interface ProvisionVerifyStats {
  checked: number;
  mismatched: number;
  capped: number;
}

// Mutates provisions in place: caps confidence on $/% values the page text cannot
// corroborate. Never changes a value. Returns telemetry for logging/tests.
export function verifyProvisionsAgainstText(
  contracts: ExtractedContract[],
  doc: Pick<PdfDoc, "pageText">,
  opts?: { minPageTextChars?: number },
): ProvisionVerifyStats {
  const minChars = opts?.minPageTextChars ?? MIN_PAGE_TEXT_CHARS;
  const stats: ProvisionVerifyStats = { checked: 0, mismatched: 0, capped: 0 };
  const byPage = new Map<number, PageNumbers | null>(); // null = scanned/skip

  const getPage = (pageIdx: number): PageNumbers | null => {
    if (byPage.has(pageIdx)) return byPage.get(pageIdx) ?? null;
    let pn: PageNumbers | null = null;
    try {
      const text = doc.pageText(pageIdx);
      pn = text.length >= minChars ? pageNumbers(text) : null;
    } catch (err) {
      logger.warn({ err, pageIdx }, "provisions verify: pageText failed; skipping");
      pn = null;
    }
    byPage.set(pageIdx, pn);
    return pn;
  };

  for (const c of contracts) {
    for (const p of c.provisions) {
      if (p.valueNumeric === null || p.pageRef === null) continue;
      const kind = kindOf(p);
      if (kind === "skip") continue;
      const pn = getPage(p.pageRef - 1);
      if (!pn) continue; // scanned / unverifiable page
      stats.checked++;
      const ok =
        kind === "money"
          ? moneyMatch(pn.money, p.valueNumeric)
          : percentMatch(pn.percent, p.valueNumeric);
      if (!ok) {
        stats.mismatched++;
        if (p.confidence > VERIFY_CONFIDENCE_CAP) {
          p.confidence = VERIFY_CONFIDENCE_CAP;
          stats.capped++;
        }
        logger.info(
          { provisionKey: p.provisionKey, value: p.valueNumeric, kind, page: p.pageRef },
          "provisions verify: text-layer mismatch; confidence capped",
        );
      }
    }
  }
  return stats;
}
