ALTER TABLE "knowledge"."eval_questions" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
-- Questions already retired get their last change as the retirement time.
UPDATE "knowledge"."eval_questions" SET "retired_at" = "updated_at" WHERE "status" = 'retired';
