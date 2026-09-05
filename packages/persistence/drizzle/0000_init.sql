CREATE TABLE "backfill_cursors" (
	"store_id" text NOT NULL,
	"resource" text NOT NULL,
	"cursor" text,
	"range_from" timestamp with time zone,
	"range_to" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"items_fetched" integer DEFAULT 0 NOT NULL,
	"last_advanced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backfill_cursors_store_id_resource_pk" PRIMARY KEY("store_id","resource"),
	CONSTRAINT "backfill_cursors_resource_valid" CHECK ("backfill_cursors"."resource" IN ('orders', 'products')),
	CONSTRAINT "backfill_cursors_status_valid" CHECK ("backfill_cursors"."status" IN ('running', 'paused', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "cod_fee_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"fee_rule_set_id" text NOT NULL,
	"carrier" text,
	"percent_bps" integer NOT NULL,
	"fixed_minor" numeric(14, 2) NOT NULL,
	"min_fee_minor" numeric(14, 2),
	"max_fee_minor" numeric(14, 2),
	"fee_vat_bps" integer NOT NULL,
	"rates_include_vat" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cod_fee_rules_key_unique" UNIQUE NULLS NOT DISTINCT("fee_rule_set_id","carrier"),
	CONSTRAINT "cod_fee_rules_percent_bps_positive" CHECK ("cod_fee_rules"."percent_bps" >= 0),
	CONSTRAINT "cod_fee_rules_fixed_positive" CHECK ("cod_fee_rules"."fixed_minor" >= 0),
	CONSTRAINT "cod_fee_rules_fee_vat_range" CHECK ("cod_fee_rules"."fee_vat_bps" >= 0 AND "cod_fee_rules"."fee_vat_bps" <= 10000),
	CONSTRAINT "cod_fee_rules_bounds_ordered" CHECK ("cod_fee_rules"."min_fee_minor" IS NULL OR "cod_fee_rules"."max_fee_minor" IS NULL OR "cod_fee_rules"."min_fee_minor" <= "cod_fee_rules"."max_fee_minor"),
	CONSTRAINT "cod_fee_rules_source_valid" CHECK ("cod_fee_rules"."source" IN ('merchant_entered', 'gateway_statement', 'default_table'))
);
--> statement-breakpoint
CREATE TABLE "cost_history" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"platform_product_id" text NOT NULL,
	"platform_variant_id" text,
	"sku" text,
	"unit_cost_minor" numeric(14, 2) NOT NULL,
	"source" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"supersedes_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_history_source_valid" CHECK ("cost_history"."source" IN ('merchant_manual', 'merchant_bulk_import', 'platform', 'category_default', 'none')),
	CONSTRAINT "cost_history_cost_positive" CHECK ("cost_history"."unit_cost_minor" >= 0),
	CONSTRAINT "cost_history_window_ordered" CHECK ("cost_history"."effective_to" IS NULL OR "cost_history"."effective_to" > "cost_history"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "daily_store_rollup" (
	"store_id" text NOT NULL,
	"business_date" date NOT NULL,
	"orders_count" integer DEFAULT 0 NOT NULL,
	"cost_only_count" integer DEFAULT 0 NOT NULL,
	"incomplete_count" integer DEFAULT 0 NOT NULL,
	"revenue_ex_vat_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cogs_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"outbound_shipping_cost_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"return_shipping_cost_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"gateway_fee_cost_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cod_cost_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"reversal_impact_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"contribution_margin_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cost_covered_revenue_ex_vat_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"dirty" boolean DEFAULT true NOT NULL,
	"dirtied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"computed_at" timestamp with time zone,
	"calc_version" integer,
	CONSTRAINT "daily_store_rollup_store_id_business_date_pk" PRIMARY KEY("store_id","business_date")
);
--> statement-breakpoint
CREATE TABLE "daily_variant_rollup" (
	"store_id" text NOT NULL,
	"business_date" date NOT NULL,
	"platform_product_id" text NOT NULL,
	"platform_variant_id" text DEFAULT '' NOT NULL,
	"sku" text,
	"units_sold" integer DEFAULT 0 NOT NULL,
	"units_reversed" integer DEFAULT 0 NOT NULL,
	"net_revenue_ex_vat_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cogs_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"allocated_shipping_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"allocated_gateway_fee_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"allocated_cod_cost_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"reversal_impact_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"contribution_margin_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cost_covered_revenue_ex_vat_minor" numeric(14, 2) DEFAULT '0' NOT NULL,
	"incomplete_lines" integer DEFAULT 0 NOT NULL,
	"dirty" boolean DEFAULT true NOT NULL,
	"dirtied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"computed_at" timestamp with time zone,
	"calc_version" integer,
	CONSTRAINT "daily_variant_rollup_store_id_business_date_platform_product_id_platform_variant_id_pk" PRIMARY KEY("store_id","business_date","platform_product_id","platform_variant_id")
);
--> statement-breakpoint
CREATE TABLE "fee_rule_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"currency" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_rule_sets_currency_valid" CHECK ("fee_rule_sets"."currency" IN ('SAR', 'AED', 'KWD', 'BHD', 'USD')),
	CONSTRAINT "fee_rule_sets_window_ordered" CHECK ("fee_rule_sets"."effective_to" IS NULL OR "fee_rule_sets"."effective_to" > "fee_rule_sets"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "gateway_fee_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"fee_rule_set_id" text NOT NULL,
	"instrument" text,
	"scheme" text,
	"provider" text,
	"percent_bps" integer NOT NULL,
	"fixed_minor" numeric(14, 2) NOT NULL,
	"min_fee_minor" numeric(14, 2),
	"max_fee_minor" numeric(14, 2),
	"fee_vat_bps" integer NOT NULL,
	"rates_include_vat" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_fee_rules_key_unique" UNIQUE NULLS NOT DISTINCT("fee_rule_set_id","instrument","scheme","provider"),
	CONSTRAINT "gateway_fee_rules_instrument_valid" CHECK ("gateway_fee_rules"."instrument" IS NULL OR "gateway_fee_rules"."instrument" IN ('card', 'bnpl', 'wallet', 'cod', 'bank_transfer', 'free', 'unknown', 'other')),
	CONSTRAINT "gateway_fee_rules_scheme_valid" CHECK ("gateway_fee_rules"."scheme" IS NULL OR "gateway_fee_rules"."scheme" IN ('mada', 'visa', 'mastercard', 'amex', 'unionpay', 'other', 'unknown')),
	CONSTRAINT "gateway_fee_rules_percent_bps_positive" CHECK ("gateway_fee_rules"."percent_bps" >= 0),
	CONSTRAINT "gateway_fee_rules_fixed_positive" CHECK ("gateway_fee_rules"."fixed_minor" >= 0),
	CONSTRAINT "gateway_fee_rules_fee_vat_range" CHECK ("gateway_fee_rules"."fee_vat_bps" >= 0 AND "gateway_fee_rules"."fee_vat_bps" <= 10000),
	CONSTRAINT "gateway_fee_rules_bounds_ordered" CHECK ("gateway_fee_rules"."min_fee_minor" IS NULL OR "gateway_fee_rules"."max_fee_minor" IS NULL OR "gateway_fee_rules"."min_fee_minor" <= "gateway_fee_rules"."max_fee_minor"),
	CONSTRAINT "gateway_fee_rules_source_valid" CHECK ("gateway_fee_rules"."source" IN ('merchant_entered', 'gateway_statement', 'default_table'))
);
--> statement-breakpoint
CREATE TABLE "order_discounts" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"discount_index" integer NOT NULL,
	"code" text,
	"target" text NOT NULL,
	"reflected_in_component" boolean NOT NULL,
	"amount_ex_vat_minor" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_discounts_order_index_unique" UNIQUE("order_id","discount_index"),
	CONSTRAINT "order_discounts_target_valid" CHECK ("order_discounts"."target" IN ('items', 'shipping', 'cod_fee')),
	CONSTRAINT "order_discounts_amount_positive" CHECK ("order_discounts"."amount_ex_vat_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"store_id" text NOT NULL,
	"platform_line_id" text NOT NULL,
	"platform_product_id" text NOT NULL,
	"platform_variant_id" text,
	"sku" text,
	"product_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_ex_vat_minor" numeric(14, 2) NOT NULL,
	"gross_line_ex_vat_minor" numeric(14, 2) NOT NULL,
	"line_discount_ex_vat_minor" numeric(14, 2) NOT NULL,
	"line_total_ex_vat_minor" numeric(14, 2) NOT NULL,
	"cost_at_time_minor" numeric(14, 2),
	"cost_source" text DEFAULT 'none' NOT NULL,
	"cost_history_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_order_line_unique" UNIQUE("order_id","platform_line_id"),
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" >= 0),
	CONSTRAINT "order_items_cost_source_valid" CHECK ("order_items"."cost_source" IN ('merchant_manual', 'merchant_bulk_import', 'platform', 'category_default', 'none')),
	CONSTRAINT "order_items_line_total_consistent" CHECK ("order_items"."line_total_ex_vat_minor" = "order_items"."gross_line_ex_vat_minor" - "order_items"."line_discount_ex_vat_minor")
);
--> statement-breakpoint
CREATE TABLE "order_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"leg_index" integer NOT NULL,
	"instrument" text NOT NULL,
	"scheme" text,
	"wallet" text,
	"provider" text,
	"raw_method_label" text NOT NULL,
	"state" text NOT NULL,
	"amount_gross_minor" numeric(14, 2) NOT NULL,
	"transaction_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_payments_order_leg_unique" UNIQUE("order_id","leg_index"),
	CONSTRAINT "order_payments_instrument_valid" CHECK ("order_payments"."instrument" IN ('card', 'bnpl', 'wallet', 'cod', 'bank_transfer', 'free', 'unknown', 'other')),
	CONSTRAINT "order_payments_state_valid" CHECK ("order_payments"."state" IN ('pending', 'authorized', 'captured', 'failed', 'refunded')),
	CONSTRAINT "order_payments_scheme_iff_card" CHECK (("order_payments"."instrument" = 'card') = ("order_payments"."scheme" IS NOT NULL)),
	CONSTRAINT "order_payments_scheme_valid" CHECK ("order_payments"."scheme" IS NULL OR "order_payments"."scheme" IN ('mada', 'visa', 'mastercard', 'amex', 'unionpay', 'other', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "order_profit" (
	"order_id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"calc_version" integer NOT NULL,
	"fee_rule_set_id" text,
	"currency" text NOT NULL,
	"business_date" date NOT NULL,
	"status" text NOT NULL,
	"recognition_kind" text NOT NULL,
	"recognition_reason" text,
	"items_revenue_ex_vat_minor" numeric(14, 2),
	"shipping_revenue_ex_vat_minor" numeric(14, 2),
	"cod_fee_revenue_ex_vat_minor" numeric(14, 2),
	"order_discount_ex_vat_minor" numeric(14, 2),
	"revenue_ex_vat_minor" numeric(14, 2),
	"vat_collected_minor" numeric(14, 2),
	"cogs_minor" numeric(14, 2),
	"outbound_shipping_cost_minor" numeric(14, 2),
	"return_shipping_cost_minor" numeric(14, 2),
	"gateway_fee_ex_vat_minor" numeric(14, 2),
	"gateway_fee_vat_minor" numeric(14, 2),
	"gateway_fee_cost_minor" numeric(14, 2),
	"cod_cost_ex_vat_minor" numeric(14, 2),
	"cod_cost_vat_minor" numeric(14, 2),
	"cod_cost_minor" numeric(14, 2),
	"reversed_revenue_ex_vat_minor" numeric(14, 2),
	"restocked_cogs_minor" numeric(14, 2),
	"reversal_impact_minor" numeric(14, 2),
	"contribution_margin_minor" numeric(14, 2),
	"margin_bps" integer,
	"cost_covered_revenue_ex_vat_minor" numeric(14, 2),
	"confidence" jsonb,
	"diagnostics" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_profit_status_valid" CHECK ("order_profit"."status" IN ('computed', 'rejected')),
	CONSTRAINT "order_profit_recognition_valid" CHECK ("order_profit"."recognition_kind" IN ('recognized', 'cost_only', 'excluded')),
	CONSTRAINT "order_profit_totals_iff_computed" CHECK (("order_profit"."status" = 'computed') = ("order_profit"."contribution_margin_minor" IS NOT NULL)),
	CONSTRAINT "order_profit_restock_bounded" CHECK ("order_profit"."restocked_cogs_minor" IS NULL OR "order_profit"."restocked_cogs_minor" <= "order_profit"."cogs_minor")
);
--> statement-breakpoint
CREATE TABLE "order_profit_lines" (
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"store_id" text NOT NULL,
	"business_date" date NOT NULL,
	"platform_product_id" text NOT NULL,
	"platform_variant_id" text,
	"sku" text,
	"quantity" integer NOT NULL,
	"allocated_order_discount_ex_vat_minor" numeric(14, 2) NOT NULL,
	"net_revenue_ex_vat_minor" numeric(14, 2) NOT NULL,
	"allocated_shipping_revenue_ex_vat_minor" numeric(14, 2) NOT NULL,
	"allocated_cod_fee_revenue_ex_vat_minor" numeric(14, 2) NOT NULL,
	"unit_cost_minor" numeric(14, 2) NOT NULL,
	"cogs_minor" numeric(14, 2) NOT NULL,
	"cost_source" text NOT NULL,
	"cost_history_id" text,
	"allocated_outbound_shipping_minor" numeric(14, 2) NOT NULL,
	"allocated_return_shipping_minor" numeric(14, 2) NOT NULL,
	"allocated_gateway_fee_minor" numeric(14, 2) NOT NULL,
	"allocated_cod_cost_minor" numeric(14, 2) NOT NULL,
	"reversed_quantity" integer NOT NULL,
	"reversed_revenue_ex_vat_minor" numeric(14, 2) NOT NULL,
	"restocked_cogs_minor" numeric(14, 2) NOT NULL,
	"reversal_impact_minor" numeric(14, 2) NOT NULL,
	"contribution_margin_minor" numeric(14, 2) NOT NULL,
	"cost_covered_revenue_ex_vat_minor" numeric(14, 2) NOT NULL,
	"calc_version" integer NOT NULL,
	CONSTRAINT "order_profit_lines_order_id_order_item_id_pk" PRIMARY KEY("order_id","order_item_id"),
	CONSTRAINT "order_profit_lines_cost_source_valid" CHECK ("order_profit_lines"."cost_source" IN ('merchant_manual', 'merchant_bulk_import', 'platform', 'category_default', 'none')),
	CONSTRAINT "order_profit_lines_quantity_positive" CHECK ("order_profit_lines"."quantity" >= 0),
	CONSTRAINT "order_profit_lines_restock_bounded" CHECK ("order_profit_lines"."restocked_cogs_minor" <= "order_profit_lines"."cogs_minor"),
	CONSTRAINT "order_profit_lines_margin_consistent" CHECK ("order_profit_lines"."contribution_margin_minor" = "order_profit_lines"."net_revenue_ex_vat_minor" + "order_profit_lines"."allocated_shipping_revenue_ex_vat_minor" + "order_profit_lines"."allocated_cod_fee_revenue_ex_vat_minor" - "order_profit_lines"."cogs_minor" - "order_profit_lines"."allocated_outbound_shipping_minor" - "order_profit_lines"."allocated_return_shipping_minor" - "order_profit_lines"."allocated_gateway_fee_minor" - "order_profit_lines"."allocated_cod_cost_minor" + "order_profit_lines"."reversal_impact_minor")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"platform_order_id" text NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"platform_updated_at" timestamp with time zone,
	"lifecycle" text NOT NULL,
	"payment_state" text NOT NULL,
	"fulfillment_state" text NOT NULL,
	"platform_status_id" text,
	"raw_status_label" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"fulfillment_method" text NOT NULL,
	"destination_country_code" text,
	"destination_region" text,
	"destination_city" text,
	"currency" text NOT NULL,
	"vat_rate_bps" integer NOT NULL,
	"subtotal_ex_vat_minor" numeric(14, 2) NOT NULL,
	"vat_amount_minor" numeric(14, 2) NOT NULL,
	"shipping_charged_ex_vat_minor" numeric(14, 2) NOT NULL,
	"cod_fee_charged_ex_vat_minor" numeric(14, 2) NOT NULL,
	"total_inc_vat_minor" numeric(14, 2) NOT NULL,
	"customer_ref" text,
	"attribution_device" text,
	"attribution_referrer_host" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_store_platform_order_unique" UNIQUE("store_id","platform_order_id"),
	CONSTRAINT "orders_currency_valid" CHECK ("orders"."currency" IN ('SAR', 'AED', 'KWD', 'BHD', 'USD')),
	CONSTRAINT "orders_lifecycle_valid" CHECK ("orders"."lifecycle" IN ('draft', 'open', 'completed', 'cancelled')),
	CONSTRAINT "orders_payment_state_valid" CHECK ("orders"."payment_state" IN ('unpaid', 'authorized', 'paid', 'partially_refunded', 'refunded', 'voided', 'failed')),
	CONSTRAINT "orders_fulfillment_state_valid" CHECK ("orders"."fulfillment_state" IN ('unfulfilled', 'partially_fulfilled', 'in_transit', 'delivered', 'returned', 'rto', 'not_applicable')),
	CONSTRAINT "orders_fulfillment_method_valid" CHECK ("orders"."fulfillment_method" IN ('carrier', 'pickup', 'self_delivery', 'digital', 'other')),
	CONSTRAINT "orders_device_valid" CHECK ("orders"."attribution_device" IS NULL OR "orders"."attribution_device" IN ('desktop', 'mobile', 'tablet', 'unknown')),
	CONSTRAINT "orders_vat_rate_range" CHECK ("orders"."vat_rate_bps" >= 0 AND "orders"."vat_rate_bps" <= 10000),
	CONSTRAINT "orders_referrer_is_host_only" CHECK ("orders"."attribution_referrer_host" IS NULL OR "orders"."attribution_referrer_host" NOT LIKE '%/%')
);
--> statement-breakpoint
CREATE TABLE "platform_credentials" (
	"store_id" text PRIMARY KEY NOT NULL,
	"secrets_encrypted" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"refresh_expires_at" timestamp with time zone,
	"reauth_required_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"store_id" text NOT NULL,
	"platform_product_id" text NOT NULL,
	"sku" text,
	"product_name" text NOT NULL,
	"platform_cost_minor" numeric(14, 2),
	"list_price_ex_vat_minor" numeric(14, 2),
	"active" boolean DEFAULT true NOT NULL,
	"platform_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_store_id_platform_product_id_pk" PRIMARY KEY("store_id","platform_product_id")
);
--> statement-breakpoint
CREATE TABLE "reversal_lines" (
	"reversal_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"amount_ex_vat_minor" numeric(14, 2) NOT NULL,
	"restock_outcome" text NOT NULL,
	CONSTRAINT "reversal_lines_reversal_id_order_item_id_pk" PRIMARY KEY("reversal_id","order_item_id"),
	CONSTRAINT "reversal_lines_quantity_positive" CHECK ("reversal_lines"."quantity" >= 0),
	CONSTRAINT "reversal_lines_restock_valid" CHECK ("reversal_lines"."restock_outcome" IN ('restocked_sellable', 'restocked_damaged', 'not_restocked', 'pending_receipt', 'not_applicable', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "reversals" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"store_id" text NOT NULL,
	"platform_reversal_id" text,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"raw_reason_label" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"amount_ex_vat_minor" numeric(14, 2) NOT NULL,
	"shipping_refund_ex_vat_minor" numeric(14, 2) NOT NULL,
	"cod_fee_refund_ex_vat_minor" numeric(14, 2) NOT NULL,
	"adjustment_ex_vat_minor" numeric(14, 2) NOT NULL,
	"vat_minor" numeric(14, 2) NOT NULL,
	"total_inc_vat_minor" numeric(14, 2) NOT NULL,
	"restock_outcome" text NOT NULL,
	"has_line_detail" boolean NOT NULL,
	"platform_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reversals_kind_valid" CHECK ("reversals"."kind" IN ('refund', 'void', 'chargeback')),
	CONSTRAINT "reversals_reason_valid" CHECK ("reversals"."reason" IN ('customer_return', 'damaged_or_defective', 'wrong_item', 'cancelled_before_dispatch', 'goodwill_or_price_adjustment', 'chargeback', 'other', 'unknown')),
	CONSTRAINT "reversals_restock_valid" CHECK ("reversals"."restock_outcome" IN ('restocked_sellable', 'restocked_damaged', 'not_restocked', 'pending_receipt', 'not_applicable', 'unknown')),
	CONSTRAINT "reversals_total_consistent" CHECK ("reversals"."total_inc_vat_minor" = "reversals"."amount_ex_vat_minor" + "reversals"."shipping_refund_ex_vat_minor" + "reversals"."cod_fee_refund_ex_vat_minor" + "reversals"."adjustment_ex_vat_minor" + "reversals"."vat_minor")
);
--> statement-breakpoint
CREATE TABLE "shipment_lines" (
	"shipment_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "shipment_lines_shipment_id_order_item_id_pk" PRIMARY KEY("shipment_id","order_item_id"),
	CONSTRAINT "shipment_lines_quantity_positive" CHECK ("shipment_lines"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"store_id" text NOT NULL,
	"platform_shipment_id" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"carrier" text NOT NULL,
	"raw_carrier_label" text NOT NULL,
	"carrier_cost_minor" numeric(14, 2),
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"platform_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_store_platform_shipment_unique" UNIQUE("store_id","platform_shipment_id"),
	CONSTRAINT "shipments_direction_valid" CHECK ("shipments"."direction" IN ('outbound', 'return')),
	CONSTRAINT "shipments_status_valid" CHECK ("shipments"."status" IN ('created', 'in_transit', 'out_for_delivery', 'delivered', 'failed_attempt', 'returned_to_origin', 'cancelled', 'lost', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "shipping_fallback_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"fee_rule_set_id" text NOT NULL,
	"country_code" text,
	"region" text,
	"carrier" text,
	"direction" text DEFAULT 'any' NOT NULL,
	"cost_minor" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_fallback_rules_key_unique" UNIQUE NULLS NOT DISTINCT("fee_rule_set_id","country_code","region","carrier","direction"),
	CONSTRAINT "shipping_fallback_rules_cost_positive" CHECK ("shipping_fallback_rules"."cost_minor" >= 0),
	CONSTRAINT "shipping_fallback_rules_direction_valid" CHECK ("shipping_fallback_rules"."direction" IN ('outbound', 'return', 'any'))
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"platform_store_id" text NOT NULL,
	"currency" text NOT NULL,
	"timezone" text NOT NULL,
	"vat_rate_bps" integer NOT NULL,
	"vat_registered" boolean NOT NULL,
	"installed_at" timestamp with time zone NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_platform_store_unique" UNIQUE("platform","platform_store_id"),
	CONSTRAINT "stores_currency_valid" CHECK ("stores"."currency" IN ('SAR', 'AED', 'KWD', 'BHD', 'USD')),
	CONSTRAINT "stores_vat_rate_range" CHECK ("stores"."vat_rate_bps" >= 0 AND "stores"."vat_rate_bps" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"store_id" text NOT NULL,
	"platform_product_id" text NOT NULL,
	"platform_variant_id" text NOT NULL,
	"sku" text,
	"variant_name" text NOT NULL,
	"platform_cost_minor" numeric(14, 2),
	"list_price_ex_vat_minor" numeric(14, 2),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_store_id_platform_product_id_platform_variant_id_pk" PRIMARY KEY("store_id","platform_product_id","platform_variant_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"platform_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"raw_event_type" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_store_event_unique" UNIQUE("store_id","platform_event_id"),
	CONSTRAINT "webhook_events_attempts_positive" CHECK ("webhook_events"."attempts" >= 0),
	CONSTRAINT "webhook_events_status_valid" CHECK ("webhook_events"."status" IN ('pending', 'processing', 'processed', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "backfill_cursors" ADD CONSTRAINT "backfill_cursors_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cod_fee_rules" ADD CONSTRAINT "cod_fee_rules_fee_rule_set_id_fee_rule_sets_id_fk" FOREIGN KEY ("fee_rule_set_id") REFERENCES "public"."fee_rule_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_history" ADD CONSTRAINT "cost_history_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_store_rollup" ADD CONSTRAINT "daily_store_rollup_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_variant_rollup" ADD CONSTRAINT "daily_variant_rollup_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_rule_sets" ADD CONSTRAINT "fee_rule_sets_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_fee_rules" ADD CONSTRAINT "gateway_fee_rules_fee_rule_set_id_fee_rule_sets_id_fk" FOREIGN KEY ("fee_rule_set_id") REFERENCES "public"."fee_rule_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_cost_history_id_cost_history_id_fk" FOREIGN KEY ("cost_history_id") REFERENCES "public"."cost_history"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_profit" ADD CONSTRAINT "order_profit_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_profit" ADD CONSTRAINT "order_profit_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_profit" ADD CONSTRAINT "order_profit_fee_rule_set_id_fee_rule_sets_id_fk" FOREIGN KEY ("fee_rule_set_id") REFERENCES "public"."fee_rule_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_profit_lines" ADD CONSTRAINT "order_profit_lines_order_id_order_profit_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."order_profit"("order_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_profit_lines" ADD CONSTRAINT "order_profit_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reversal_lines" ADD CONSTRAINT "reversal_lines_reversal_id_reversals_id_fk" FOREIGN KEY ("reversal_id") REFERENCES "public"."reversals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reversal_lines" ADD CONSTRAINT "reversal_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reversals" ADD CONSTRAINT "reversals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reversals" ADD CONSTRAINT "reversals_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_fallback_rules" ADD CONSTRAINT "shipping_fallback_rules_fee_rule_set_id_fee_rule_sets_id_fk" FOREIGN KEY ("fee_rule_set_id") REFERENCES "public"."fee_rule_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cod_fee_rules_set_idx" ON "cod_fee_rules" USING btree ("fee_rule_set_id");--> statement-breakpoint
CREATE INDEX "cost_history_asof_idx" ON "cost_history" USING btree ("store_id","platform_product_id","platform_variant_id","effective_from");--> statement-breakpoint
CREATE INDEX "cost_history_open_idx" ON "cost_history" USING btree ("store_id","platform_product_id","platform_variant_id") WHERE "cost_history"."effective_to" IS NULL;--> statement-breakpoint
CREATE INDEX "cost_history_sku_idx" ON "cost_history" USING btree ("store_id","sku");--> statement-breakpoint
CREATE INDEX "daily_store_rollup_dirty_idx" ON "daily_store_rollup" USING btree ("dirtied_at") WHERE "daily_store_rollup"."dirty";--> statement-breakpoint
CREATE INDEX "daily_variant_rollup_dirty_idx" ON "daily_variant_rollup" USING btree ("dirtied_at") WHERE "daily_variant_rollup"."dirty";--> statement-breakpoint
CREATE INDEX "daily_variant_rollup_margin_idx" ON "daily_variant_rollup" USING btree ("store_id","business_date","contribution_margin_minor");--> statement-breakpoint
CREATE INDEX "fee_rule_sets_asof_idx" ON "fee_rule_sets" USING btree ("store_id","effective_from");--> statement-breakpoint
CREATE INDEX "gateway_fee_rules_set_idx" ON "gateway_fee_rules" USING btree ("fee_rule_set_id");--> statement-breakpoint
CREATE INDEX "order_discounts_order_idx" ON "order_discounts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_product_idx" ON "order_items" USING btree ("store_id","platform_product_id","platform_variant_id");--> statement-breakpoint
CREATE INDEX "order_items_sku_idx" ON "order_items" USING btree ("store_id","sku");--> statement-breakpoint
CREATE INDEX "order_payments_order_idx" ON "order_payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_payments_transaction_ref_idx" ON "order_payments" USING btree ("transaction_ref");--> statement-breakpoint
CREATE INDEX "order_profit_store_date_idx" ON "order_profit" USING btree ("store_id","business_date");--> statement-breakpoint
CREATE INDEX "order_profit_calc_version_idx" ON "order_profit" USING btree ("store_id","calc_version");--> statement-breakpoint
CREATE INDEX "order_profit_fee_rule_set_idx" ON "order_profit" USING btree ("fee_rule_set_id");--> statement-breakpoint
CREATE INDEX "order_profit_margin_idx" ON "order_profit" USING btree ("store_id","contribution_margin_minor");--> statement-breakpoint
CREATE INDEX "order_profit_lines_product_date_idx" ON "order_profit_lines" USING btree ("store_id","platform_product_id","platform_variant_id","business_date");--> statement-breakpoint
CREATE INDEX "order_profit_lines_store_date_idx" ON "order_profit_lines" USING btree ("store_id","business_date");--> statement-breakpoint
CREATE INDEX "orders_store_placed_idx" ON "orders" USING btree ("store_id","placed_at");--> statement-breakpoint
CREATE INDEX "orders_store_updated_idx" ON "orders" USING btree ("store_id","platform_updated_at");--> statement-breakpoint
CREATE INDEX "orders_customer_ref_idx" ON "orders" USING btree ("store_id","customer_ref");--> statement-breakpoint
CREATE INDEX "platform_credentials_expires_idx" ON "platform_credentials" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "products_store_sku_idx" ON "products" USING btree ("store_id","sku");--> statement-breakpoint
CREATE INDEX "products_store_active_idx" ON "products" USING btree ("store_id","active");--> statement-breakpoint
CREATE INDEX "reversal_lines_order_item_idx" ON "reversal_lines" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "reversals_order_idx" ON "reversals" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "reversals_store_occurred_idx" ON "reversals" USING btree ("store_id","occurred_at");--> statement-breakpoint
CREATE INDEX "shipment_lines_order_item_idx" ON "shipment_lines" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shipments_store_status_idx" ON "shipments" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "shipping_fallback_rules_set_idx" ON "shipping_fallback_rules" USING btree ("fee_rule_set_id");--> statement-breakpoint
CREATE INDEX "stores_platform_idx" ON "stores" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "variants_store_sku_idx" ON "variants" USING btree ("store_id","sku");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_store_received_idx" ON "webhook_events" USING btree ("store_id","received_at");