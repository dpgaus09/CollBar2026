// Shared types for the TS-native extraction engine (Task #174).
//
// SalarySchedule / SalaryCell mirror the dict shape the Python salary pipeline
// produced (lib_salary_grid.parse_pdf / lib_salary_vision._normalize) so the
// routing + storage logic ports across unchanged and the two engines stay
// comparable in the parity harness.

export type ScheduleType =
  | "lane_grid"
  | "single_column"
  | "hourly"
  | "stipend"
  | "unknown";

export interface SalaryCell {
  stepLabel: string;
  stepOrder: number;
  laneLabel: string | null;
  laneOrder: number;
  salaryAmount: number;
  pageRef: number;
}

export interface SalarySchedule {
  scheduleName: string;
  schoolYear: string | null;
  startYear: number | null;
  scheduleType: ScheduleType;
  laneLabels: string[] | null;
  stepCount: number;
  laneCount: number;
  pageStart: number;
  pageEnd: number;
  minSalary: number | null;
  maxSalary: number | null;
  confidence: number;
  needsReview: boolean;
  reviewReason: string | null;
  extractionMethod: string;
  cells: SalaryCell[];
}

// Provision domain (Task #174 T006). Mirrors the contract_provisions columns and
// the {contracts:[{...,provisions:[...]}]} shape prompt v1_il asks Claude for.
export type ProvisionCategory =
  | "compensation"
  | "insurance"
  | "retirement"
  | "leave"
  | "workday"
  | "evaluation"
  | "rif"
  | "grievance"
  | "other";

export interface ProvisionItem {
  category: ProvisionCategory;
  provisionKey: string;
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;
  clauseExcerpt: string | null;
  pageRef: number | null;
  confidence: number;
}

// One bargaining-unit agreement's worth of provisions, as the model groups them.
// Only the fields the provision domain needs (unit for routing + the items).
export interface ExtractedContract {
  bargainingUnit: string | null;
  unitScope: string | null;
  provisions: ProvisionItem[];
}

// Outcome of a domain extraction. Only "success" may be stored or cached: a
// truncated (output hit max_tokens) or parse_error (no valid JSON) result is
// fail-closed — the orchestrators must NOT run their delete-then-insert store, or
// they would wipe existing rows and replace them with nothing.
export type ExtractionStatus = "success" | "truncated" | "parse_error";

// Final-offer domain (Task #174 T007). One party's position on one topic, from an
// ELRB interest-arbitration posting. Mirrors final_offer_items columns.
export type OfferSide = "district" | "union";

export interface OfferItem {
  topic: string;
  topicLabel: string | null;
  summary: string | null;
  numericValue: number | null;
  numericUnit: string | null;
  rawText: string | null;
}

// Settlement domain (Task #176). A single 'stated' settlement derived from ONE
// contract's already-extracted compensation provisions (NOT a vision call).
// Mirrors the columns the Python `derive_settlements` 'stated' pass writes.
export interface DerivedSettlement {
  districtId: string;
  bargainingUnit: string;
  fromYear: string;
  toYear: string;
  baseIncreasePct: number;
  year2Pct: number | null;
  year3Pct: number | null;
  offSchedulePayment: number | null;
  termYears: number | null;
  confidence: number;
  contractId: string;
}
