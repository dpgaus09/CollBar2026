-- 0011_elrb_final_offers.sql
-- IL ELRB board-vs-union final offers (Task #112).
--
-- When an Illinois school district and its union reach impasse, both sides'
-- "final offers" are publicly posted on the ELRB site. CollBar scrapes each
-- posting, extracts every per-article position for each side, and diffs them
-- so a district can see exactly where the board and union still disagree (and
-- where they already agree).
--
-- All DDL here is idempotent and mirrored in api-server app.ts runMigrations(),
-- which is the authoritative apply path on every boot. Never `db push` (it
-- wants to TRUNCATE the contracts table).

-- ---------------------------------------------------------------------------
-- 1. Allow the scraped offer PDFs under source_documents.doc_type.
--    Adding a value to the IN-list only widens the constraint.
-- ---------------------------------------------------------------------------
ALTER TABLE source_documents
  DROP CONSTRAINT IF EXISTS source_documents_doc_type_check;

ALTER TABLE source_documents
  ADD CONSTRAINT source_documents_doc_type_check
  CHECK (doc_type IN (
    'cba_pdf','mou','factfinding_report','wage_settlement_report',
    'cdss_extract','directory','stats','policy_manual','non_cba',
    'final_offer'
  ));

-- ---------------------------------------------------------------------------
-- 2. Final-offer tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS final_offer_postings (
  id                     bigserial PRIMARY KEY,
  district_id            bigint REFERENCES districts(id),
  case_number            text NOT NULL,
  year                   integer NOT NULL,
  bargaining_unit        text NOT NULL DEFAULT 'teachers',
  district_name          text,
  union_name             text,
  posted_date            timestamptz,
  district_offer_url     text,
  union_offer_url        text,
  district_source_doc_id bigint REFERENCES source_documents(id),
  union_source_doc_id    bigint REFERENCES source_documents(id),
  page_url               text,
  created_at             timestamptz DEFAULT NOW(),
  updated_at             timestamptz DEFAULT NOW(),
  CONSTRAINT final_offer_postings_case_number_unique UNIQUE (case_number)
);

CREATE INDEX IF NOT EXISTS final_offer_postings_district_idx
  ON final_offer_postings (district_id);

CREATE TABLE IF NOT EXISTS final_offer_items (
  id            bigserial PRIMARY KEY,
  posting_id    bigint NOT NULL REFERENCES final_offer_postings(id) ON DELETE CASCADE,
  side          text NOT NULL,
  topic         text NOT NULL,
  topic_label   text,
  summary       text,
  numeric_value numeric(14,4),
  numeric_unit  text,
  raw_text      text,
  source_doc_id bigint REFERENCES source_documents(id),
  created_at    timestamptz DEFAULT NOW(),
  CONSTRAINT final_offer_items_posting_side_topic_unique UNIQUE (posting_id, side, topic),
  CONSTRAINT final_offer_items_side_check CHECK (side IN ('district','union'))
);

CREATE INDEX IF NOT EXISTS final_offer_items_posting_idx
  ON final_offer_items (posting_id);

CREATE TABLE IF NOT EXISTS final_offer_comparisons (
  id               bigserial PRIMARY KEY,
  posting_id       bigint NOT NULL REFERENCES final_offer_postings(id) ON DELETE CASCADE,
  topic            text NOT NULL,
  topic_label      text,
  status           text NOT NULL,
  district_item_id bigint REFERENCES final_offer_items(id),
  union_item_id    bigint REFERENCES final_offer_items(id),
  district_summary text,
  union_summary    text,
  numeric_gap      numeric(14,4),
  gap_unit         text,
  created_at       timestamptz DEFAULT NOW(),
  CONSTRAINT final_offer_comparisons_posting_topic_unique UNIQUE (posting_id, topic),
  CONSTRAINT final_offer_comparisons_status_check
    CHECK (status IN ('aligned','diff','district_only','union_only'))
);

CREATE INDEX IF NOT EXISTS final_offer_comparisons_posting_idx
  ON final_offer_comparisons (posting_id);
