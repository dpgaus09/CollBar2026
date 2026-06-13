-- Phase 8: public / SEO layer
-- Adds district slugs, user plan tier, and tracker stats cache table.

-- ── 1. District slugs ───────────────────────────────────────────────────────
ALTER TABLE districts ADD COLUMN IF NOT EXISTS slug text;

UPDATE districts
SET slug = TRIM(BOTH '-' FROM
  LOWER(REGEXP_REPLACE(TRIM(name), '[^a-zA-Z0-9]+', '-', 'g')));

-- Resolve duplicates: append state_district_id suffix
WITH dupes AS (
  SELECT id, slug,
    ROW_NUMBER() OVER (PARTITION BY slug ORDER BY id) AS rn
  FROM districts
)
UPDATE districts d
SET slug = d.slug || '-' || LOWER(d.state_district_id)
FROM dupes
WHERE dupes.id = d.id AND dupes.rn > 1;

ALTER TABLE districts ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS districts_slug_idx ON districts(slug);

-- ── 2. User plan tier ────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
ALTER TABLE users ADD CONSTRAINT users_plan_check
  CHECK (plan IN ('free', 'pro'));

-- ── 3. Tracker stats cache ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tracker_stats_cache (
  id          bigserial PRIMARY KEY,
  computed_at timestamptz NOT NULL DEFAULT NOW(),
  stats_json  jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS tracker_stats_cache_computed_at_idx
  ON tracker_stats_cache (computed_at DESC);
