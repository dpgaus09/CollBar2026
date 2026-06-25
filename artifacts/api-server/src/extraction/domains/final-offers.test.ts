import { describe, it, expect } from "vitest";
import { normalizeOfferItems } from "./final-offers";
import {
  normalizeText,
  textAligned,
  classifyPair,
  buildComparisons,
  type OfferItemRow,
} from "./final-offers-store";

describe("normalizeOfferItems", () => {
  it("coerces unknown topics to 'other' and unknown units to null", () => {
    const out = normalizeOfferItems([
      { topic: "Salary", numeric_value: 3.5, numeric_unit: "PERCENT" },
      { topic: "wages", numeric_value: 1000, numeric_unit: "dollars" },
    ]);
    expect(out[0].topic).toBe("salary");
    expect(out[0].numericUnit).toBe("percent");
    expect(out[1].topic).toBe("other"); // "wages" not in vocab
    expect(out[1].numericUnit).toBeNull(); // "dollars" not a valid unit
  });

  it("normalizes hyphen/space topics (work-year -> work_year)", () => {
    expect(normalizeOfferItems([{ topic: "work-year" }])[0].topic).toBe("work_year");
    expect(normalizeOfferItems([{ topic: "layoff rif" }])[0].topic).toBe("layoff_rif");
  });

  it("dedupes to at most one item per topic, keeping the first", () => {
    const out = normalizeOfferItems([
      { topic: "salary", summary: "first", numeric_value: 3 },
      { topic: "salary", summary: "second", numeric_value: 4 },
      { topic: "leave", summary: "leave one" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].summary).toBe("first");
    expect(out[1].topic).toBe("leave");
  });

  it("coerces numeric strings and blanks", () => {
    const out = normalizeOfferItems([
      { topic: "salary", numeric_value: "3.5%", summary: "  raise  ", raw_text: "" },
      { topic: "insurance", numeric_value: "$1,200", topic_label: "  " },
      { topic: "term", numeric_value: "n/a" },
    ]);
    expect(out[0].numericValue).toBe(3.5);
    expect(out[0].summary).toBe("raise");
    expect(out[0].rawText).toBeNull();
    expect(out[1].numericValue).toBe(1200);
    expect(out[1].topicLabel).toBeNull();
    expect(out[2].numericValue).toBeNull();
  });

  it("returns [] for non-array / junk input", () => {
    expect(normalizeOfferItems(null)).toEqual([]);
    expect(normalizeOfferItems({ items: [] })).toEqual([]);
    expect(normalizeOfferItems(["x", 3, null])).toEqual([]);
  });
});

describe("normalizeText", () => {
  it("lowercases, strips framing words, and collapses whitespace", () => {
    expect(normalizeText("The Board PROPOSES a 3% raise")).toBe("the a 3% raise");
    expect(normalizeText("Union shall offer 5 days")).toBe("5 days");
  });
});

describe("textAligned", () => {
  it("aligns same clause framed from each side", () => {
    expect(
      textAligned(
        "The Board proposes a duty-free lunch period of 30 minutes",
        "The Union proposes a duty-free lunch period of 30 minutes",
      ),
    ).toBe(true);
  });

  it("does not align when embedded numbers differ", () => {
    expect(
      textAligned("sick leave of 10 days per year", "sick leave of 12 days per year"),
    ).toBe(false);
  });

  it("does not fuzzy-match very short strings", () => {
    expect(textAligned("3 days", "3 days")).toBe(true); // exact still ok
    expect(textAligned("yes", "yep")).toBe(false); // too short to fuzzy match
  });

  it("returns false when either side is empty after normalization", () => {
    expect(textAligned("board union district", "")).toBe(false);
  });
});

describe("classifyPair", () => {
  it("aligns numbers within per-unit tolerance", () => {
    const r = classifyPair(
      { value: 3.5, unit: "percent", summary: null, rawText: null },
      { value: 3.52, unit: "percent", summary: null, rawText: null },
    );
    expect(r.status).toBe("aligned");
    expect(r.gap).toBeCloseTo(0.02, 5);
    expect(r.gapUnit).toBe("percent");
  });

  it("flags a real numeric gap as diff (gap = union - district)", () => {
    const r = classifyPair(
      { value: 2, unit: "percent", summary: "2%", rawText: "2%" },
      { value: 4, unit: "percent", summary: "4%", rawText: "4%" },
    );
    expect(r.status).toBe("diff");
    expect(r.gap).toBe(2);
    expect(r.gapUnit).toBe("percent");
  });

  it("never overrides a numeric gap with language similarity", () => {
    const r = classifyPair(
      { value: 2, unit: "percent", summary: "across the board raise", rawText: "across the board raise" },
      { value: 4, unit: "percent", summary: "across the board raise", rawText: "across the board raise" },
    );
    expect(r.status).toBe("diff");
  });

  it("falls back to text alignment when units differ or are missing", () => {
    const r = classifyPair(
      { value: null, unit: null, summary: "retain current grievance procedure", rawText: "retain current grievance procedure" },
      { value: null, unit: null, summary: "retain current grievance procedure", rawText: "retain current grievance procedure" },
    );
    expect(r.status).toBe("aligned");
    expect(r.gap).toBeNull();
    expect(r.gapUnit).toBeNull();
  });
});

describe("buildComparisons", () => {
  const mk = (
    id: string,
    side: "district" | "union",
    topic: string,
    extra: Partial<OfferItemRow> = {},
  ): OfferItemRow => ({
    id,
    side,
    topic,
    topicLabel: extra.topicLabel ?? topic,
    summary: extra.summary ?? null,
    numericValue: extra.numericValue ?? null,
    numericUnit: extra.numericUnit ?? null,
    rawText: extra.rawText ?? null,
  });

  it("pairs both sides and computes gap = union - district", () => {
    const rows = [
      mk("1", "district", "salary", { numericValue: 2, numericUnit: "percent" }),
      mk("2", "union", "salary", { numericValue: 4.5, numericUnit: "percent" }),
    ];
    const cmp = buildComparisons(rows);
    expect(cmp).toHaveLength(1);
    expect(cmp[0].status).toBe("diff");
    expect(cmp[0].numericGap).toBe(2.5);
    expect(cmp[0].districtItemId).toBe("1");
    expect(cmp[0].unionItemId).toBe("2");
  });

  it("marks district_only and union_only when a side is missing", () => {
    const rows = [
      mk("1", "district", "salary", { numericValue: 2, numericUnit: "percent" }),
      mk("2", "union", "leave", { summary: "more sick days" }),
    ];
    const cmp = buildComparisons(rows);
    const salary = cmp.find((c) => c.topic === "salary")!;
    const leave = cmp.find((c) => c.topic === "leave")!;
    expect(salary.status).toBe("district_only");
    expect(salary.unionItemId).toBeNull();
    expect(leave.status).toBe("union_only");
    expect(leave.districtItemId).toBeNull();
  });
});
