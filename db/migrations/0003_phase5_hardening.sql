ALTER TABLE "settlements" ADD COLUMN "page_ref" integer;
--> statement-breakpoint
ALTER TABLE "factfinding_proposals" ADD COLUMN "page_ref" integer;
--> statement-breakpoint
ALTER TABLE "factfinding_proposals" ADD COLUMN "human_verified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "factfinding_proposals" ADD COLUMN "confidence" numeric(3,2);
--> statement-breakpoint
CREATE TABLE "alerts" (
"id" bigserial PRIMARY KEY NOT NULL,
"source_doc_id" bigint,
"district_id" bigint,
"alert_type" text NOT NULL,
"doc_name" text,
"source_url" text,
"file_hash" char(64),
"detected_at" timestamp with time zone DEFAULT now(),
"status" text NOT NULL DEFAULT 'pending',
"acknowledged_at" timestamp with time zone,
"acknowledged_by" text,
"notes" text,
CONSTRAINT "alerts_alert_type_check" CHECK ("alert_type" IN ('new_doc', 'changed_doc', 'new_settlement')),
CONSTRAINT "alerts_status_check" CHECK ("status" IN ('pending', 'acknowledged'))
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_source_doc_id_source_documents_id_fk" FOREIGN KEY ("source_doc_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "cdss_staging" (
"id" bigserial PRIMARY KEY NOT NULL,
"raw_json" jsonb,
"source_url" text,
"retrieved_at" timestamp with time zone DEFAULT now(),
"district_name_raw" text,
"district_id" bigint,
"loaded_at" timestamp with time zone,
"status" text NOT NULL DEFAULT 'pending',
"notes" text,
CONSTRAINT "cdss_staging_status_check" CHECK ("status" IN ('pending', 'matched', 'loaded', 'error'))
);
--> statement-breakpoint
ALTER TABLE "cdss_staging" ADD CONSTRAINT "cdss_staging_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;
