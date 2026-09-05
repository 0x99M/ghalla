#!/usr/bin/env bash
# Smoke-verify a deployed environment.
#
# This runs AFTER a deploy reports success, because "the deployment succeeded"
# and "the service works" are different claims. Railway reports the first; only
# a request reports the second.
#
# Usage: ./scripts/verify-staging.sh [base-url]
#        GHALLA_STAGING_URL=https://… ./scripts/verify-staging.sh
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-${GHALLA_STAGING_URL:-}}"
if [ -z "$BASE" ]; then
  echo "FAIL: no base URL. Pass one as an argument or set GHALLA_STAGING_URL."
  exit 1
fi
BASE="${BASE%/}"

fail=0
pass() { echo "ok: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }

# --- 1. liveness -----------------------------------------------------------
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/api/v1/ping" || echo 000)
if [ "$code" = "200" ]; then pass "ping returns 200"; else bad "ping returned $code"; fi

# --- 2. readiness, including the database ----------------------------------
# The status CODE is what the platform routes on, so assert that and not just
# the body: a 200 with {"status":"degraded"} would send traffic to a service
# that cannot answer.
body=$(curl -sS --max-time 20 "$BASE/api/v1/health" || echo '{}')
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/api/v1/health" || echo 000)
if [ "$code" = "200" ]; then pass "health returns 200"; else bad "health returned $code — body: $body"; fi

echo "$body" | grep -q '"database":"ok"' \
  && pass "health reports the database reachable" \
  || bad "health did not report a reachable database — body: $body"

echo "$body" | grep -q '"status":"ok"' \
  && pass "health reports status ok" \
  || bad "health did not report status ok — body: $body"

# --- 3. the deployed commit ------------------------------------------------
# Catches the failure mode where a deploy 'succeeds' but the platform is still
# serving the previous image.
deployed=$(echo "$body" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')
local_sha=$(git rev-parse HEAD 2>/dev/null || echo '')
if [ -n "$deployed" ] && [ -n "$local_sha" ]; then
  if [ "${local_sha:0:7}" = "${deployed:0:7}" ]; then
    pass "serving the commit we released (${deployed:0:7})"
  else
    bad "serving ${deployed:0:7} but HEAD is ${local_sha:0:7} — the deploy did not take"
  fi
else
  echo "note: no commit reported, skipping the version check"
fi

# --- 4. the migration actually ran -----------------------------------------
# A pre-deploy migration that silently no-ops leaves a service talking to an
# empty database, which the healthcheck above would not notice.
if [ -n "${DATABASE_URL:-}" ]; then
  # Run from the package that DECLARES pg. The repository root cannot resolve it
  # — that is the isolation working, not a bug — and the old form failed open,
  # reporting "0 tables" for a perfectly healthy database on every release.
  tables=$(cd packages/persistence && node -e '
    const { Client } = require("pg");
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    c.connect().then(() => c.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1", ["public"]))
      .then(r => { console.log(r.rows[0].n); return c.end(); })
      .catch((e) => { console.error(e.message); console.log(0); process.exit(0); });
  ')
  if [ "$tables" -ge 22 ]; then
    pass "the migration applied ($tables tables)"
  else
    bad "expected at least 22 tables, found $tables — the pre-deploy migration did not run"
  fi
else
  echo "note: DATABASE_URL not set, skipping the migration check"
fi

exit "$fail"
