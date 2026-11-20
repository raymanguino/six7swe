-- The risk scan (#212). The migrator applies pending migrations in one
-- transaction; ADD VALUE is allowed there (Postgres 12+) as long as nothing in
-- that transaction uses the new value, and nothing here does. Existing ready
-- documents keep `scanned_at` null, which is what the boot-time backfill scans.
ALTER TYPE "knowledge"."document_status" ADD VALUE 'needs_review' BEFORE 'ready';--> statement-breakpoint
ALTER TABLE "knowledge"."documents" ADD COLUMN "risk_findings" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge"."documents" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge"."documents" ADD COLUMN "approved_at" timestamp with time zone;