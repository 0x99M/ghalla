#!/usr/bin/env bash
# The architecture's first rule is not expressible as an import rule, because it
# is about identifiers and strings, not modules: platform vocabulary must not
# appear in the shared packages at all. No `PlatformId = 'x' | 'y'` union, no
# `if (platform === ...)` branch, no platform-shaped field name.
#
# This is what makes PlatformId an opaque brand.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# --- 1. exactly one flat config -------------------------------------------
# ESLint 10 resolves config by walking up from each LINTED FILE. An
# eslint.config.* dropped inside a package silently detaches the root config and
# every boundary rule evaporates with no error and no output.
#
# `find` over the worktree, not `git ls-files`: a gitignored config still
# detaches the rules, so a check that only sees tracked files fails open.
# The extension list must match what ESLint actually loads, mts and cts included.
configs=$(find . -type d \( -name node_modules -o -name dist -o -name .git -o -name .turbo \) -prune -o \
  -type f -regex '.*/eslint\.config\.\(js\|mjs\|cjs\|ts\|mts\|cts\)' -print | sort)
count=$(printf '%s' "$configs" | grep -c . || true)
if [ "$count" != "1" ]; then
  echo "FAIL: expected exactly one eslint.config.*, found ${count}:"
  printf '%s\n' "$configs" | sed 's/^/  /'
  fail=1
else
  echo "ok: exactly one eslint.config.* (${configs# ./})"
fi

# --- 2. no platform vocabulary in the shared layer -------------------------
# Adapters live in apps/*. Everything under packages/ must be platform-neutral.
#
# Case-insensitive SUBSTRING, not a word-boundary match. `\b` requires a
# non-word character on both sides and `_` is a word character, so a
# word-bounded pattern misses every shape a real violation actually takes:
# sallaOrderId, salla_order_id, SALLA_ORDER_ID, SallaAdapter, ZidClient.
#
# Scope is packages/ only, deliberately: tooling/eslint-config/index.js has to
# name these platforms, because naming them is how it forbids them.
if hits=$(git grep -Iin --untracked -e salla -e zid -e سلة -e زد -- 'packages/' ':!packages/**/*.md' 2>/dev/null); then
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

# --- 5. every package type-checks its tests --------------------------------
# Golden fixtures live under test/. Without a tsconfig.test.json the branded
# money types are unenforced in exactly the files written to prove the
# arithmetic, and a float assigned to a Minor field compiles and passes.
for pkg in packages/*/; do
  [ -f "${pkg}tsconfig.json" ] || continue
  if [ ! -f "${pkg}tsconfig.test.json" ]; then
    echo "FAIL: ${pkg} has no tsconfig.test.json, so anything under ${pkg}test/ is unchecked"
    fail=1
  fi
done
[ "$fail" = "0" ] && echo "ok: every package type-checks its test directory"

exit "$fail"
