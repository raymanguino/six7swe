ALTER TABLE "refresh_status" ADD COLUMN "claimed_by" varchar(128);--> statement-breakpoint
ALTER TABLE "refresh_status" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "refresh_status" ADD COLUMN "heartbeat_at" timestamp;--> statement-breakpoint
CREATE INDEX "refresh_status_queued_idx" ON "refresh_status" USING btree ("id") WHERE "refresh_status"."status" = 'PENDING' and "refresh_status"."claimed_at" is null;