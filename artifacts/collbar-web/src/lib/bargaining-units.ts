// Canonical bargaining-unit identifiers + display labels. Mirrors the API's
// parseUnit whitelist (api-server/src/routes/bargaining-units.ts). Kept in one
// place so every district tab labels and validates units consistently.

export const DEFAULT_UNIT = "teachers";

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

export const CANONICAL_UNITS = Object.keys(BARGAINING_UNIT_LABELS);

export function unitLabel(u: string): string {
  return BARGAINING_UNIT_LABELS[u] ?? u;
}

export function isCanonicalUnit(u: string | null | undefined): boolean {
  return !!u && CANONICAL_UNITS.includes(u);
}
