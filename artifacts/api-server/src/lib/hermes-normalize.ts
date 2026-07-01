// Runtime validators for externally-produced (HERMES) normalized extraction JSON
// (Task #248). Each validator maps an untrusted payload to the SAME normalized
// shape the in-app engine feeds to createVersion/promoteVersion, so imported data
// is projected through the identical store functions:
//   - salary        -> { schedules: SalarySchedule[] }
//   - provisions    -> { contracts: ExtractedContract[] }
//   - contract_meta -> { meta: ContractMeta }
//
// Validation is structurally strict (reject the item, never the whole batch) but
// tolerant on scalar coercion. Because the salary/provisions stores are
// delete-then-insert, a malformed payload must fail-closed rather than promote
// garbage over live rows.

import type {
  SalarySchedule,
  SalaryCell,
  ScheduleType,
  ExtractedContract,
  ProvisionItem,
  ProvisionCategory,
} from "../extraction/types.js";
import {
  normalizeContractMeta,
  type ContractMeta,
} from "../extraction/domains/contract-meta.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const SCHEDULE_TYPES: ReadonlySet<string> = new Set<ScheduleType>([
  "lane_grid",
  "single_column",
  "hourly",
  "stipend",
  "unknown",
]);

const PROVISION_CATEGORIES: ReadonlySet<string> = new Set<ProvisionCategory>([
  "compensation",
  "insurance",
  "retirement",
  "leave",
  "workday",
  "evaluation",
  "rif",
  "grievance",
  "other",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  return null;
}

function asNumOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asIntOr(v: unknown, dflt: number): number {
  const n = asNumOrNull(v);
  return n == null ? dflt : Math.trunc(n);
}

function asBool(v: unknown, dflt = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|1|yes)$/i.test(v.trim());
  return dflt;
}

// -------------------------- salary --------------------------

function validateCell(raw: unknown, ctx: string): ValidationResult<SalaryCell> {
  if (!isObject(raw)) return { ok: false, error: `${ctx}: cell is not an object` };
  const stepLabel = asString(raw.stepLabel);
  if (stepLabel == null) return { ok: false, error: `${ctx}: cell.stepLabel is required` };
  const salaryAmount = asNumOrNull(raw.salaryAmount);
  if (salaryAmount == null) {
    return { ok: false, error: `${ctx}: cell.salaryAmount must be a finite number` };
  }
  return {
    ok: true,
    value: {
      stepLabel,
      stepOrder: asIntOr(raw.stepOrder, 0),
      laneLabel: asString(raw.laneLabel),
      laneOrder: asIntOr(raw.laneOrder, 0),
      salaryAmount,
      pageRef: asIntOr(raw.pageRef, 0),
    },
  };
}

function validateSchedule(
  raw: unknown,
  ctx: string,
): ValidationResult<SalarySchedule> {
  if (!isObject(raw)) return { ok: false, error: `${ctx}: schedule is not an object` };
  const scheduleName = asString(raw.scheduleName);
  if (scheduleName == null) {
    return { ok: false, error: `${ctx}: scheduleName is required` };
  }
  if (!Array.isArray(raw.cells)) {
    return { ok: false, error: `${ctx}: cells must be an array` };
  }
  const cells: SalaryCell[] = [];
  for (let i = 0; i < raw.cells.length; i++) {
    const c = validateCell(raw.cells[i], `${ctx}.cells[${i}]`);
    if (!c.ok) return c;
    cells.push(c.value);
  }
  const scheduleTypeRaw = asString(raw.scheduleType) ?? "unknown";
  const scheduleType = (
    SCHEDULE_TYPES.has(scheduleTypeRaw) ? scheduleTypeRaw : "unknown"
  ) as ScheduleType;
  const laneLabels = Array.isArray(raw.laneLabels)
    ? raw.laneLabels.map((l) => String(l))
    : null;
  const confidence = asNumOrNull(raw.confidence);
  return {
    ok: true,
    value: {
      scheduleName,
      schoolYear: asString(raw.schoolYear),
      startYear: asNumOrNull(raw.startYear),
      scheduleType,
      laneLabels,
      stepCount: asIntOr(raw.stepCount, cells.length),
      laneCount: asIntOr(raw.laneCount, laneLabels?.length ?? 0),
      pageStart: asIntOr(raw.pageStart, 0),
      pageEnd: asIntOr(raw.pageEnd, 0),
      minSalary: asNumOrNull(raw.minSalary),
      maxSalary: asNumOrNull(raw.maxSalary),
      confidence: confidence == null ? 0 : confidence,
      needsReview: asBool(raw.needsReview),
      reviewReason: asString(raw.reviewReason),
      extractionMethod: asString(raw.extractionMethod) ?? "hermes",
      cells,
    },
  };
}

// Accepts { schedules: [...] } or a bare array of schedules.
export function validateSalaryNormalized(
  input: unknown,
): ValidationResult<{ schedules: SalarySchedule[] }> {
  const arr = Array.isArray(input)
    ? input
    : isObject(input) && Array.isArray(input.schedules)
      ? input.schedules
      : null;
  if (arr == null) {
    return { ok: false, error: "salary: expected { schedules: [...] }" };
  }
  const schedules: SalarySchedule[] = [];
  for (let i = 0; i < arr.length; i++) {
    const s = validateSchedule(arr[i], `schedules[${i}]`);
    if (!s.ok) return s;
    schedules.push(s.value);
  }
  return { ok: true, value: { schedules } };
}

// -------------------------- provisions --------------------------

function validateProvision(
  raw: unknown,
  ctx: string,
): ValidationResult<ProvisionItem> {
  if (!isObject(raw)) return { ok: false, error: `${ctx}: provision is not an object` };
  const provisionKey = asString(raw.provisionKey);
  if (provisionKey == null) {
    return { ok: false, error: `${ctx}: provisionKey is required` };
  }
  const categoryRaw = asString(raw.category) ?? "other";
  const category = (
    PROVISION_CATEGORIES.has(categoryRaw) ? categoryRaw : "other"
  ) as ProvisionCategory;
  const confidence = asNumOrNull(raw.confidence);
  return {
    ok: true,
    value: {
      category,
      provisionKey,
      valueNumeric: asNumOrNull(raw.valueNumeric),
      valueText: asString(raw.valueText),
      unit: asString(raw.unit),
      clauseExcerpt: asString(raw.clauseExcerpt),
      pageRef: asNumOrNull(raw.pageRef) == null ? null : asIntOr(raw.pageRef, 0),
      confidence: confidence == null ? 0 : confidence,
    },
  };
}

function validateContract(
  raw: unknown,
  ctx: string,
): ValidationResult<ExtractedContract> {
  if (!isObject(raw)) return { ok: false, error: `${ctx}: contract is not an object` };
  if (!Array.isArray(raw.provisions)) {
    return { ok: false, error: `${ctx}: provisions must be an array` };
  }
  const provisions: ProvisionItem[] = [];
  for (let i = 0; i < raw.provisions.length; i++) {
    const p = validateProvision(raw.provisions[i], `${ctx}.provisions[${i}]`);
    if (!p.ok) return p;
    provisions.push(p.value);
  }
  return {
    ok: true,
    value: {
      bargainingUnit: asString(raw.bargainingUnit),
      unitScope: asString(raw.unitScope),
      provisions,
    },
  };
}

// Accepts { contracts: [...] } or a bare array of contracts.
export function validateProvisionsNormalized(
  input: unknown,
): ValidationResult<{ contracts: ExtractedContract[] }> {
  const arr = Array.isArray(input)
    ? input
    : isObject(input) && Array.isArray(input.contracts)
      ? input.contracts
      : null;
  if (arr == null) {
    return { ok: false, error: "provisions: expected { contracts: [...] }" };
  }
  const contracts: ExtractedContract[] = [];
  for (let i = 0; i < arr.length; i++) {
    const c = validateContract(arr[i], `contracts[${i}]`);
    if (!c.ok) return c;
    contracts.push(c.value);
  }
  return { ok: true, value: { contracts } };
}

// Total provision items across all contracts — used by the empty-clear guard.
export function countProvisions(contracts: ExtractedContract[]): number {
  return contracts.reduce((n, c) => n + c.provisions.length, 0);
}

// -------------------------- contract_meta --------------------------

// Accepts { meta: {...} } or a bare object; camelCase or snake_case keys. Reuses
// the engine's normalizeContractMeta, so an all-null result is a legitimate
// "nothing found" (the store COALESCEs — it never overwrites with null).
export function validateContractMetaNormalized(
  input: unknown,
): ValidationResult<{ meta: ContractMeta }> {
  if (!isObject(input)) {
    return { ok: false, error: "contract_meta: expected an object" };
  }
  const src = isObject(input.meta) ? input.meta : input;
  const o: Record<string, unknown> = {
    union_name: src.union_name ?? src.unionName,
    affiliation: src.affiliation,
    effective_start: src.effective_start ?? src.effectiveStart,
    effective_end: src.effective_end ?? src.effectiveEnd,
    term_years: src.term_years ?? src.termYears,
  };
  return { ok: true, value: { meta: normalizeContractMeta(o) } };
}
