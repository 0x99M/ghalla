-- ghalla_ops_ro — the read-only role the operator portal connects as.
--
-- Run this against EVERY integration database, as that database's owner:
--
--   psql "$DATABASE_URL" \
--     -v ON_ERROR_STOP=1 \
--     -v ops_password="$(openssl rand -base64 24)" \
--     -f apps/ghalla-ops/sql/ghalla_ops_ro.sql
--
-- Idempotent: safe to re-run after a migration adds a table or a column. It
-- MUST be re-run then — see the note on default privileges at the bottom.
--
-- The portal's promise is that it cannot write to an integration database. A
-- promise enforced by discipline is not enforced; this file is where it becomes
-- true. The application also probes for it at startup and refuses to read a
-- connection that comes back writable, so a database this script was never run
-- against fails loudly rather than quietly working.

\if :{?ops_password}
\else
  \echo 'ERROR: pass the password with  -v ops_password=...'
  \quit
\endif

\set ON_ERROR_STOP on

BEGIN;

-- ─────────────────────────────────────────────────────────────── the role ───

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ghalla_ops_ro') THEN
    CREATE ROLE ghalla_ops_ro LOGIN;
  END IF;
END
$$;

-- CONNECTION LIMIT is the blunt half of "keep the pool small". The portal is
-- one operator; the integration service is serving every merchant, and they
-- draw connections from the same server.
ALTER ROLE ghalla_ops_ro WITH LOGIN PASSWORD :'ops_password' CONNECTION LIMIT 5;

-- Belt to the GRANTs' braces. This one is a session default a client could
-- override with SET TRANSACTION READ WRITE, so it is not the guarantee — but a
-- role that also holds no INSERT has nothing to override it with.
ALTER ROLE ghalla_ops_ro SET default_transaction_read_only = on;
-- An analytical query that plans badly must not sit holding a connection the
-- service serving merchants is waiting for.
ALTER ROLE ghalla_ops_ro SET statement_timeout = '5s';
ALTER ROLE ghalla_ops_ro SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE ghalla_ops_ro SET lock_timeout = '2s';

-- ───────────────────────────────────────────────────────── start from zero ───

-- Re-runs must not accumulate grants that a later edit to this file removed.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ghalla_ops_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ghalla_ops_ro;
REVOKE ALL ON SCHEMA public FROM ghalla_ops_ro;

-- A privilege granted to PUBLIC reaches every role, including this one, and
-- would silently defeat every column list below. Postgres grants no table
-- privileges to PUBLIC by default, so this is normally a no-op — which is
-- exactly why it is cheap to assert.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ghalla_ops_ro', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO ghalla_ops_ro;

-- ──────────────────────────────────────────────────────────── what it sees ───
--
-- Column lists, not table grants. The portal has no reason to read a customer
-- reference, a delivery address, a raw webhook payload or a merchant's per-SKU
-- costs, and "no reason to" is not a boundary until the server agrees. A future
-- column is invisible until it is added here on purpose.

-- Tenancy. No secrets; this is the store's own configuration.
GRANT SELECT (
  id, platform, platform_store_id, currency, timezone,
  vat_rate_bps, vat_registered, installed_at, uninstalled_at, created_at, updated_at
) ON stores TO ghalla_ops_ro;

-- Billing state. The whole row: none of it identifies a person.
GRANT SELECT (
  store_id, plan_code, platform_plan_id, status, trial_ends_at,
  current_period_start, current_period_end, last_event_at, last_reconciled_at,
  pending_plan_code, pending_plan_effective_at, created_at, updated_at
) ON store_subscription TO ghalla_ops_ro;

-- Orders, for metering and provenance ONLY.
--
-- Excluded and deliberately so: customer_ref, destination_country_code,
-- destination_region, destination_city, attribution_device,
-- attribution_referrer_host. Those are the columns retained under PDPL for the
-- shipping fallback, and the portal is not the shipping fallback. Every money
-- column is excluded too — order economics are read from order_profit, which is
-- the computed view and already carries what the portal needs.
GRANT SELECT (
  id, store_id, placed_at, platform_updated_at, lifecycle, payment_state,
  fulfillment_state, is_test, ingestion_source, fulfillment_method, currency,
  created_at, updated_at
) ON orders TO ghalla_ops_ro;

-- Payment legs, for the unknown-payment-method queue: which raw labels an
-- adapter could not map, and how often. Amounts and the settlement join key are
-- not part of that question.
GRANT SELECT (
  order_id, instrument, scheme, wallet, provider, raw_method_label, state
) ON order_payments TO ghalla_ops_ro;

-- Computed profit. `diagnostics` is codes only by construction, and it is the
-- primary triage signal for "why is this store's coverage bad".
GRANT SELECT (
  store_id, business_date, status, recognition_kind, recognition_reason,
  currency, calc_version, revenue_ex_vat_minor, cost_covered_revenue_ex_vat_minor,
  contribution_margin_minor, margin_bps, diagnostics, computed_at
) ON order_profit TO ghalla_ops_ro;

-- Daily rollups, in full. Aggregates over a store, with nothing per-customer in
-- them, and the cheapest source for every trend the portal draws.
GRANT SELECT ON daily_store_rollup TO ghalla_ops_ro;

-- Ingestion health. `raw_payload` is EXCLUDED: it is the platform's untouched
-- body, it carries customer PII by definition, and it is the single column in
-- this schema that most needs to stay where it is.
--
-- `last_error` is granted because it is the most useful field in the table at
-- 03:00 — on the condition, which belongs to the integration service, that a
-- handler never embeds payload content in an error message.
GRANT SELECT (
  id, store_id, platform_event_id, event_type, raw_event_type, received_at,
  processed_at, status, attempts, next_attempt_at, locked_at, last_error, created_at
) ON webhook_events TO ghalla_ops_ro;

-- Backfill progress, for the stuck-backfill alert and the activation funnel.
-- `cursor` is opaque adapter state and answers no question the portal asks.
GRANT SELECT (
  store_id, resource, status, items_fetched, range_from, range_to,
  last_advanced_at, created_at, updated_at
) ON backfill_cursors TO ghalla_ops_ro;

-- Cost entry, for WHETHER costs are arriving and by what route — never for what
-- they are. unit_cost_minor, sku and the product keys are excluded: a
-- merchant's per-unit costs are the most commercially sensitive thing they give
-- us, and the portal's questions are all about coverage, which is answered by
-- order_profit.
GRANT SELECT (
  store_id, source, effective_from, effective_to, created_at
) ON cost_history TO ghalla_ops_ro;

-- ───────────────────────────────────────────────────── what it must not see ───
--
-- Redundant after the blanket REVOKE above, and stated anyway: this is the one
-- table whose exclusion is a requirement rather than a consequence. The portal
-- has no reason to hold a merchant's OAuth tokens, not even masked.
REVOKE ALL ON TABLE platform_credentials FROM ghalla_ops_ro;

-- NO `ALTER DEFAULT PRIVILEGES`, on purpose.
--
-- Default privileges would grant SELECT on every table a future migration
-- creates. That is precisely the wrong direction: a new table should be
-- invisible to the portal until somebody decides it may be seen, so that a
-- table added later holding something sensitive is not readable by default.
-- The cost is that this file has to be re-run after a migration adds something
-- the portal needs — which is a deploy step, not an accident.

-- ────────────────────────────────────────────────────── prove it took hold ───
--
-- The script asserts its own outcome, and these are the same two questions the
-- application's startup probe asks. If either fails here, the portal would have
-- refused to read this database anyway.
DO $$
BEGIN
  IF has_table_privilege('ghalla_ops_ro', 'orders', 'INSERT') THEN
    RAISE EXCEPTION 'ghalla_ops_ro can INSERT into orders — the read-only boundary is not in place';
  END IF;
  IF has_table_privilege('ghalla_ops_ro', 'orders', 'UPDATE')
     OR has_table_privilege('ghalla_ops_ro', 'orders', 'DELETE') THEN
    RAISE EXCEPTION 'ghalla_ops_ro can modify orders — the read-only boundary is not in place';
  END IF;
  IF has_table_privilege('ghalla_ops_ro', 'platform_credentials', 'SELECT') THEN
    RAISE EXCEPTION 'ghalla_ops_ro can read platform_credentials — revoke it';
  END IF;
  IF has_column_privilege('ghalla_ops_ro', 'webhook_events', 'raw_payload', 'SELECT') THEN
    RAISE EXCEPTION 'ghalla_ops_ro can read webhook_events.raw_payload — that column carries customer PII';
  END IF;
  IF has_column_privilege('ghalla_ops_ro', 'orders', 'customer_ref', 'SELECT') THEN
    RAISE EXCEPTION 'ghalla_ops_ro can read orders.customer_ref';
  END IF;
END
$$;

COMMIT;

-- What the role ended up with, for the record.
SELECT table_name, string_agg(column_name, ', ' ORDER BY column_name) AS columns
FROM information_schema.column_privileges
WHERE grantee = 'ghalla_ops_ro' AND privilege_type = 'SELECT'
GROUP BY table_name
ORDER BY table_name;
