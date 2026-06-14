// Canonical bargaining-unit vocabulary for CollBar.
// Kept in sync with the SQL CHECK constraints (db/migrations/0008_*) and the
// Python classifier in pipeline/common.py.
export const BARGAINING_UNITS = [
  "teachers",
  "paraprofessionals",
  "custodial_maintenance",
  "transportation",
  "secretarial_clerical",
  "food_service",
  "nurses",
  "administrators",
  "support_staff",
  "other",
] as const;

export type BargainingUnit = (typeof BARGAINING_UNITS)[number];

// Human-readable labels for UI display.
export const BARGAINING_UNIT_LABELS: Record<BargainingUnit, string> = {
  teachers: "Teachers",
  paraprofessionals: "Paraprofessionals",
  custodial_maintenance: "Custodial & Maintenance",
  transportation: "Transportation",
  secretarial_clerical: "Secretarial & Clerical",
  food_service: "Food Service",
  nurses: "Nurses",
  administrators: "Administrators",
  support_staff: "Support Staff (combined)",
  other: "Other",
};

// SQL fragment for CHECK constraints / raw queries.
export const BARGAINING_UNIT_SQL_LIST = BARGAINING_UNITS.map(
  (u) => `'${u}'`,
).join(",");
