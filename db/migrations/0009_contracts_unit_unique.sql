-- 0009_contracts_unit_unique.sql
-- Make the contracts uniqueness key bargaining-unit aware.
--
-- Before: UNIQUE (district_id, unit_scope, effective_start). Because the
-- bargaining unit was not part of the key, two different units (e.g. teachers
-- and paraprofessionals) that happened to share the same unit_scope text and
-- effective_start would collide, and saving one would silently overwrite the
-- other — losing a whole unit's contract.
--
-- After: UNIQUE (district_id, bargaining_unit, unit_scope, effective_start), so
-- every bargaining unit gets its own contract row per district and start date.
-- Adding a column to a unique key only makes it more permissive, so all existing
-- rows remain valid and no data is lost.

-- Idempotent: drizzle-kit `push-force` cannot apply UNIQUE constraints to
-- populated tables non-interactively, so this DB may already have been patched
-- via raw SQL. Guard the ADD so a replay is a no-op instead of an error.

ALTER TABLE contracts
  DROP CONSTRAINT IF EXISTS contracts_district_id_unit_scope_effective_start_unique;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contracts_district_bargaining_unit_scope_start_unique'
      AND conrelid = 'contracts'::regclass
  ) THEN
    ALTER TABLE contracts
      ADD CONSTRAINT contracts_district_bargaining_unit_scope_start_unique
      UNIQUE (district_id, bargaining_unit, unit_scope, effective_start);
  END IF;
END $$;
