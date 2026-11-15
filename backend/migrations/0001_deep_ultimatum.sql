ALTER TABLE "profile_jobs" ADD COLUMN "knowledge_version" integer;--> statement-breakpoint
ALTER TABLE "profile_jobs" ADD COLUMN "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "resume";