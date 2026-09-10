#!/usr/bin/env bash
# Verifies the Claude auto-update chain end to end, in a sandbox.
#
# Nothing here touches your real install: GAMEPIGEON_HOME and CLAUDE_CONFIG_DIR
# are redirected to a temp directory that is deleted on exit. It builds a
# faithful copy of the production bunx tree, installs from it, and then runs
# each link of the chain the way the harness actually invokes it.
#
# Usage: bash verify-auto-update.sh [path-to-checkout]
set -euo pipefail

REPO="$(cd "${1:-$PWD}" && pwd)"
[[ -f "$REPO/scripts/install-adapters.sh" ]] || { echo "Not a tui checkout: $REPO" >&2; exit 2; }

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
check(){ if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1"; printf '        expected to contain: %s\n        got: %s\n' "$3" "$2"; fi; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
HOME_DIR="$T/gamepigeon"; CLAUDE="$T/claude"
BUNX="$T/bunx-501-@tui-games/tui@latest/node_modules"
SRC="$BUNX/@tui-games/tui"
mkdir -p "$SRC" "$HOME_DIR" "$CLAUDE"

echo "Building a fake bunx checkout from $REPO"
for p in scripts src packages overlay dist package.json overlay-release.json .claude-plugin; do
  [[ -e "$REPO/$p" ]] && cp -RL "$REPO/$p" "$SRC/$p"
done
# Take node_modules whole and as-is: bun links top-level packages into a .bun/
# store, so cherry-picking or dereferencing them loses transitive dependencies.
if [[ -d "$REPO/node_modules" ]]; then
  for entry in "$REPO/node_modules"/* "$REPO/node_modules"/.bun; do
    [[ -e "$entry" ]] || continue
    [[ "$(basename "$entry")" == "@tui-games" ]] && continue
    cp -R "$entry" "$BUNX/$(basename "$entry")"
  done
fi
# Pretend this checkout is ancient so the published release looks newer.
python3 -c "
import json,sys; p='$SRC/package.json'; d=json.load(open(p)); d['version']='0.0.1'; json.dump(d,open(p,'w'))"

echo
echo "1. Install from the temp checkout (this is what \`bun x … install --claude\` does)"
GAMEPIGEON_HOME="$HOME_DIR" CLAUDE_CONFIG_DIR="$CLAUDE" \
  bash "$SRC/scripts/install-adapters.sh" --claude > "$T/install.log" 2>&1 \
  || { echo "installer failed:"; cat "$T/install.log"; exit 1; }
STABLE="$HOME_DIR/runtime/node_modules/@tui-games/tui"

check "relocated out of the temp directory" "$(cat "$T/install.log")" "Copied Tui to"
[[ -f "$STABLE/scripts/overlay.ts" ]] && ok "package landed at the stable root" || bad "package missing at $STABLE"
deps="$(ls "$HOME_DIR/runtime/node_modules/" | tr '\n' ' ')"
check "runtime dependencies came along" "$deps" "posthog-node"

echo
echo "2. Generated config points at the stable root, never the temp dir"
if grep -Fq "$SRC" "$CLAUDE/settings.json" "$CLAUDE/skills/arcade/SKILL.md" 2>/dev/null; then
  bad "a generated file still references the temp checkout"
else
  ok "no generated file references the temp checkout"
fi
check "SessionStart hook installed" "$(python3 -c "
import json;d=json.load(open('$CLAUDE/settings.json'));print(d['hooks']['SessionStart'][0]['hooks'][0]['command'])")" "overlay.ts' --reset"
check "nudge hook installed" "$(python3 -c "
import json;d=json.load(open('$CLAUDE/settings.json'));print(d['hooks']['UserPromptSubmit'][0]['hooks'][0]['command'])")" "plugin-update.ts' --nudge"

echo
echo "3. The SessionStart check runs and writes an update flag"
# GAMEPIGEON_HARNESS=claude is what run-with-bun.cjs sets from `--harness claude`.
if GAMEPIGEON_HOME="$HOME_DIR" GAMEPIGEON_HARNESS=claude \
     bun "$STABLE/scripts/plugin-update.ts" --check > "$T/check.log" 2>&1; then
  ok "update check exited cleanly"
else
  bad "update check failed:"; sed 's/^/        /' "$T/check.log"
fi
if [[ -f "$HOME_DIR/update-available.json" ]]; then
  ok "flag written: $(python3 -c "
import json;d=json.load(open('$HOME_DIR/update-available.json'));print(d['fromVersion'],'->',d['toVersion'])")"
else
  bad "NO FLAG WRITTEN — the check did not detect the newer release"
fi

echo
echo "4. The overlay would self-update (what checkAndAutoUpdate reads)"
GAMEPIGEON_HOME="$HOME_DIR" GAMEPIGEON_HARNESS=claude GAMEPIGEON_OVERLAY_DRY_RUN=1 \
  bun "$STABLE/scripts/overlay.ts" --reset > /dev/null 2>&1 || true
if [[ -f "$HOME_DIR/install-context.json" ]]; then
  plan="$(python3 -c "
import json;d=json.load(open('$HOME_DIR/install-context.json'))
print(d['updateMethod'],'|',' '.join(d['updateCommand'] or []))")"
  check "install classified as self-updatable" "$plan" "copied-adapter"
  check "runnable update command recorded" "$plan" "bun x @tui-games/tui@latest install --claude"
else
  bad "no install-context.json — the overlay would have nothing to run"
fi

echo
echo "5. The nudge names a command this install actually has"
nudge="$(GAMEPIGEON_HOME="$HOME_DIR" GAMEPIGEON_HARNESS=claude \
  bun "$STABLE/scripts/plugin-update.ts" --nudge \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['hookSpecificOutput']['additionalContext'])")"
check "nudge points at the installer, not the marketplace command" \
  "$nudge" "npx -y bun x @tui-games/tui@latest install --claude"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
