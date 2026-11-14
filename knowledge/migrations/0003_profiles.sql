CREATE TYPE "knowledge"."profile_stage" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "knowledge"."profiles" (
	"owner_id" varchar(255) NOT NULL,
	"stage" "knowledge"."profile_stage" NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"location" text,
	"summary" text NOT NULL,
	"skills" jsonb NOT NULL,
	"experience" jsonb NOT NULL,
	"projects" jsonb NOT NULL,
	"links" jsonb NOT NULL,
	"source_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_owner_id_stage_pk" PRIMARY KEY("owner_id","stage")
);
--> statement-breakpoint
ALTER TABLE "knowledge"."profiles" ADD CONSTRAINT "profiles_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "knowledge"."documents"("id") ON DELETE set null ON UPDATE no action;