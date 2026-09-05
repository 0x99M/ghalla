#!/usr/bin/env bash
# The architecture's first rule is not expressible as an import rule, because it
# is about identifiers and strings, not modules: platform vocabulary must not
# appear in the shared packages at all. No `PlatformId = 'salla' | 'zid'`, no
# `if (platform === ...)`, no platform-shaped field name.
#
# This is what makes PlatformId an opaque brand rather than a union.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# --- 1. exactly one flat config -------------------------------------------
# ESLint 10 resolves config by walking up from each LINTED FILE. An
# eslint.config.* dropped inside a package silently detaches the root config and
# the boundary rules evaporate with no error.
# tracked AND not-yet-committed files: a config added in this change set counts.
configs=$(git ls-files --cached --others --exclude-standard | grep -E '(^|/)eslint\.config\.(js|mjs|cjs|ts)$' | sort -u || true)
count=$(printf '%s' "$configs" | grep -c . || true)
if [ "$count" != "1" ]; then
  echo "FAIL: expected exactly one eslint.config.*, found ${count}:"
  printf '%s\n' "$configs" | sed 's/^/  /'
  fail=1
else
  echo "ok: exactly one eslint.config.* (${configs})"
fi

# --- 2. no platform vocabulary in the shared layer -------------------------
# Adapters live in apps/*. Everything under packages/ must be platform-neutral.
if hits=$(git grep -In --untracked -E '\b(salla|zid)\b' -- 'packages/' ':!packages/**/*.md' 2>/dev/null); then
  echo "FAIL: platform vocabulary found under packages/ — it belongs in an adapter under apps/:"
  printf '%s\n' "$hits" | sed 's/^/  /'
  fail=1
else
  echo "ok: no platform vocabulary under packages/"
fi

# --- 3. contracts really has zero runtime dependencies ---------------------
deps=$(node -p "JSON.stringify(Object.keys(require('./packages/contracts/package.json').dependencies ?? {}))")
if [ "$deps" != "[]" ]; then
  echo "FAIL: @ghalla/contracts must have zero runtime dependencies, found ${deps}"
  fail=1
else
  echo "ok: @ghalla/contracts has zero runtime dependencies"
fi

# --- 4. packages/core has exactly one dependency ---------------------------
coredeps=$(node -p "JSON.stringify(Object.keys(require('./packages/core/package.json').dependencies ?? {}))")
if [ "$coredeps" != '["@ghalla/contracts"]' ]; then
  echo "FAIL: packages/core must depend on @ghalla/contracts and nothing else, found ${coredeps}"
  fail=1
else
  echo "ok: packages/core depends on @ghalla/contracts alone"
fi

exit "$fail"
