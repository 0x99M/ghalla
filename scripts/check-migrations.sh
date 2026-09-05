#!/usr/bin/env bash
# Fails when schema.ts has drifted from the migrations on disk.
#
# The deploy runs migrations automatically, so the failure this guards is not
# "we forgot to run them" — it is "we forgot to GENERATE one". That one is
# silent and it is the dangerous one: every migration applies cleanly, the
# deploy goes green, and the service runs against a database missing the column
# the code was just taught to read.
#
# Works by asking drizzle-kit to generate, then looking at whether it wrote
# anything. A clean tree means the schema and the migrations agree.
set -uo pipefail
cd "$(dirname "$0")/.."

DRIZZLE_DIR="packages/persistence/drizzle"

if [ -n "$(git status --porcelain -- "$DRIZZLE_DIR")" ]; then
  echo "FAIL: $DRIZZLE_DIR has uncommitted changes; cannot tell drift from work in progress."
  exit 1
fi

# drizzle.config.ts reads DATABASE_URL even for `generate`, which never connects.
# A placeholder keeps this runnable in CI with no database.
DATABASE_URL="${DATABASE_URL:-postgresql://localhost:5432/unused_for_generate}" \
  pnpm --filter @ghalla/persistence db:generate >/dev/null 2>&1 || {
  echo "FAIL: drizzle-kit generate errored. Run 'pnpm db:generate' to see why."
  exit 1
}

DRIFT="$(git status --porcelain -- "$DRIZZLE_DIR")"
if [ -n "$DRIFT" ]; then
  echo "FAIL: schema.ts has changes with no migration. drizzle-kit just wrote:"
  echo "$DRIFT" | sed 's/^/    /'
  echo
  echo "Run 'pnpm db:generate', rename the file to something a human can read,"
  echo "update meta/_journal.json to match, and commit it with the schema change."
  # Leave the tree as the developer found it: this script reports, it does not
  # decide. A generated file left behind would be committed by accident sooner
  # or later, under whatever name drizzle-kit invented for it.
  git checkout -- "$DRIZZLE_DIR" 2>/dev/null
  git clean -fdq -- "$DRIZZLE_DIR" 2>/dev/null
  exit 1
fi

echo "ok: every schema change has a migration"
