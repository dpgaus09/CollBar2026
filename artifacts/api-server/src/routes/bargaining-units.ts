// Canonical bargaining units. Mirrors pipeline common.BARGAINING_UNITS and the
// settlements/contracts/source_documents.bargaining_unit CHECK constraint
// (migration 0008). Used to validate the ?bargainingUnit query param and to
// default to 'teachers' for backward compatibility.

export const VALID_BARGAINING_UNITS = new Set<string>([
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
]);

// Human-readable labels for display (PDF export, etc.).
export const BARGAINING_UNIT_LABELS: Record<string, string> = {
  teachers: "Teachers",
  paraprofessionals: "Paraprofessionals",
  custodial_maintenance: "Custodial & Maintenance",
  transportation: "Transportation",
  secretarial_clerical: "Secretarial & Clerical",
  food_service: "Food Service",
  nurses: "Nurses",
  administrators: "Administrators",
  support_staff: "Support Staff",
  other: "Other",
};

// Validate + normalize a raw query value to a canonical unit, defaulting to
// 'teachers'. Because the result is always a member of the controlled
// vocabulary, it is safe to interpolate into raw SQL.
export function parseUnit(raw: unknown): string {
  const u = raw != null ? String(raw) : "teachers";
  return VALID_BARGAINING_UNITS.has(u) ? u : "teachers";
}
