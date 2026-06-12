ALTER TABLE "contract_provisions" ADD COLUMN "is_audit_sample" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "contract_provisions" ADD COLUMN "audit_verdict" text;
--> statement-breakpoint
ALTER TABLE "contract_provisions" ADD CONSTRAINT "contract_provisions_audit_verdict_check" CHECK ("audit_verdict" IN ('agree','disagree'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cp_audit_sample" ON "contract_provisions" ("is_audit_sample") WHERE "is_audit_sample" = true;
