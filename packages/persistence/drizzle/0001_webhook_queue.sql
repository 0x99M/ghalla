ALTER TABLE "webhook_events" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "webhook_events_claimable_idx" ON "webhook_events" USING btree ("next_attempt_at") WHERE "webhook_events"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_events_inflight_idx" ON "webhook_events" USING btree ("locked_at") WHERE "webhook_events"."status" = 'processing';--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_lock_iff_processing" CHECK (("webhook_events"."status" = 'processing') = ("webhook_events"."locked_at" IS NOT NULL));