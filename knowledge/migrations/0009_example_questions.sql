ALTER TYPE "knowledge"."eval_question_origin" ADD VALUE 'example';--> statement-breakpoint
ALTER TABLE "knowledge"."eval_questions" ADD COLUMN "example_clicks" integer DEFAULT 0 NOT NULL;