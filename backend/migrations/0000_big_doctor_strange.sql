CREATE TYPE "public"."job_source" AS ENUM('LINKEDIN', 'INDEED', 'GLASSDOOR', 'COMPANY_WEBSITE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."match_band" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'TOP');--> statement-breakpoint
CREATE TYPE "public"."refresh_update_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."refresh_update_status_step" AS ENUM('PENDING', 'FETCHING_JOBS', 'FILTERING_JOBS');--> statement-breakpoint
CREATE TABLE "content_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "portfolio_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"title" varchar(512) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(50),
	"location" varchar(255),
	"linkedin_url" varchar(512),
	"github_url" varchar(512),
	"summary" text,
	"skills" jsonb DEFAULT '[]'::jsonb,
	"experience" jsonb DEFAULT '[]'::jsonb,
	"projects" jsonb DEFAULT '[]'::jsonb,
	"full_resume_text" text NOT NULL,
	"resume_filename" varchar(255),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" "job_source" DEFAULT 'LINKEDIN',
	"source_job_id" varchar(255) NOT NULL,
	"link" varchar(512) NOT NULL,
	"company" varchar(255) NOT NULL,
	"position" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"location" varchar(255),
	"date_posted" varchar(64),
	"hash" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "jobs_source_id_source_job_id_unique" UNIQUE("source_id","source_job_id")
);
--> statement-breakpoint
CREATE TABLE "profile_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" integer NOT NULL,
	"job_id" integer NOT NULL,
	"job_hash" varchar(64) NOT NULL,
	"score" integer,
	"band" "match_band",
	"explanation" text,
	"first_skill_match" text,
	"second_skill_match" text,
	"third_skill_match" text,
	"summary" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "profile_jobs_profile_id_job_id_unique" UNIQUE("profile_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"keywords" varchar(255)[],
	"location" varchar(255),
	"additional_context" text,
	"resume" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "profiles_user_id_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "refresh_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" integer NOT NULL,
	"status" "refresh_update_status" DEFAULT 'PENDING',
	"step" "refresh_update_status_step" DEFAULT 'PENDING',
	"description" varchar(512),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"auth_id" varchar(255),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_auth_id_unique" UNIQUE("auth_id")
);
--> statement-breakpoint
ALTER TABLE "profile_jobs" ADD CONSTRAINT "profile_jobs_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_jobs" ADD CONSTRAINT "profile_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_status" ADD CONSTRAINT "refresh_status_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_jobs_source_job_lookup" ON "jobs" USING btree ("source_id","source_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_status_active_profile_unique" ON "refresh_status" USING btree ("profile_id") WHERE "refresh_status"."status" in ('PENDING', 'IN_PROGRESS');