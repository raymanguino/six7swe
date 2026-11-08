-- Mirrors backend/migrations/0001_job_hunt_boundary.sql.
-- Renames the score enum to band, converts profile_jobs.score to a 0-100
-- integer, and adds the jobs.location / jobs.date_posted columns.
-- Rename the score enum to band. The column it was attached to now stores a
-- 0-100 integer, and the enum is reused for the derived band classification.
ALTER TYPE "match_score" RENAME TO "match_band";
--> statement-breakpoint
-- Add the band column and backfill it from the existing enum score.
ALTER TABLE "profile_jobs" ADD COLUMN "band" "match_band";
--> statement-breakpoint
UPDATE "profile_jobs"
SET "band" = CASE "score"::text
  WHEN 'TOP' THEN 'TOP'::"match_band"
  WHEN 'HIGH' THEN 'HIGH'::"match_band"
  WHEN 'MEDIUM' THEN 'MEDIUM'::"match_band"
  ELSE 'LOW'::"match_band"
END;
--> statement-breakpoint
-- Convert the score column to a 0-100 integer, mapping the old enum values
-- onto the midpoint of the band each one represented.
ALTER TABLE "profile_jobs" ALTER COLUMN "score" SET DATA TYPE integer
  USING (CASE "score"::text
    WHEN 'TOP' THEN 90
    WHEN 'HIGH' THEN 75
    WHEN 'MEDIUM' THEN 50
    ELSE 25
  END);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "location" varchar(255);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "date_posted" varchar(64);
