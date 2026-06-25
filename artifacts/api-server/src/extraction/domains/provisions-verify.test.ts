import { describe, it, expect } from "vitest";
import { verifyProvisionsAgainstText } from "./provisions-verify";
import type { ExtractedContract, ProvisionItem } from "../types";

function prov(over: Partial<ProvisionItem> = {}): ProvisionItem {
  return {
    category: "insurance",
    provisionKey: "health_single_premium",
    valueNumeric: 5000,
    valueText: null,
    unit: "$",
    clauseExcerpt: null,
    pageRef: 3,
    confidence: 0.95,
    ...over,
  };
}

function contract(provisions: ProvisionItem[]): ExtractedContract {
  return { bargainingUnit: "teachers", unitScope: null, provisions };
}

// fakeDoc keyed by 0-based page index (pageRef - 1).
function fakeDoc(pages: Record<number, string>) {
  return { pageText: (i: number) => pages[i] ?? "" };
}

const PAD = " padded with prose so the page clears the min-text-chars gate.";

describe("verifyProvisionsAgainstText", () => {
  it("does not cap a $ value the page text corroborates", () => {
    const p = prov({ valueNumeric: 5000, unit: "$", pageRef: 3 });
    const stats = verifyProvisionsAgainstText(
      [contract([p])],
      fakeDoc({ 2: "Employer contributes $5,000 toward premiums." + PAD }),
    );
    expect(stats.checked).toBe(1);
    expect(stats.mismatched).toBe(0);
    expect(p.confidence).toBe(0.95);
  });

  it("caps a $ value the page text does not contain", () => {
    const p = prov({ valueNumeric: 9999, unit: "$", pageRef: 3, confidence: 0.95 });
    const stats = verifyProvisionsAgainstText(
      [contract([p])],
      fakeDoc({ 2: "Employer contributes $5,000 toward premiums." + PAD }),
    );
    expect(stats.checked).toBe(1);
    expect(stats.mismatched).toBe(1);
    expect(stats.capped).toBe(1);
    expect(p.confidence).toBe(0.6);
  });

  it("matches percent values written with % or the word percent", () => {
    const p = prov({
      category: "retirement",
      provisionKey: "retirement_pickup_pct",
      valueNumeric: 3.5,
      unit: "%",
      pageRef: 1,
      confidence: 0.9,
    });
    const stats = verifyProvisionsAgainstText(
      [contract([p])],
      fakeDoc({ 0: "District pays a 3.5% TRS pickup on behalf of staff." + PAD }),
    );
    expect(stats.mismatched).toBe(0);
    expect(p.confidence).toBe(0.9);
  });

  it("caps a percent value missing from the text", () => {
    const p = prov({
      category: "retirement",
      provisionKey: "retirement_pickup_pct",
      valueNumeric: 9.4,
      unit: "%",
      pageRef: 1,
      confidence: 0.9,
    });
    verifyProvisionsAgainstText(
      [contract([p])],
      fakeDoc({ 0: "District pays a 3.5% TRS pickup on behalf of staff." + PAD }),
    );
    expect(p.confidence).toBe(0.6);
  });

  it("skips days/hours/count units (collision-prone)", () => {
    const p = prov({
      category: "leave",
      provisionKey: "sick_days_annual",
      valueNumeric: 99,
      unit: "days",
      pageRef: 2,
      confidence: 0.9,
    });
    const stats = verifyProvisionsAgainstText(
      [contract([p])],
      fakeDoc({ 1: "Teachers receive ten sick days annually." + PAD }),
    );
    expect(stats.checked).toBe(0);
    expect(p.confidence).toBe(0.9);
  });

  it("skips provisions with no page_ref", () => {
    const p = prov({ pageRef: null, unit: "$", valueNumeric: 5000 });
    const stats = verifyProvisionsAgainstText(
      [contract([p])],
      fakeDoc({ 2: "Employer contributes $5,000." + PAD }),
    );
    expect(stats.checked).toBe(0);
  });

  it("skips scanned pages (text layer too short to verify)", () => {
    const p = prov({ valueNumeric: 5000, unit: "$", pageRef: 3, confidence: 0.95 });
    const stats = verifyProvisionsAgainstText(
      [contract([p])],
      fakeDoc({ 2: "$1" }),
    );
    expect(stats.checked).toBe(0);
    expect(p.confidence).toBe(0.95);
  });
});
