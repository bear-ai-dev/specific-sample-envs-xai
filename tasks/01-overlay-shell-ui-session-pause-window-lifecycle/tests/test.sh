#!/usr/bin/env bash
# Trusted verifier for tui-gamepigeon-overlay-shell-ui-session-pause-window-lifecycle.
# Runs as root. Copies protected, root-owned behavioral tests into the
# solver's checkout, drives the real overlay module as the non-root `agent`
# user, and independently derives the reward from bun's own JUnit report
# rather than trusting any solver-controlled output.
set -uo pipefail

APP_DIR="/app"
ASSET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/assets" && pwd)"
REWARD_DIR="/logs/verifier"
WORK_DIR="$(mktemp -d /tmp/verifier-work.XXXXXX)"
JUNIT_OUT="${WORK_DIR}/junit.xml"
RUN_LOG="${WORK_DIR}/run.log"

mkdir -p "$REWARD_DIR"
rm -f "$REWARD_DIR/reward.json"

fail_infra() {
  echo "INFRA FAILURE: $1" >&2
  exit 1
}

[ -d "$APP_DIR/overlay" ] || fail_infra "expected source checkout at $APP_DIR/overlay is missing"
[ -f "$ASSET_DIR/dom-setup.ts" ] || fail_infra "verifier asset dom-setup.ts is missing"
[ -f "$ASSET_DIR/overlay-body.html" ] || fail_infra "verifier asset overlay-body.html is missing"
[ -f "$ASSET_DIR/app-session.test.ts" ] || fail_infra "verifier asset app-session.test.ts is missing"

# Overwrite (or create) the exact protected test files regardless of what the
# solver left at these paths; these three names are the only files this step
# touches inside the solver's checkout.
install -m 0644 "$ASSET_DIR/dom-setup.ts" "$APP_DIR/overlay/dom-setup.ts"
install -m 0644 "$ASSET_DIR/overlay-body.html" "$APP_DIR/overlay/overlay-body.html"
install -m 0644 "$ASSET_DIR/app-session.test.ts" "$APP_DIR/overlay/app-session.test.ts"
chown agent:agent "$APP_DIR/overlay/dom-setup.ts" "$APP_DIR/overlay/overlay-body.html" "$APP_DIR/overlay/app-session.test.ts"

chmod 0777 "$WORK_DIR"

# Ensure devDependencies (happy-dom) baked at image build time are present;
# does not touch the solver's own dependency edits.
if [ ! -d "$APP_DIR/node_modules/happy-dom" ]; then
  fail_infra "happy-dom is not installed in the image; this is a build-time dependency, not a solver task"
fi

su agent -c "cd '$APP_DIR' && bun test overlay/app-session.test.ts src/results/local-score.test.ts --reporter=junit --reporter-outfile='$JUNIT_OUT'" \
  > "$RUN_LOG" 2>&1
RUN_EXIT=$?

echo "---- bun test output ----" >&2
cat "$RUN_LOG" >&2
echo "---- end bun test output (exit=$RUN_EXIT) ----" >&2

MIN_EXPECTED_TESTS=16
reward=0

if [ -f "$JUNIT_OUT" ]; then
  TESTS=$(grep -o '<testsuites[^>]*tests="[0-9]*"' "$JUNIT_OUT" | head -1 | grep -o 'tests="[0-9]*"' | grep -o '[0-9]*')
  FAILURES=$(grep -o '<testsuites[^>]*failures="[0-9]*"' "$JUNIT_OUT" | head -1 | grep -o 'failures="[0-9]*"' | grep -o '[0-9]*')
  TESTS="${TESTS:-0}"
  FAILURES="${FAILURES:-1}"
  echo "verifier: parsed junit tests=$TESTS failures=$FAILURES (expected at least $MIN_EXPECTED_TESTS tests)" >&2
  if [ "$TESTS" -ge "$MIN_EXPECTED_TESTS" ] && [ "$FAILURES" -eq 0 ]; then
    reward=1
  else
    reward=0
  fi
else
  # No JUnit report means the run crashed before any test executed (a parse
  # error, a missing module, etc.). That is a conclusive, correctly-graded
  # failure of the solver's checkout, not a verifier infrastructure problem.
  echo "verifier: no JUnit report was produced; grading as a conclusive failure" >&2
  reward=0
fi

printf '{"reward": %s}\n' "$reward" > "$REWARD_DIR/reward.json"
cat "$REWARD_DIR/reward.json" >&2
rm -rf "$WORK_DIR"
exit 0

