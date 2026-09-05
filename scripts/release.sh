#!/usr/bin/env bash
# The release pipeline, in the order the steps have to happen.
#
#   check   everything that must pass before a release is attempted, including
#           the coverage gate. Runs locally and in CI; a failure here means no
#           release happens at all.
#   ship    push to main. Staging auto-deploys from that push.
#   wait    poll Railway until the deployment reports SUCCESS or fails.
#   verify  make actual requests against the deployed service.
#
# The clear/seed steps are deliberately NOT in this path — they destroy data and
# belong to a deliberate `pnpm db:reset:staging`, not to every release.
#
# Usage: ./scripts/release.sh [check|ship|wait|verify|all]
set -uo pipefail
cd "$(dirname "$0")/.."

STEP="${1:-all}"
SERVICE="${GHALLA_SERVICE:-ghalla-salla-api}"
export RAILWAY_CALLER="skill:use-railway@1.4.0"

step_check() {
  echo "── check ───────────────────────────────────────────────"
  pnpm run verify || return 1
  # Not in `verify`: it needs a clean drizzle/ directory to tell drift from work
  # in progress, which is exactly what you do NOT have while writing a schema
  # change. A release, by contrast, has a clean tree by definition.
  ./scripts/check-migrations.sh || return 1
  # The coverage gate is separate from `verify` on purpose: `verify` is what a
  # developer runs constantly, and instrumenting every run to produce a number
  # nobody reads is a tax. A release pays it once.
  pnpm run test:coverage || return 1
}

step_ship() {
  echo "── ship ────────────────────────────────────────────────"
  if [ -n "$(git status --porcelain)" ]; then
    echo "FAIL: working tree is dirty. Commit or stash before releasing."
    return 1
  fi
  git push origin main || return 1
  echo "pushed $(git rev-parse --short HEAD); staging auto-deploys from main"
}

step_wait() {
  echo "── wait ────────────────────────────────────────────────"
  local deadline=$((SECONDS + 900))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local status
    status=$(railway deployment list --service "$SERVICE" --json 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);console.log(a[0]?.status??"UNKNOWN")}catch{console.log("UNKNOWN")}})')
    case "$status" in
      SUCCESS) echo "deployment SUCCESS"; return 0 ;;
      FAILED|CRASHED) echo "FAIL: deployment $status"; railway logs --service "$SERVICE" --lines 60 2>/dev/null | tail -40; return 1 ;;
      *) printf '.' ; sleep 10 ;;
    esac
  done
  echo; echo "FAIL: timed out waiting for the deployment"
  return 1
}

step_verify() {
  echo "── verify ──────────────────────────────────────────────"
  local url="${GHALLA_STAGING_URL:-}"
  if [ -z "$url" ]; then
    url=$(railway domain list --service "$SERVICE" --json 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const d=(a.domains??a)[0];console.log(d?.domain?"https://"+d.domain:"")}catch{console.log("")}})')
  fi
  [ -z "$url" ] && { echo "FAIL: could not resolve the service URL"; return 1; }
  ./scripts/verify-staging.sh "$url"
}

case "$STEP" in
  check)  step_check ;;
  ship)   step_ship ;;
  wait)   step_wait ;;
  verify) step_verify ;;
  all)    step_check && step_ship && step_wait && step_verify ;;
  *)      echo "usage: $0 [check|ship|wait|verify|all]"; exit 2 ;;
esac
