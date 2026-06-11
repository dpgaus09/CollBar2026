CREATE TABLE "districts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"state" char(2) DEFAULT 'OH' NOT NULL,
	"state_district_id" text NOT NULL,
	"name" text NOT NULL,
	"county" text,
	"district_type" text,
	"enrollment" integer,
	"valuation" numeric(15, 2),
	"avg_teacher_salary" numeric(10, 2),
	"website_url" text,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "districts_state_state_district_id_unique" UNIQUE("state","state_district_id")
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"district_id" bigint,
	"doc_type" text,
	"source_url" text NOT NULL,
	"file_hash" char(64),
	"storage_key" text,
	"school_year" varchar(7),
	"retrieved_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "source_documents_source_url_file_hash_unique" UNIQUE("source_url","file_hash"),
	CONSTRAINT "source_documents_doc_type_check" CHECK ("source_documents"."doc_type" IN ('cba_pdf','mou','factfinding_report','wage_settlement_report','cdss_extract','directory','stats'))
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"district_id" bigint,
	"union_name" text,
	"affiliation" text,
	"unit_scope" text,
	"effective_start" date,
	"effective_end" date,
	"term_years" numeric(3, 1),
	"has_reopener" boolean,
	"reopener_terms" text,
	"source_doc_id" bigint,
	CONSTRAINT "contracts_district_id_unit_scope_effective_start_unique" UNIQUE("district_id","unit_scope","effective_start")
);
--> statement-breakpoint
CREATE TABLE "contract_provisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"contract_id" bigint,
	"category" text,
	"provision_key" text,
	"value_numeric" numeric(12, 2),
	"value_text" text,
	"unit" text,
	"clause_excerpt" text,
	"page_ref" integer,
	"confidence" numeric(3, 2),
	"human_verified" boolean DEFAULT false,
	CONSTRAINT "contract_provisions_category_check" CHECK ("contract_provisions"."category" IN ('compensation','insurance','retirement','leave','workday','evaluation','rif','grievance','other'))
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"district_id" bigint,
	"from_year" varchar(7),
	"to_year" varchar(7),
	"base_increase_pct" numeric(5, 2),
	"year2_pct" numeric(5, 2),
	"year3_pct" numeric(5, 2),
	"off_schedule_payment" numeric(10, 2),
	"insurance_changed" boolean,
	"term_years" numeric(3, 1),
	"method" text,
	"confidence" numeric(3, 2),
	"human_verified" boolean DEFAULT false,
	"notes" text,
	CONSTRAINT "settlements_district_id_from_year_to_year_unique" UNIQUE("district_id","from_year","to_year")
);
--> statement-breakpoint
CREATE TABLE "factfinding_proposals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"district_id" bigint,
	"case_number" text,
	"report_date" date,
	"union_name" text,
	"employer_proposal_pct" numeric(5, 2),
	"union_proposal_pct" numeric(5, 2),
	"factfinder_recommendation_pct" numeric(5, 2),
	"year_covered" varchar(7),
	"source_doc_id" bigint
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_doc_id" bigint,
	"model" text,
	"prompt_version" text,
	"run_at" timestamp with time zone DEFAULT now(),
	"status" text DEFAULT 'pending',
	"error" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'district_user',
	"district_id" bigint,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('admin','district_user'))
);
--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_source_doc_id_source_documents_id_fk" FOREIGN KEY ("source_doc_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_provisions" ADD CONSTRAINT "contract_provisions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factfinding_proposals" ADD CONSTRAINT "factfinding_proposals_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factfinding_proposals" ADD CONSTRAINT "factfinding_proposals_source_doc_id_source_documents_id_fk" FOREIGN KEY ("source_doc_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_source_doc_id_source_documents_id_fk" FOREIGN KEY ("source_doc_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_district_id_districts_id_fk" FOREIGN KEY ("district_id") REFERENCES "public"."districts"("id") ON DELETE no action ON UPDATE no action;