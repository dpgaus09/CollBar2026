CREATE TABLE "benchmarks" (
"id" bigserial PRIMARY KEY NOT NULL,
"district_id" bigint REFERENCES "districts"("id"),
"doc_year" integer,
"source_url" text,
"raw_text" text,
"effective_date" date,
"expiry_date" date,
"wage_schedule" jsonb,
"parsed_at" timestamp with time zone DEFAULT now()
);
