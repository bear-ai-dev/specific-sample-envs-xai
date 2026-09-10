#!/usr/bin/env bash
# Trusted verifier for the restaurant-arena trace capture / validate / replay /
# export feature. Runs as root, drives the real public CLI and unit-level
# entry points of the solver's own workspace, and derives the pass/fail
# verdict itself instead of trusting any agent-reported result.
set -uo pipefail

WORKDIR="${TASK_WORKDIR:-/app}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REWARD_DIR="/logs/verifier"
SCRATCH="$(mktemp -d /tmp/arena-trace-verify.XXXXXX)"
HIDDEN_TEST_NAME=".verifier-trace-behavior.test.ts"
HIDDEN_TEST_DEST="${WORKDIR}/src/games/restaurant-arena/${HIDDEN_TEST_NAME}"
JUNIT_OUT="${SCRATCH}/junit.xml"
OVERLAY_JUNIT_OUT="${SCRATCH}/overlay-junit.xml"

mkdir -p "$REWARD_DIR"
# Clear any stale reward from a previous run. A run that crashes before a
# fresh verdict is written must leave no reward file at all, never an old one.
rm -f "${REWARD_DIR}/reward.json"

cleanup() {
  rm -f "$HIDDEN_TEST_DEST"
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

fail_reward() {
  local reason="$1"
  echo "VERIFICATION FAILED: ${reason}" >&2
  printf '{"reward": 0}\n' > "${REWARD_DIR}/reward.json"
  exit 0
}

pass_reward() {
  printf '{"reward": 1}\n' > "${REWARD_DIR}/reward.json"
  exit 0
}

[ -d "$WORKDIR" ] || fail_reward "workdir ${WORKDIR} does not exist"
cd "$WORKDIR" || fail_reward "cannot cd into ${WORKDIR}"

for f in \
  src/games/restaurant-arena/trace.ts \
  src/games/restaurant-arena/replay.ts \
  scripts/export-arena-trace.ts \
  scripts/replay-arena-trace.ts \
  overlay/app.ts \
  overlay/restaurant-arena-timeline.test.ts \
  overlay/tsconfig.json
do
  [ -f "$f" ] || fail_reward "missing expected file: ${f}"
done

# --- 1. Unit-level behavioral checks, run against the solver's own code. ---
# The verifier writes this file itself (root-owned copy), overwriting
# anything already present at that path, so the agent cannot pre-seed a
# fake passing copy.
install -m 0644 "${SCRIPT_DIR}/hidden/trace-behavior.test.ts" "$HIDDEN_TEST_DEST" \
  || fail_reward "could not stage hidden test file"

set +e
bun test "src/games/restaurant-arena/${HIDDEN_TEST_NAME}" \
  --reporter=junit --reporter-outfile="$JUNIT_OUT" \
  >"${SCRATCH}/unit.stdout" 2>"${SCRATCH}/unit.stderr"
unit_exit=$?
set -e

[ -f "$JUNIT_OUT" ] || fail_reward "unit test run produced no junit report (exit ${unit_exit})"

# Independently parse the junit XML rather than trusting bun's exit code
# alone: require the full expected number of tests to have run with zero
# failures and zero errors.
suite_line="$(grep -m1 '<testsuites ' "$JUNIT_OUT" || true)"
[ -n "$suite_line" ] || fail_reward "junit report missing <testsuites> summary"

tests_attr="$(echo "$suite_line" | grep -oE 'tests="[0-9]+"' | grep -oE '[0-9]+' || true)"
failures_attr="$(echo "$suite_line" | grep -oE 'failures="[0-9]+"' | grep -oE '[0-9]+' || true)"

[ -n "$tests_attr" ] && [ -n "$failures_attr" ] || fail_reward "junit report missing tests/failures counts"
[ "$failures_attr" = "0" ] || fail_reward "hidden behavioral tests reported ${failures_attr} failure(s)"
[ "$tests_attr" -ge 11 ] || fail_reward "hidden behavioral tests only ran ${tests_attr} of the expected 11 cases"

# --- 1b. Overlay integration: a second, real caller of this module that the
# solver does not get to touch or stage. overlay/app.ts and the pre-existing
# overlay/restaurant-arena-timeline.test.ts already import captureArenaTrace,
# exportTraceJson, exportTraceJsonl and validateArenaTraceV3 as standalone
# named exports (not the game instance method) and replayArenaTrace from the
# replay module. If trace.ts/replay.ts only satisfy the instance-method shape
# the hidden unit test drives, this whole project fails to type-check and
# this whole test file fails to load.
set +e
tsc_out="$(bunx tsc -p overlay/tsconfig.json 2>&1)"
tsc_exit=$?
set -e
[ "$tsc_exit" -eq 0 ] || fail_reward "overlay TypeScript project (overlay/tsconfig.json) does not type-check cleanly: ${tsc_out}"

set +e
bun test overlay/restaurant-arena-timeline.test.ts \
  --reporter=junit --reporter-outfile="$OVERLAY_JUNIT_OUT" \
  >"${SCRATCH}/overlay.stdout" 2>"${SCRATCH}/overlay.stderr"
overlay_exit=$?
set -e

[ -f "$OVERLAY_JUNIT_OUT" ] || fail_reward "overlay integration test run produced no junit report (exit ${overlay_exit}): $(cat "${SCRATCH}/overlay.stdout" "${SCRATCH}/overlay.stderr" 2>/dev/null)"

overlay_suite_line="$(grep -m1 '<testsuites ' "$OVERLAY_JUNIT_OUT" || true)"
[ -n "$overlay_suite_line" ] || fail_reward "overlay junit report missing <testsuites> summary"

overlay_tests_attr="$(echo "$overlay_suite_line" | grep -oE 'tests="[0-9]+"' | grep -oE '[0-9]+' || true)"
overlay_failures_attr="$(echo "$overlay_suite_line" | grep -oE 'failures="[0-9]+"' | grep -oE '[0-9]+' || true)"

[ -n "$overlay_tests_attr" ] && [ -n "$overlay_failures_attr" ] || fail_reward "overlay junit report missing tests/failures counts"
[ "$overlay_failures_attr" = "0" ] || fail_reward "overlay integration tests reported ${overlay_failures_attr} failure(s)"
[ "$overlay_tests_attr" -ge 5 ] || fail_reward "overlay integration tests only ran ${overlay_tests_attr} of the expected 5 cases"

# --- 2. CLI-level round trip: capture -> validate -> export -> replay. ---
set +e
export_out="$(bun scripts/export-arena-trace.ts 2>&1)"
export_exit=$?
set -e
[ "$export_exit" -eq 0 ] || fail_reward "export-arena-trace.ts exited ${export_exit}: ${export_out}"
echo "$export_out" | grep -q "Wrote" || fail_reward "export-arena-trace.ts did not report writing the fixture"

set +e
check_out="$(bun scripts/export-arena-trace.ts --check 2>&1)"
check_exit=$?
set -e
[ "$check_exit" -eq 0 ] || fail_reward "export-arena-trace.ts --check exited ${check_exit}: ${check_out}"
echo "$check_out" | grep -q "Fixture is current" || fail_reward "export-arena-trace.ts --check did not confirm a current fixture"

fixture_path="contracts/fixtures/restaurant-arena-trace-v3.json"
[ -f "$fixture_path" ] || fail_reward "expected fixture ${fixture_path} was not written"

# --- 2a. Stale-fixture detection: --check must tell a fixture that no longer
# matches a fresh capture from one that does, not accept whatever is on disk.
# The contract (docs/restaurant-arena-trace-contract.md) requires --check to
# exit non-zero, and never print "Fixture is current", once the two diverge.
fixture_backup="${SCRATCH}/fixture-backup.json"
cp "$fixture_path" "$fixture_backup" || fail_reward "could not back up the fixture before the stale-detection probe"

bun -e '
const fs = require("fs");
const p = process.argv[1];
const trace = JSON.parse(fs.readFileSync(p, "utf8"));
trace.events[0].actorId = "verifier-stale-probe";
fs.writeFileSync(p, JSON.stringify(trace, null, 2) + "\n");
' "$fixture_path" || fail_reward "could not mutate the on-disk fixture to probe stale detection"

set +e
stale_check_out="$(bun scripts/export-arena-trace.ts --check 2>&1)"
stale_check_exit=$?
set -e
cp "$fixture_backup" "$fixture_path" || fail_reward "could not restore the fixture after the stale-detection probe"

[ "$stale_check_exit" -ne 0 ] || fail_reward "export-arena-trace.ts --check exited 0 for a fixture that no longer matches a fresh capture"
if echo "$stale_check_out" | grep -q "Fixture is current"; then
  fail_reward "export-arena-trace.ts --check reported a stale fixture as current"
fi

set +e
replay_out="$(bun scripts/replay-arena-trace.ts "$fixture_path" 2>&1)"
replay_exit=$?
set -e
[ "$replay_exit" -eq 0 ] || fail_reward "replay-arena-trace.ts exited ${replay_exit} on the fresh fixture: ${replay_out}"
echo "$replay_out" | grep -q "Native replay passed" || fail_reward "replay-arena-trace.ts did not report a passing native replay"

# --- 2b. JSONL export/import round trip through the same replay CLI. ---
jsonl_path="${SCRATCH}/fixture-from-jsonl.jsonl"
bun -e "
const { readFileSync, writeFileSync } = require(\"fs\");
const { exportTraceJsonl } = require(\"./src/games/restaurant-arena/trace.ts\");
const trace = JSON.parse(readFileSync(process.argv[1], \"utf8\"));
writeFileSync(process.argv[2], exportTraceJsonl(trace));
" "$fixture_path" "$jsonl_path" || fail_reward "could not build a JSONL rendition of the fixture via exportTraceJsonl"

set +e
jsonl_replay_out="$(bun scripts/replay-arena-trace.ts "$jsonl_path" 2>&1)"
jsonl_replay_exit=$?
set -e
[ "$jsonl_replay_exit" -eq 0 ] || fail_reward "replay-arena-trace.ts exited ${jsonl_replay_exit} on the JSONL fixture: ${jsonl_replay_out}"
echo "$jsonl_replay_out" | grep -q "Native replay passed" || fail_reward "replay-arena-trace.ts did not pass on the JSONL fixture"

# --- 3. Tamper detection: a spliced input must fail native replay. ---
tampered="${SCRATCH}/tampered-trace.json"
bun -e '
const fs = require("fs");
const trace = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
trace.replay.inputs.splice(1, 1);
fs.writeFileSync(process.argv[2], JSON.stringify(trace));
' "$fixture_path" "$tampered" || fail_reward "could not build a tampered trace fixture"

set +e
bun scripts/replay-arena-trace.ts "$tampered" >"${SCRATCH}/tamper.stdout" 2>"${SCRATCH}/tamper.stderr"
tamper_exit=$?
set -e
[ "$tamper_exit" -ne 0 ] || fail_reward "replay-arena-trace.ts accepted a tampered trace (splice went undetected)"

pass_reward

