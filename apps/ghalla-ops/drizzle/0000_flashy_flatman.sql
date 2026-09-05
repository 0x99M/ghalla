CREATE TABLE "admin_action_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_session" text NOT NULL,
	"platform" text NOT NULL,
	"store_id" text,
	"action" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text DEFAULT 'dispatched' NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "admin_action_log_status_valid" CHECK ("admin_action_log"."status" IN ('dispatched', 'succeeded', 'failed')),
	CONSTRAINT "admin_action_log_completed_iff_settled" CHECK (("admin_action_log"."status" = 'dispatched') = ("admin_action_log"."completed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "alert_ack" (
	"alert_key" text PRIMARY KEY NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_session" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "platform_snapshot" (
	"platform" text NOT NULL,
	"captured_hour" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"active_stores" integer,
	"trialing_stores" integer,
	"past_due_stores" integer,
	"canceled_stores" integer,
	"expired_stores" integer,
	"list_mrr_minor" numeric(14, 2),
	"unknown_plan_subscriptions" integer,
	"orders_ingested_live_24h" integer,
	"webhooks_processed_24h" integer,
	"webhooks_failed_24h" integer,
	"queue_depth" integer,
	"queue_stalled" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_snapshot_platform_captured_hour_pk" PRIMARY KEY("platform","captured_hour"),
	CONSTRAINT "platform_snapshot_status_valid" CHECK ("platform_snapshot"."status" IN ('ok', 'unreachable')),
	CONSTRAINT "platform_snapshot_hour_aligned" CHECK ("platform_snapshot"."captured_hour" = date_trunc('hour', "platform_snapshot"."captured_hour" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
	CONSTRAINT "platform_snapshot_metrics_iff_ok" CHECK (("platform_snapshot"."status" = 'ok') = ("platform_snapshot"."active_stores" IS NOT NULL)),
	CONSTRAINT "platform_snapshot_error_iff_unreachable" CHECK (("platform_snapshot"."status" = 'unreachable') = ("platform_snapshot"."error" IS NOT NULL)),
	CONSTRAINT "platform_snapshot_counts_positive" CHECK (("platform_snapshot"."active_stores" IS NULL OR "platform_snapshot"."active_stores" >= 0) AND ("platform_snapshot"."trialing_stores" IS NULL OR "platform_snapshot"."trialing_stores" >= 0) AND ("platform_snapshot"."past_due_stores" IS NULL OR "platform_snapshot"."past_due_stores" >= 0) AND ("platform_snapshot"."canceled_stores" IS NULL OR "platform_snapshot"."canceled_stores" >= 0) AND ("platform_snapshot"."expired_stores" IS NULL OR "platform_snapshot"."expired_stores" >= 0) AND ("platform_snapshot"."unknown_plan_subscriptions" IS NULL OR "platform_snapshot"."unknown_plan_subscriptions" >= 0) AND ("platform_snapshot"."orders_ingested_live_24h" IS NULL OR "platform_snapshot"."orders_ingested_live_24h" >= 0) AND ("platform_snapshot"."webhooks_processed_24h" IS NULL OR "platform_snapshot"."webhooks_processed_24h" >= 0) AND ("platform_snapshot"."webhooks_failed_24h" IS NULL OR "platform_snapshot"."webhooks_failed_24h" >= 0) AND ("platform_snapshot"."queue_depth" IS NULL OR "platform_snapshot"."queue_depth" >= 0) AND ("platform_snapshot"."queue_stalled" IS NULL OR "platform_snapshot"."queue_stalled" >= 0))
);
--> statement-breakpoint
CREATE TABLE "store_snapshot" (
	"platform" text NOT NULL,
	"store_id" text NOT NULL,
	"captured_date" date NOT NULL,
	"plan_code" text NOT NULL,
	"status" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"orders_in_period" integer,
	"coverage_revenue_ex_vat_minor" numeric(14, 2),
	"coverage_covered_revenue_ex_vat_minor" numeric(14, 2),
	"last_webhook_at" timestamp with time zone,
	"backfill_orders_status" text,
	"backfill_orders_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_snapshot_platform_store_id_captured_date_pk" PRIMARY KEY("platform","store_id","captured_date"),
	CONSTRAINT "store_snapshot_orders_positive" CHECK (("store_snapshot"."orders_in_period" IS NULL OR "store_snapshot"."orders_in_period" >= 0)),
	CONSTRAINT "store_snapshot_coverage_bounded" CHECK ("store_snapshot"."coverage_covered_revenue_ex_vat_minor" IS NULL
          OR "store_snapshot"."coverage_revenue_ex_vat_minor" IS NULL
          OR "store_snapshot"."coverage_covered_revenue_ex_vat_minor" <= "store_snapshot"."coverage_revenue_ex_vat_minor")
);
--> statement-breakpoint
CREATE INDEX "admin_action_log_created_idx" ON "admin_action_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_action_log_store_idx" ON "admin_action_log" USING btree ("platform","store_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_action_log_open_idx" ON "admin_action_log" USING btree ("created_at") WHERE "admin_action_log"."status" = 'dispatched';--> statement-breakpoint
CREATE INDEX "alert_ack_acknowledged_idx" ON "alert_ack" USING btree ("acknowledged_at");--> statement-breakpoint
CREATE INDEX "platform_snapshot_recent_idx" ON "platform_snapshot" USING btree ("captured_hour");--> statement-breakpoint
CREATE INDEX "store_snapshot_date_idx" ON "store_snapshot" USING btree ("captured_date");--> statement-breakpoint
CREATE INDEX "store_snapshot_store_idx" ON "store_snapshot" USING btree ("platform","store_id","captured_date");