CREATE TABLE "store_subscription" (
	"store_id" text PRIMARY KEY NOT NULL,
	"plan_code" text NOT NULL,
	"platform_plan_id" text,
	"status" text NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_subscription_status_valid" CHECK ("store_subscription"."status" IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
	CONSTRAINT "store_subscription_period_ordered" CHECK ("store_subscription"."current_period_end" > "store_subscription"."current_period_start")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ingestion_source" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_subscription" ADD CONSTRAINT "store_subscription_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_subscription_reconcile_idx" ON "store_subscription" USING btree ("last_reconciled_at");--> statement-breakpoint
CREATE INDEX "store_subscription_status_idx" ON "store_subscription" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_metering_idx" ON "orders" USING btree ("store_id","placed_at") WHERE "orders"."ingestion_source" = 'live';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_ingestion_source_valid" CHECK ("orders"."ingestion_source" IN ('live', 'backfill'));