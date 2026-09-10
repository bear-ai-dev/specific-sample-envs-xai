#!/usr/bin/env bash
# Trusted, root-owned behavioral verifier for the CLI browser OAuth handoff
# feature. Independently drops in protected test files (ignoring anything the
# solver may have left at those paths), runs the real CLI test runner and the
# real Cloudflare Worker test runner against the solver's own implementation,
# and derives the reward solely from those runs' exit codes.
set -uo pipefail

REPO_ROOT="${GAMEPIGEON_REPO_ROOT:-/app}"
ASSETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/assets" && pwd)"
LOG_DIR="/logs/verifier"
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR/reward.json"

if [ "$(id -u)" -ne 0 ]; then
  echo "tests/test.sh must run as root" >&2
  exit 1
fi

if [ ! -d "$REPO_ROOT/src" ]; then
  echo "repository root not found at $REPO_ROOT" >&2
  exit 1
fi

# Drop in the protected, trusted test files. These overwrite anything the
# solver left at the same path, and are never read from the solver's own
# working tree.
install -m 0644 "$ASSETS_DIR/auth.test.ts" "$REPO_ROOT/src/auth.test.ts"
mkdir -p "$REPO_ROOT/cloudflare/auth-worker/test"
install -m 0644 "$ASSETS_DIR/oauth-handoff.test.ts" "$REPO_ROOT/cloudflare/auth-worker/test/oauth-handoff.test.ts"
# Never trust a solver-authored copy of this file under a different name.
find "$REPO_ROOT/cloudflare/auth-worker/test" -maxdepth 1 -iname "handoff-page.test.ts" -delete

CLI_LOG="$(mktemp)"
WORKER_LOG="$(mktemp)"
cli_status=1
worker_status=1

echo "== CLI OAuth handoff tests (bun test) ==" | tee -a "$CLI_LOG"
if su -s /bin/bash agent -c "cd '$REPO_ROOT' && timeout 120 bun test ./src/auth.test.ts" >>"$CLI_LOG" 2>&1; then
  cli_status=0
fi
cat "$CLI_LOG"

echo "== Cloudflare Worker OAuth handoff tests (vitest) ==" | tee -a "$WORKER_LOG"
if su -s /bin/bash agent -c "cd '$REPO_ROOT/cloudflare/auth-worker' && timeout 180 npx vitest run oauth-handoff.test.ts" >>"$WORKER_LOG" 2>&1; then
  worker_status=0
fi
cat "$WORKER_LOG"

reward=0
if [ "$cli_status" -eq 0 ] && [ "$worker_status" -eq 0 ]; then
  reward=1
fi

cat > "$LOG_DIR/reward.json" <<EOF
{
  "reward": $reward,
  "cli_tests_passed": $([ "$cli_status" -eq 0 ] && echo 1 || echo 0),
  "worker_tests_passed": $([ "$worker_status" -eq 0 ] && echo 1 || echo 0)
}
EOF

echo "reward=$reward"
exit 0

