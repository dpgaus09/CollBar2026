import { describe, it, expect } from "vitest";
import {
  normalizeProvisions,
  dedupeProvisions,
  mergeContracts,
  keywordTriagePages,
  coerceNum,
} from "./provisions";
import { mapProvisionsToTargets } from "./provisions-store";
import type { ExtractedContract, ProvisionItem } from "../types";

// A raw model provision object (snake_case), with sane defaults.
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "leave",
    provision_key: "sick_days_annual",
    value_numeric: 12,
    value_text: null,
    unit: "days",
    clause_excerpt: "Teachers shall receive twelve (12) sick days per year.",
    page_ref: 14,
    confidence: 0.92,
    ...over,
  };
}

function prov(over: Partial<ProvisionItem> = {}): ProvisionItem {
  return {
    category: "leave",
    provisionKey: "sick_days_annual",
    valueNumeric: 12,
    valueText: null,
    unit: "days",
    clauseExcerpt: "twelve sick days",
    pageRef: 14,
    confidence: 0.9,
    ...over,
  };
}

describe("coerceNum", () => {
  it("parses money and percent strings and rejects junk", () => {
    expect(coerceNum("$45,000")).toBe(45000);
    expect(coerceNum("3.5%")).toBe(3.5);
    expect(coerceNum(7)).toBe(7);
    expect(coerceNum("n/a")).toBeNull();
    expect(coerceNum("null")).toBeNull();
    expect(coerceNum(null)).toBeNull();
  });
});

describe("normalizeProvisions", () => {
  it("drops provisions with an invalid category or empty key", () => {
    const out = normalizeProvisions([
      raw({ category: "salary" }), // not in vocab
      raw({ provision_key: "   " }), // empty after snake_case
      raw(),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].provisionKey).toBe("sick_days_annual");
  });

  it("snake_cases the provision key", () => {
    const out = normalizeProvisions([
      raw({ provision_key: "Sick Days (Annual)" }),
    ]);
    expect(out[0].provisionKey).toBe("sick_days_annual");
  });

  it("clamps confidence into 0..1", () => {
    expect(normalizeProvisions([raw({ confidence: 1.4 })])[0].confidence).toBe(1);
    expect(normalizeProvisions([raw({ confidence: -2 })])[0].confidence).toBe(0);
  });

  it("caps confidence to 0.6 when page_ref is missing (routes to review)", () => {
    const out = normalizeProvisions([raw({ page_ref: null, confidence: 0.97 })]);
    expect(out[0].pageRef).toBeNull();
    expect(out[0].confidence).toBe(0.6);
  });

  it("keeps high confidence when page_ref is present", () => {
    expect(normalizeProvisions([raw({ confidence: 0.95 })])[0].confidence).toBe(0.95);
  });

  it("truncates clause_excerpt to 80 words", () => {
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const out = normalizeProvisions([raw({ clause_excerpt: long })]);
    expect(out[0].clauseExcerpt!.split(/\s+/)).toHaveLength(80);
  });

  it("drops a provision that has neither a numeric nor a text value", () => {
    const out = normalizeProvisions([
      raw({ value_numeric: null, value_text: null }),
    ]);
    expect(out).toHaveLength(0);
  });

  it("keeps a text-only provision (e.g. lane_advancement_allowed)", () => {
    const out = normalizeProvisions([
      raw({
        category: "compensation",
        provision_key: "lane_advancement_allowed",
        value_numeric: null,
        value_text: "true",
        unit: null,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].valueText).toBe("true");
  });
});

describe("dedupeProvisions", () => {
  it("keeps the richer of two duplicate (category, key) rows", () => {
    const withPage = prov({ pageRef: 14, confidence: 0.7 });
    const withoutPage = prov({ pageRef: null, confidence: 0.95 });
    const out = dedupeProvisions([withoutPage, withPage]);
    expect(out).toHaveLength(1);
    expect(out[0].pageRef).toBe(14); // page_ref present beats higher confidence
  });

  it("keeps distinct (category, key) pairs separate", () => {
    const a = prov({ category: "leave", provisionKey: "sick_days_annual" });
    const b = prov({ category: "leave", provisionKey: "personal_days_annual" });
    expect(dedupeProvisions([a, b])).toHaveLength(2);
  });
});

describe("mergeContracts", () => {
  it("accumulates provisions for the same bargaining unit across batches", () => {
    const b1: ExtractedContract = {
      bargainingUnit: "teachers",
      unitScope: "certificated",
      provisions: [prov({ provisionKey: "sick_days_annual" })],
    };
    const b2: ExtractedContract = {
      bargainingUnit: "teachers",
      unitScope: null,
      provisions: [prov({ provisionKey: "personal_days_annual" })],
    };
    const merged = mergeContracts([[b1], [b2]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].bargainingUnit).toBe("teachers");
    expect(merged[0].provisions).toHaveLength(2);
    expect(merged[0].unitScope).toBe("certificated");
  });

  it("keeps separate units and a null bucket apart", () => {
    const teachers: ExtractedContract = {
      bargainingUnit: "teachers",
      unitScope: null,
      provisions: [prov()],
    };
    const support: ExtractedContract = {
      bargainingUnit: "support_staff",
      unitScope: null,
      provisions: [prov()],
    };
    const unknown: ExtractedContract = {
      bargainingUnit: null,
      unitScope: null,
      provisions: [prov()],
    };
    const merged = mergeContracts([[teachers, support, unknown]]);
    expect(merged).toHaveLength(3);
  });
});

describe("keywordTriagePages", () => {
  it("selects article pages with a keyword + digit and expands +/-1", () => {
    const pages = [
      "Table of contents and front matter without numbers here.".padEnd(60, " "),
      "ARTICLE V INSURANCE the district pays $5,000 toward premiums".padEnd(60, " "),
      "continuation of insurance language only prose no figures".padEnd(60, " "),
      "random boilerplate signatures page with no relevant words".padEnd(60, " "),
    ];
    const sel = keywordTriagePages(pages);
    // page 1 (insurance + $5,000) is a hit; +/-1 pulls in 0 and 2.
    expect(sel).toEqual([0, 1, 2]);
  });

  it("excludes a keyword page that has no digits", () => {
    const pages = [
      "GRIEVANCE procedure described entirely in prose no numbers".padEnd(60, " "),
    ];
    expect(keywordTriagePages(pages)).toEqual([]);
  });

  it("excludes pages whose text layer is too short (scanned)", () => {
    const pages = ["SALARY $50,000"]; // below min-chars gate
    expect(keywordTriagePages(pages)).toEqual([]);
  });
});

describe("mapProvisionsToTargets", () => {
  it("attaches all provisions to the sole contract on a doc", () => {
    const contracts: ExtractedContract[] = [
      { bargainingUnit: null, unitScope: null, provisions: [prov({ provisionKey: "a" })] },
      { bargainingUnit: "teachers", unitScope: null, provisions: [prov({ provisionKey: "b" })] },
    ];
    const { byContract, unattributed } = mapProvisionsToTargets(contracts, [
      { contractId: "100", bargainingUnit: "teachers" },
    ]);
    expect(unattributed).toBe(0);
    expect(byContract.get("100")).toHaveLength(2);
  });

  it("routes by bargaining unit when multiple contracts exist", () => {
    const contracts: ExtractedContract[] = [
      { bargainingUnit: "teachers", unitScope: null, provisions: [prov({ provisionKey: "a" })] },
      { bargainingUnit: "support_staff", unitScope: null, provisions: [prov({ provisionKey: "b" })] },
    ];
    const { byContract, unattributed } = mapProvisionsToTargets(contracts, [
      { contractId: "1", bargainingUnit: "teachers" },
      { contractId: "2", bargainingUnit: "support_staff" },
    ]);
    expect(unattributed).toBe(0);
    expect(byContract.get("1")).toHaveLength(1);
    expect(byContract.get("2")).toHaveLength(1);
  });

  it("counts unattributed provisions and still lists every target (empty)", () => {
    const contracts: ExtractedContract[] = [
      { bargainingUnit: "nurses", unitScope: null, provisions: [prov(), prov({ provisionKey: "x" })] },
    ];
    const { byContract, unattributed } = mapProvisionsToTargets(contracts, [
      { contractId: "1", bargainingUnit: "teachers" },
      { contractId: "2", bargainingUnit: "support_staff" },
    ]);
    expect(unattributed).toBe(2);
    expect(byContract.get("1")).toEqual([]);
    expect(byContract.get("2")).toEqual([]);
  });
});
