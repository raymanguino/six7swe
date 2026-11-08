-- Link local users to their external auth provider id.
ALTER TABLE "users" ADD COLUMN "auth_id" varchar(255);
--> statement-breakpoint
-- A UNIQUE CONSTRAINT (not a bare index): Drizzle models a column-level
-- `.unique()` as a table constraint, and `drizzle-kit push` introspects
-- pg_constraint. A standalone CREATE UNIQUE INDEX has no pg_constraint row,
-- so push would try to add the constraint again on every run.
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_auth_id_unique" UNIQUE ("auth_id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
