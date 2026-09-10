#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

WORKTREE="$TEMP_DIR/worktree"
mkdir -p "$WORKTREE/.codex-plugin" "$WORKTREE/scripts"
cp "$ROOT_DIR/.codex-plugin/plugin.json" "$WORKTREE/.codex-plugin/plugin.json"
cp "$ROOT_DIR/scripts/materialize-agents-plugin.sh" "$WORKTREE/scripts/materialize-agents-plugin.sh"
chmod +x "$WORKTREE/scripts/materialize-agents-plugin.sh"

(
  cd "$WORKTREE"
  bash scripts/materialize-agents-plugin.sh
)

test -f "$WORKTREE/.agents/plugins/marketplace.json"
test -f "$WORKTREE/.agents/plugins/tui-gamepigeon/plugin.json"
test -f "$WORKTREE/.agents/plugins/tui-gamepigeon/hooks.json"
test -f "$WORKTREE/.agents/plugins/tui-gamepigeon/skills/arcade/SKILL.md"

grep -Fq "node $WORKTREE/scripts/run-with-bun.cjs $WORKTREE/scripts/overlay.ts --enable" \
  "$WORKTREE/.agents/plugins/tui-gamepigeon/skills/arcade/SKILL.md"
for event in session-start pre-invocation stop; do
  grep -Fq "node $WORKTREE/scripts/run-with-bun.cjs $WORKTREE/scripts/antigravity-hook.ts --$event" \
    "$WORKTREE/.agents/plugins/tui-gamepigeon/hooks.json"
done
grep -Fq '"name": "tui-gamepigeon-dev"' \
  "$WORKTREE/.agents/plugins/marketplace.json"

bash "$ROOT_DIR/scripts/dev-harness.sh" 2>/dev/null && exit 1 || true

echo "dev-harness tests passed"
