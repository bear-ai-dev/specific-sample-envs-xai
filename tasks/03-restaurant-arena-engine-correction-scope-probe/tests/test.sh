#!/usr/bin/env bash
# Trusted verifier for the restaurant-arena standing-correction / scope-probe
# feature. Runs as root. Copies the solver's final workspace into a
# root-owned, non-agent-writable directory, drops in the protected
# behavioral test file, and independently derives the reward from bun's own
# recorded pass/fail tally (no submitted stdout, exit-code claims, or
# self-reported counters are trusted beyond what bun itself writes to the
# junit report this script parses).
set -euo pipefail

export BUN_INSTALL="${BUN_INSTALL:-/usr/local/bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLVER_SRC="${SOLVER_WORKDIR:-/app}"

WORKDIR="$(mktemp -d /root/verify-XXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

LOG_DIR="/logs/verifier"
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR/reward.json"

echo "verifier: copying solver workspace from $SOLVER_SRC" >&2
mkdir -p "$WORKDIR/app"
# Copy everything except node_modules (reused via symlink: solve.sh never
# touches dependencies, and re-installing here buys nothing but time).
( cd "$SOLVER_SRC" && tar --exclude=node_modules -cf - . ) | ( cd "$WORKDIR/app" && tar -xf - )
if [ -d "$SOLVER_SRC/node_modules" ]; then
  ln -s "$SOLVER_SRC/node_modules" "$WORKDIR/app/node_modules"
fi

# Protected test file: owned by root, never present in the solver image,
# copied in only for this grading run.
mkdir -p "$WORKDIR/app/src/games/restaurant-arena"
cp "$SCRIPT_DIR/standing-correction-probe.test.ts" \
   "$WORKDIR/app/src/games/restaurant-arena/__verifier_standing_correction_probe.test.ts"

chown -R root:root "$WORKDIR"

JUNIT_PATH="$WORKDIR/junit.xml"
STDOUT_LOG="$LOG_DIR/bun-test-stdout.log"

set +e
( cd "$WORKDIR/app" && bun test \
    src/games/restaurant-arena/__verifier_standing_correction_probe.test.ts \
    --reporter=junit --reporter-outfile="$JUNIT_PATH" ) > "$STDOUT_LOG" 2>&1
BUN_EXIT=$?
set -e

TESTS=0
FAILURES=0
ERRORS=0
if [ -f "$JUNIT_PATH" ]; then
  cp "$JUNIT_PATH" "$LOG_DIR/junit.xml" 2>/dev/null || true
  # Only the single outermost <testsuites ...> summary line carries the
  # whole-run totals; every nested <testsuite> repeats a subset of the same
  # counts (one per describe block), so summing every occurrence of the
  # attribute across the file over-counts. Read the first line only.
  ROOT_LINE="$(grep -m1 '<testsuites ' "$JUNIT_PATH" || true)"
  extract_attr() {
    printf '%s' "$ROOT_LINE" | grep -o "$1=\"[0-9]*\"" | grep -o '[0-9]*' || true
  }
  T="$(extract_attr tests)"; [ -n "$T" ] && TESTS="$T"
  F="$(extract_attr failures)"; [ -n "$F" ] && FAILURES="$F"
  E="$(extract_attr errors)"; [ -n "$E" ] && ERRORS="$E"
fi

echo "verifier: bun exit=$BUN_EXIT tests=$TESTS failures=$FAILURES errors=$ERRORS" >&2

REWARD=0
if [ "$BUN_EXIT" -eq 0 ] && [ "$TESTS" -gt 0 ] && [ "$FAILURES" -eq 0 ] && [ "$ERRORS" -eq 0 ]; then
  REWARD=1
fi

printf '{"reward": %s}\n' "$REWARD" > "$LOG_DIR/reward.json"
echo "verifier: reward=$REWARD" >&2
exit 0

