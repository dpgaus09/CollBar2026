-- 0008_multi_bargaining_unit.sql
-- Multi-bargaining-unit support.
--
-- CollBar districts negotiate separately with each bargaining unit (teachers,
-- paraprofessionals, custodial/maintenance, transportation, secretarial/clerical,
-- food service, nurses, administrators, or a broad "support_staff" catch-all for
-- mixed non-certified agreements). This migration makes `bargaining_unit` a
-- first-class dimension across documents, contracts, and the settlement benchmark,
-- and adds settlement provenance (contract_id / source_doc_id) so stated CBA
-- settlements are attributable and auditable.
--
-- Backward compatibility: every column defaults to 'teachers'. All existing
-- settlements are TSS-derived (teacher-only) or stated rows that will be
-- re-derived by the extraction pipeline, so the blanket 'teachers' backfill is
-- correct for the existing data.

-- Canonical bargaining-unit vocabulary (kept in sync with the Python classifier
-- in pipeline/common.py and the TS type in lib/db).
--   teachers, paraprofessionals, custodial_maintenance, transportation,
--   secretarial_clerical, food_service, nurses, administrators, support_staff, other

-- ---------------------------------------------------------------------------
-- source_documents
-- ---------------------------------------------------------------------------
ALTER TABLE source_documents
  ADD COLUMN bargaining_unit text NOT NULL DEFAULT 'teachers';

ALTER TABLE source_documents
  ADD CONSTRAINT source_documents_bargaining_unit_check
  CHECK (bargaining_unit IN (
    'teachers','paraprofessionals','custodial_maintenance','transportation',
    'secretarial_clerical','food_service','nurses','administrators',
    'support_staff','other'
  ));

-- Allow multiple CBAs per district (one per unit). NULL district_ids remain
-- distinct under Postgres default NULLS DISTINCT semantics.
ALTER TABLE source_documents
  ADD CONSTRAINT source_documents_district_unit_hash_unique
  UNIQUE (district_id, bargaining_unit, file_hash);

CREATE INDEX IF NOT EXISTS source_documents_district_unit_idx
  ON source_documents (district_id, bargaining_unit);

-- ---------------------------------------------------------------------------
-- contracts
-- ---------------------------------------------------------------------------
ALTER TABLE contracts
  ADD COLUMN bargaining_unit text NOT NULL DEFAULT 'teachers';

ALTER TABLE contracts
  ADD CONSTRAINT contracts_bargaining_unit_check
  CHECK (bargaining_unit IN (
    'teachers','paraprofessionals','custodial_maintenance','transportation',
    'secretarial_clerical','food_service','nurses','administrators',
    'support_staff','other'
  ));

CREATE INDEX IF NOT EXISTS contracts_district_unit_idx
  ON contracts (district_id, bargaining_unit);

-- ---------------------------------------------------------------------------
-- settlements (the benchmark) — unit dimension + provenance
-- ---------------------------------------------------------------------------
ALTER TABLE settlements
  ADD COLUMN bargaining_unit text NOT NULL DEFAULT 'teachers';

ALTER TABLE settlements
  ADD CONSTRAINT settlements_bargaining_unit_check
  CHECK (bargaining_unit IN (
    'teachers','paraprofessionals','custodial_maintenance','transportation',
    'secretarial_clerical','food_service','nurses','administrators',
    'support_staff','other'
  ));

ALTER TABLE settlements
  ADD COLUMN contract_id bigint REFERENCES contracts(id);

ALTER TABLE settlements
  ADD COLUMN source_doc_id bigint REFERENCES source_documents(id);

-- Swap the unique key so a teacher settlement and a custodian settlement for the
-- same years no longer collide.
ALTER TABLE settlements
  DROP CONSTRAINT settlements_district_id_from_year_to_year_unique;

ALTER TABLE settlements
  ADD CONSTRAINT settlements_district_unit_year_unique
  UNIQUE (district_id, bargaining_unit, from_year, to_year);

CREATE INDEX IF NOT EXISTS settlements_bargaining_unit_idx
  ON settlements (bargaining_unit);
