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
# On a push to main the merge base IS HEAD, so the diff is empty and the guard
# would always pass. Fall back to the previous commit.
if [ "$base" = "$(git rev-parse HEAD 2>/dev/null)" ]; then
  base=$(git rev-parse HEAD~1 2>/dev/null || true)
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

# Read the VALUE, not the file name. Grepping the changed-file list meant a
# commit that reworded a comment in calc-version.ts satisfied the guard while
# the constant stood still — precisely the "two different calculations under one
# version" state this exists to prevent.
extract() { grep -oE 'toCalcVersion\(([0-9]+)\)' | grep -oE '[0-9]+' | head -1; }
before=$(git show "$base:packages/core/src/calc-version.ts" 2>/dev/null | extract || true)
after=$(extract < packages/core/src/calc-version.ts || true)

if [ -n "$before" ] && [ -n "$after" ] && [ "$after" -gt "$before" ] 2>/dev/null; then
  echo "ok: golden expectations changed and CALC_VERSION rose ${before} -> ${after}"
  exit 0
fi

echo "FAIL: these golden expectations changed but CALC_VERSION did not rise (${before:-?} -> ${after:-?}):"
printf '%s\n' "$fixtures" | sed 's/^/  /'
echo
echo "If the arithmetic changed, raise CALC_VERSION in packages/core/src/calc-version.ts."
echo "If it did not, the expectations should not have changed — find out why they did."
exit 1
