-- One sequence shared by every profile row on purpose, so a version is never
-- reused, not even by a draft written after the previous one was published or
-- discarded. It is not OWNED BY the column: its values outlive any one row.
CREATE SEQUENCE "knowledge"."profile_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "knowledge"."profiles" ADD COLUMN "version" bigint DEFAULT nextval('knowledge.profile_version_seq') NOT NULL;