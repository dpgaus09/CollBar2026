ALTER TABLE "extraction_runs" ADD COLUMN IF NOT EXISTS "used_ocr" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD COLUMN IF NOT EXISTS "ocr_confidence" numeric(5, 2);
--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD COLUMN IF NOT EXISTS "ocr_low_quality" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_er_ocr_low_quality" ON "extraction_runs" ("ocr_low_quality") WHERE "ocr_low_quality" = true;
