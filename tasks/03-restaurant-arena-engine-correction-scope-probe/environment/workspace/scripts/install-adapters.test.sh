#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

# Every harness home must be sandboxed for the whole run. These default to the
# developer's real config when unset, so a single invocation that forgets one
# rewrites the actual ~/.agents, ~/.codex, or ~/.claude. Exporting them here
# means a new install-adapters.sh call cannot leak by omission.
export AGENTS_HOME="$TEMP_DIR/agents-default"
export CODEX_HOME="$TEMP_DIR/codex-default"
export CLAUDE_CONFIG_DIR="$TEMP_DIR/claude-default"
export OPENCODE_CONFIG_DIR="$TEMP_DIR/opencode-default"
export HERMES_HOME="$TEMP_DIR/hermes-default"
export OPENCLAW_HOME="$TEMP_DIR/openclaw-default"

CODEX_HOME="$TEMP_DIR/codex" \
CLAUDE_CONFIG_DIR="$TEMP_DIR/claude" \
OPENCODE_CONFIG_DIR="$TEMP_DIR/opencode" \
HERMES_HOME="$TEMP_DIR/hermes" \
OPENCLAW_HOME="$TEMP_DIR/openclaw" \
AGENTS_HOME="$TEMP_DIR/agents" \
GAMEPIGEON_WORKSPACE_DIR="$TEMP_DIR/antigravity" \
  bash "$ROOT_DIR/scripts/install-adapters.sh"

for skill_file in \
  "$TEMP_DIR/codex/skills/arcade/SKILL.md" \
  "$TEMP_DIR/claude/skills/arcade/SKILL.md" \
  "$TEMP_DIR/hermes/skills/arcade/SKILL.md" \
  "$TEMP_DIR/openclaw/skills/arcade/SKILL.md"; do
  test -f "$skill_file"
  grep -q '^name: arcade$' "$skill_file"
  grep -Fq "node $ROOT_DIR/scripts/run-with-bun.cjs $ROOT_DIR/scripts/overlay.ts --enable" "$skill_file"
  grep -Fq 'Do not spawn another agent or task.' "$skill_file"
  grep -Fq 'Tui opens as a borderless HTML overlay' "$skill_file"
done

grep -Fq "node $ROOT_DIR/scripts/run-with-bun.cjs $ROOT_DIR/scripts/overlay.ts --enable --harness codex" \
  "$TEMP_DIR/codex/skills/arcade/SKILL.md"
grep -Fq "node $ROOT_DIR/scripts/run-with-bun.cjs $ROOT_DIR/scripts/overlay.ts --enable --harness hermes" \
  "$TEMP_DIR/hermes/skills/arcade/SKILL.md"
grep -Fq "node $ROOT_DIR/scripts/run-with-bun.cjs $ROOT_DIR/scripts/overlay.ts --enable --harness openclaw" \
  "$TEMP_DIR/openclaw/skills/arcade/SKILL.md"
grep -Fq 'install --codex' "$TEMP_DIR/codex/skills/arcade/SKILL.md"
grep -Fq 'install --hermes' "$TEMP_DIR/hermes/skills/arcade/SKILL.md"
grep -Fq 'install --openclaw' "$TEMP_DIR/openclaw/skills/arcade/SKILL.md"

test -f "$TEMP_DIR/openclaw/hooks/arcade/HOOK.md"
test -f "$TEMP_DIR/openclaw/hooks/arcade/handler.js"
# The workspace plugin is now a local-development artifact: `install --antigravity`
# installs globally instead, so nothing writes a plugin into whatever directory
# the installer happened to run from. Exercise it through the script that owns it.
bash "$ROOT_DIR/scripts/materialize-agents-plugin.sh" "$TEMP_DIR/antigravity" >/dev/null
test -f "$TEMP_DIR/antigravity/.agents/plugins/tui-gamepigeon/plugin.json"

# Antigravity fires SessionStart, PreToolUse, PostToolUse, PreInvocation,
# PostInvocation and Stop; it drops any other event key without reporting it.
# The global install must match the workspace plugin: Antigravity has no
# UserPromptSubmit and no SessionEnd, and drops unknown keys silently, so
# writing the Claude event names here produced handlers that never ran.
global_antigravity_hooks="$TEMP_DIR/agents/hooks.json"
test -f "$global_antigravity_hooks"
for event in session-start pre-invocation stop; do
  grep -Fq "node '$ROOT_DIR/scripts/run-with-bun.cjs' '$ROOT_DIR/scripts/antigravity-hook.ts' --$event" \
    "$global_antigravity_hooks"
done
for unsupported in UserPromptSubmit SessionEnd; do
  if grep -Fq "\"$unsupported\"" "$global_antigravity_hooks"; then
    echo "Global Antigravity hooks must not declare $unsupported" >&2
    exit 1
  fi
done

antigravity_hooks="$TEMP_DIR/antigravity/.agents/plugins/tui-gamepigeon/hooks.json"
test -f "$antigravity_hooks"
for event in session-start pre-invocation stop; do
  grep -Fq "node $ROOT_DIR/scripts/run-with-bun.cjs $ROOT_DIR/scripts/antigravity-hook.ts --$event" \
    "$antigravity_hooks"
done
for unsupported in UserPromptSubmit SessionEnd Notification; do
  if grep -Fq "\"$unsupported\"" "$antigravity_hooks"; then
    echo "hooks.json declares $unsupported, which Antigravity silently ignores" >&2
    exit 1
  fi
done

opencode_command="$TEMP_DIR/opencode/commands/arcade.md"
test -f "$opencode_command"
grep -q '^description: Open or restore the Tui overlay$' "$opencode_command"
grep -Fq "!\`node $ROOT_DIR/scripts/run-with-bun.cjs $ROOT_DIR/scripts/overlay.ts --enable --harness opencode\`" "$opencode_command"
grep -Fq 'Running `/arcade` again focuses the existing overlay.' "$opencode_command"
grep -Fq 'install --opencode' "$opencode_command"

CODEX_ONLY="$TEMP_DIR/codex-only"
CLAUDE_UNUSED="$TEMP_DIR/claude-unused"
OPENCODE_UNUSED="$TEMP_DIR/opencode-unused"
CODEX_HOME="$CODEX_ONLY" \
CLAUDE_CONFIG_DIR="$CLAUDE_UNUSED" \
OPENCODE_CONFIG_DIR="$OPENCODE_UNUSED" \
  bash "$ROOT_DIR/scripts/install-adapters.sh" --codex

test -f "$CODEX_ONLY/skills/arcade/SKILL.md"
test ! -e "$CLAUDE_UNUSED"
test ! -e "$OPENCODE_UNUSED"

CLI_CODEX_HOME="$TEMP_DIR/cli-codex"
CODEX_HOME="$CLI_CODEX_HOME" \
CLAUDE_CONFIG_DIR="$TEMP_DIR/cli-claude" \
OPENCODE_CONFIG_DIR="$TEMP_DIR/cli-opencode" \
HERMES_HOME="$TEMP_DIR/cli-hermes" \
OPENCLAW_HOME="$TEMP_DIR/cli-openclaw" \
  bun "$ROOT_DIR/dist/index.js" install --codex
test -f "$CLI_CODEX_HOME/skills/arcade/SKILL.md"

# `install --antigravity` is global now, so it no longer depends on the directory
# it is invoked from.
CLI_AGENTS_HOME="$TEMP_DIR/cli-agents"
AGENTS_HOME="$CLI_AGENTS_HOME" bun "$ROOT_DIR/dist/index.js" install --antigravity
test -f "$CLI_AGENTS_HOME/skills/arcade/SKILL.md"
test -f "$CLI_AGENTS_HOME/hooks.json"
grep -Fq -- '--pre-invocation' "$CLI_AGENTS_HOME/hooks.json"

OPENCODE_ONLY="$TEMP_DIR/opencode-only"
CODEX_UNUSED="$TEMP_DIR/codex-unused"
CLAUDE_UNUSED_2="$TEMP_DIR/claude-unused-2"
CODEX_HOME="$CODEX_UNUSED" \
CLAUDE_CONFIG_DIR="$CLAUDE_UNUSED_2" \
OPENCODE_CONFIG_DIR="$OPENCODE_ONLY" \
  bash "$ROOT_DIR/scripts/install-adapters.sh" --opencode

test -f "$OPENCODE_ONLY/commands/arcade.md"
test ! -e "$CODEX_UNUSED"
test ! -e "$CLAUDE_UNUSED_2"

for harness in hermes openclaw; do
  harness_home="$TEMP_DIR/$harness-only"
  CODEX_HOME="$TEMP_DIR/$harness-codex-unused" \
  CLAUDE_CONFIG_DIR="$TEMP_DIR/$harness-claude-unused" \
  HERMES_HOME="$([[ "$harness" == hermes ]] && echo "$harness_home" || echo "$TEMP_DIR/hermes-unused")" \
  OPENCLAW_HOME="$([[ "$harness" == openclaw ]] && echo "$harness_home" || echo "$TEMP_DIR/openclaw-unused")" \
    bash "$ROOT_DIR/scripts/install-adapters.sh" "--$harness"
  test -f "$harness_home/skills/arcade/SKILL.md"
  # `--` or grep reads the pattern as its own option and fails the whole suite.
  grep -Fq -- "--harness $harness" "$harness_home/skills/arcade/SKILL.md"
done

# The documented install runs from a bunx temp checkout the OS eventually
# reclaims, taking every hook path with it. Installing from one must copy the
# checkout somewhere durable and point the generated commands at the copy.
FAKE_TMP="$TEMP_DIR/bunx-501-@tui-games/tui@latest/node_modules/@tui-games/tui"
mkdir -p "$FAKE_TMP" "$TEMP_DIR/bunx-501-@tui-games/tui@latest/node_modules/posthog-node"
cp -R "$ROOT_DIR/scripts" "$FAKE_TMP/scripts"
cp "$ROOT_DIR/package.json" "$FAKE_TMP/package.json"
echo '{"name":"posthog-node"}' > "$TEMP_DIR/bunx-501-@tui-games/tui@latest/node_modules/posthog-node/package.json"

RELOCATED_HOME="$TEMP_DIR/relocated-home"
RELOCATED_ROOT="$RELOCATED_HOME/runtime/node_modules/@tui-games/tui"
GAMEPIGEON_HOME="$RELOCATED_HOME" \
CLAUDE_CONFIG_DIR="$TEMP_DIR/relocated-claude" \
  bash "$FAKE_TMP/scripts/install-adapters.sh" --claude

test -f "$RELOCATED_ROOT/scripts/overlay.ts"
# Dependencies resolve by walking up to the enclosing node_modules, so they have
# to travel with the package or every hook dies on an unresolved import.
test -f "$RELOCATED_HOME/runtime/node_modules/posthog-node/package.json"
# Nothing generated may still reference the temp checkout.
grep -Fq "$RELOCATED_ROOT/scripts/overlay.ts" "$TEMP_DIR/relocated-claude/skills/arcade/SKILL.md"
if grep -Fq "$FAKE_TMP" "$TEMP_DIR/relocated-claude/skills/arcade/SKILL.md" \
  || grep -Fq "$FAKE_TMP" "$TEMP_DIR/relocated-claude/settings.json"; then
  echo "install-adapters.sh left a temp-directory path in a generated file" >&2
  exit 1
fi
# The nudge is the backup for when the overlay is never opened to self-update.
grep -Fq -- "plugin-update.ts' --nudge --harness claude" "$TEMP_DIR/relocated-claude/settings.json"

# A normal checkout is already durable and must be installed from in place.
IN_PLACE_HOME="$TEMP_DIR/in-place-home"
GAMEPIGEON_HOME="$IN_PLACE_HOME" \
CLAUDE_CONFIG_DIR="$TEMP_DIR/in-place-claude" \
  bash "$ROOT_DIR/scripts/install-adapters.sh" --claude
test ! -e "$IN_PLACE_HOME/runtime"
grep -Fq "$ROOT_DIR/scripts/overlay.ts" "$TEMP_DIR/in-place-claude/skills/arcade/SKILL.md"

echo "adapter installer tests passed"
