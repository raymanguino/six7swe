-- Link local users to their external auth provider id (Supabase Auth).
--
-- Mirrors backend/migrations/0002_user_auth_id.sql. The unique constraint
-- (not a bare index) matches how Drizzle models a column-level `.unique()`,
-- so `drizzle-kit push` does not try to re-add it on every run.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_id" varchar(255);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_auth_id_unique" UNIQUE ("auth_id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
