CREATE TABLE "peer_sets" (
  "id" bigserial PRIMARY KEY,
  "user_id" bigint NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "district_ids" bigint[] NOT NULL DEFAULT '{}',
  "filters_json" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX "idx_peer_sets_user_id" ON "peer_sets" ("user_id");
