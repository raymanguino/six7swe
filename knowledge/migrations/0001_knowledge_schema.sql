CREATE SCHEMA "knowledge";
--> statement-breakpoint
CREATE TYPE "knowledge"."document_kind" AS ENUM('resume', 'supporting');--> statement-breakpoint
CREATE TYPE "knowledge"."document_status" AS ENUM('pending', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "knowledge"."chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text,
	"content" text NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge"."corpus_state" (
	"owner_id" varchar(255) PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"filename" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_path" text NOT NULL,
	"kind" "knowledge"."document_kind" DEFAULT 'supporting' NOT NULL,
	"is_primary_resume" boolean DEFAULT false NOT NULL,
	"status" "knowledge"."document_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"extracted_text" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge"."chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "knowledge"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_ordinal_uq" ON "knowledge"."chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "knowledge"."chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "documents_owner_sha256_uq" ON "knowledge"."documents" USING btree ("owner_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_owner_primary_resume_uq" ON "knowledge"."documents" USING btree ("owner_id") WHERE "knowledge"."documents"."is_primary_resume" = true;--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "knowledge"."documents" USING btree ("status");