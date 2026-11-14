CREATE TYPE "knowledge"."eval_question_origin" AS ENUM('canned', 'visitor');--> statement-breakpoint
CREATE TYPE "knowledge"."eval_question_status" AS ENUM('candidate', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "knowledge"."eval_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "knowledge"."eval_run_trigger" AS ENUM('corpus', 'manual');--> statement-breakpoint
CREATE TABLE "knowledge"."eval_question_sessions" (
	"question_id" uuid NOT NULL,
	"session_hash" varchar(64) NOT NULL,
	CONSTRAINT "eval_question_sessions_question_id_session_hash_pk" PRIMARY KEY("question_id","session_hash")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."eval_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"question" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"status" "knowledge"."eval_question_status" DEFAULT 'candidate' NOT NULL,
	"origin" "knowledge"."eval_question_origin" DEFAULT 'visitor' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"off_topic" boolean DEFAULT false NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"distinct_sessions" integer DEFAULT 0 NOT NULL,
	"last_asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge"."eval_results" (
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"question_id" uuid,
	"question" text NOT NULL,
	"answer" text,
	"chunk_ids" jsonb NOT NULL,
	"top_similarity" double precision,
	"gap" boolean NOT NULL,
	CONSTRAINT "eval_results_run_id_ordinal_pk" PRIMARY KEY("run_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "knowledge"."eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"corpus_version" integer NOT NULL,
	"trigger" "knowledge"."eval_run_trigger" NOT NULL,
	"status" "knowledge"."eval_run_status" DEFAULT 'running' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "knowledge"."eval_question_sessions" ADD CONSTRAINT "eval_question_sessions_question_id_eval_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "knowledge"."eval_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."eval_results" ADD CONSTRAINT "eval_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "knowledge"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge"."eval_results" ADD CONSTRAINT "eval_results_question_id_eval_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "knowledge"."eval_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_questions_owner_status_idx" ON "knowledge"."eval_questions" USING btree ("owner_id","status","last_asked_at");--> statement-breakpoint
CREATE INDEX "eval_runs_owner_started_idx" ON "knowledge"."eval_runs" USING btree ("owner_id","started_at");