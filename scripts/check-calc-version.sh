#!/usr/bin/env bash
# CALC_VERSION stamps every materialized profit row, and the only query ever run
# against it is `WHERE calc_version < $current`. If the engine's arithmetic
# changes without a bump, the database ends up holding two different
# calculations under one version with no way to tell them apart — and the
# failure is silent, because regenerating the fixtures makes the tests pass.
#
# So: if any golden fixture's expected output changed, CALC_VERSION must have
# changed too. A no-op until the first fixture exists.
set -uo pipefail
cd "$(dirname "$0")/.."

base="${1:-}"
if [ -z "$base" ]; then
  base=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || true)
fi
if [ -z "$base" ]; then
  echo "ok: no base revision to compare against, skipping"
  exit 0
fi

changed=$(git diff --name-only "$base"...HEAD 2>/dev/null || true)
# --diff-filter=M: only MODIFIED expectations count. Adding a new fixture does
# not change the arithmetic for any row already in the database; changing an
# existing expectation is precisely the thing that does.
modified=$(git diff --diff-filter=M --name-only "$base"...HEAD 2>/dev/null || true)
fixtures=$(printf '%s\n' "$modified" | grep -E '^packages/core/test/fixtures/golden/.*expected\.json$' || true)

if [ -z "$fixtures" ]; then
  echo "ok: no golden fixture expectations changed"
  exit 0
fi

if printf '%s\n' "$changed" | grep -q '^packages/core/src/calc-version\.ts$'; then
  echo "ok: golden fixtures changed and CALC_VERSION was bumped"
  exit 0
fi

echo "FAIL: these golden expectations changed but CALC_VERSION did not:"
printf '%s\n' "$fixtures" | sed 's/^/  /'
echo
echo "If the arithmetic changed, bump CALC_VERSION in packages/core/src/calc-version.ts."
echo "If it did not, the fixtures should not have changed — find out why they did."
exit 1
