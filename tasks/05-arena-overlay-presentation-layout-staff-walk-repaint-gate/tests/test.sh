#!/usr/bin/env bash
# Trusted verifier for the arena-overlay-presentation-layout-staff-walk-repaint-gate task.
# Runs as root. Places protected, solver-unseen test files into the solver's
# workspace, runs them with bun's test runner, and independently determines
# the reward from the resulting JUnit report. Never trusts solver-reported
# output, exit codes, or any file the solver could have authored under the
# names we are about to overwrite.
set -u

WORKDIR="${WORKDIR:-/app}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTECTED_DIR="$SCRIPT_DIR/protected"
LOG_DIR="/logs/verifier"
WORK_TMP="$(mktemp -d /tmp/arena-verify.XXXXXX)"
JUNIT_OUT="$WORK_TMP/junit.xml"

mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR/reward.json"

write_reward() {
  local reward="$1"
  printf '{"reward": %s}\n' "$reward" > "$LOG_DIR/reward.json"
}

fail_infra() {
  echo "VERIFIER INFRASTRUCTURE ERROR: $*" >&2
  exit 1
}

[ -d "$WORKDIR" ] || fail_infra "workdir $WORKDIR does not exist"
[ -f "$PROTECTED_DIR/restaurant-arena-layout.test.ts" ] || fail_infra "missing protected layout test"
[ -f "$PROTECTED_DIR/staff-walk.test.ts" ] || fail_infra "missing protected staff-walk test"
[ -f "$PROTECTED_DIR/restaurant-arena-repaint-gate.test.ts" ] || fail_infra "missing protected repaint-gate test"

TARGET_DIR="$WORKDIR/overlay"
[ -d "$TARGET_DIR" ] || fail_infra "expected overlay/ under $WORKDIR"

# Overwrite (never trust) anything the solver may have placed at these exact
# paths, then drop in our own protected copies.
for name in restaurant-arena-layout.test.ts staff-walk.test.ts restaurant-arena-repaint-gate.test.ts; do
  rm -rf "$TARGET_DIR/$name"
  cp "$PROTECTED_DIR/$name" "$TARGET_DIR/$name"
  chmod 444 "$TARGET_DIR/$name"
done

BUN_BIN="$(command -v bun || echo /usr/local/bun/bin/bun)"
[ -x "$BUN_BIN" ] || fail_infra "bun binary not found"

(
  cd "$WORKDIR" && \
  "$BUN_BIN" test \
    overlay/restaurant-arena-layout.test.ts \
    overlay/staff-walk.test.ts \
    overlay/restaurant-arena-repaint-gate.test.ts \
    --reporter=junit \
    --reporter-outfile="$JUNIT_OUT"
) > "$WORK_TMP/stdout.log" 2> "$WORK_TMP/stderr.log"
RUN_EXIT=$?

echo "---- bun test stdout ----"
cat "$WORK_TMP/stdout.log"
echo "---- bun test stderr ----"
cat "$WORK_TMP/stderr.log"

if [ ! -s "$JUNIT_OUT" ]; then
  echo "No JUnit report produced (run exit=$RUN_EXIT); treating as a failed run." >&2
  write_reward 0
  exit 0
fi

# Independently derive the verdict from the JUnit XML's own summary
# attributes rather than trusting bun's exit code or any solver-visible
# artifact. A conclusive run has a numeric tests count with zero failures
# and zero errors.
SUMMARY_LINE="$(grep -m1 '<testsuites ' "$JUNIT_OUT" || true)"
[ -n "$SUMMARY_LINE" ] || fail_infra "JUnit report missing <testsuites> summary"

TESTS=$(echo "$SUMMARY_LINE" | grep -o 'tests="[0-9]*"' | grep -o '[0-9]*' || echo "")
FAILURES=$(echo "$SUMMARY_LINE" | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*' || echo "")
ERRORS=$(echo "$SUMMARY_LINE" | grep -o 'errors="[0-9]*"' | grep -o '[0-9]*' || echo "0")
[ -n "$ERRORS" ] || ERRORS=0

EXPECTED_TESTS=14

if [ -z "$TESTS" ] || [ -z "$FAILURES" ]; then
  fail_infra "could not parse JUnit summary: $SUMMARY_LINE"
fi

echo "Parsed JUnit summary: tests=$TESTS failures=$FAILURES errors=$ERRORS (expected >= $EXPECTED_TESTS tests)"

if [ "$TESTS" -ge "$EXPECTED_TESTS" ] && [ "$FAILURES" -eq 0 ] && [ "$ERRORS" -eq 0 ]; then
  write_reward 1
else
  write_reward 0
fi

exit 0

