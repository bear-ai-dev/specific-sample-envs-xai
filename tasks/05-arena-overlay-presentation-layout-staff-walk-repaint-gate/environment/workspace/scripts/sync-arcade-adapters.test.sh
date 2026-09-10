#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

# Every harness home must be sandboxed for the whole run, for the same reason
# install-adapters.test.sh exports them: these default to the developer's real
# config when unset, and one forgotten override rewrites the actual ~/.codex.
export AGENTS_HOME="$TEMP_DIR/homes/agents"
export CODEX_HOME="$TEMP_DIR/homes/codex"
export CLAUDE_CONFIG_DIR="$TEMP_DIR/homes/claude"
export OPENCODE_CONFIG_DIR="$TEMP_DIR/homes/opencode"
export HERMES_HOME="$TEMP_DIR/homes/hermes"
export OPENCLAW_HOME="$TEMP_DIR/homes/openclaw"
export GAMEPIGEON_WORKSPACE_DIR="$TEMP_DIR/homes/antigravity"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# A throwaway checkout with a linked worktree, so the worktree-resolution
# behaviour can be asserted without touching the real repository.
REPO="$TEMP_DIR/repo"
mkdir -p "$REPO/scripts"
git init -q "$REPO"
git -C "$REPO" config user.email "test@example.com"
git -C "$REPO" config user.name "Test"

cp "$ROOT_DIR/scripts/sync-arcade-adapters.sh" "$REPO/scripts/"
cp "$ROOT_DIR/scripts/install-git-hooks.sh" "$REPO/scripts/"

# Stand in for install-adapters.sh: records the directory it was run from, which
# is the value the real installer would bake into all six adapters.
cat > "$REPO/scripts/install-adapters.sh" <<'EOF'
#!/usr/bin/env bash
echo "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) $*" >> "$SYNC_LOG"
EOF
# Committed non-executable on purpose: the real installer is mode 100644 in
# some checkouts, and this is what regressed the hook into a silent no-op.
chmod 644 "$REPO/scripts/install-adapters.sh"

git -C "$REPO" add -A
git -C "$REPO" commit -qm "seed"

export SYNC_LOG="$TEMP_DIR/sync.log"
: > "$SYNC_LOG"

# 1. Runs the installer from the main checkout, despite a missing exec bit.
(cd "$REPO" && bash scripts/sync-arcade-adapters.sh)
[[ -s "$SYNC_LOG" ]] || fail "sync did not run the installer (exec-bit regression)"
grep -Fq "$REPO --all" "$SYNC_LOG" || fail "sync did not default to --all from the main checkout"

# 2. From a linked worktree it must still resolve the MAIN checkout, not the
#    worktree: the installer bakes this path into every adapter, and a worktree
#    path dies with the worktree.
WORKTREE="$TEMP_DIR/linked"
git -C "$REPO" worktree add -q "$WORKTREE" -b linked
: > "$SYNC_LOG"
(cd "$WORKTREE" && bash scripts/sync-arcade-adapters.sh)
grep -Fq "$REPO --all" "$SYNC_LOG" || fail "sync resolved the worktree instead of the main checkout"
if grep -Fq "$WORKTREE " "$SYNC_LOG"; then
  fail "sync baked a worktree path into the adapters"
fi

# 3. Explicit flags pass through instead of --all.
: > "$SYNC_LOG"
(cd "$REPO" && bash scripts/sync-arcade-adapters.sh --codex)
grep -Fq "$REPO --codex" "$SYNC_LOG" || fail "sync did not forward its arguments"

# 4. A checkout with no installer is a no-op, not an error.
: > "$SYNC_LOG"
mv "$REPO/scripts/install-adapters.sh" "$TEMP_DIR/installer.bak"
(cd "$REPO" && bash scripts/sync-arcade-adapters.sh) || fail "sync failed instead of no-opping without an installer"
[[ ! -s "$SYNC_LOG" ]] || fail "sync ran something without an installer present"
mv "$TEMP_DIR/installer.bak" "$REPO/scripts/install-adapters.sh"

# 5. install-git-hooks.sh installs both hooks, and a commit in the LINKED
#    worktree still syncs from the main checkout.
(cd "$REPO" && bash scripts/install-git-hooks.sh >/dev/null)
for hook in post-commit post-merge; do
  [[ -x "$REPO/.git/hooks/$hook" ]] || fail "$hook was not installed"
done

: > "$SYNC_LOG"
(cd "$WORKTREE" && echo change > file.txt && git add -A && git commit -qm "hooked")
grep -Fq "$REPO --all" "$SYNC_LOG" || fail "post-commit in a worktree did not sync from the main checkout"

# 6. Refuses to clobber a hook it did not write.
echo '#!/usr/bin/env bash' > "$REPO/.git/hooks/post-commit"
if (cd "$REPO" && bash scripts/install-git-hooks.sh >/dev/null 2>&1); then
  fail "install-git-hooks replaced a foreign hook"
fi

# 7. --uninstall removes only its own hooks.
(cd "$REPO" && bash scripts/install-git-hooks.sh --uninstall >/dev/null)
[[ -f "$REPO/.git/hooks/post-commit" ]] || fail "--uninstall removed a foreign hook"
[[ ! -f "$REPO/.git/hooks/post-merge" ]] || fail "--uninstall left its own hook behind"
rm -f "$REPO/.git/hooks/post-commit"

# 8. The hook's fallback must survive git older than 2.31, where
#    --path-format=absolute does not exist. A bare ".git" fallback breaks in a
#    linked worktree, because there .git is a file and ".git/.." is not a
#    directory, so the sync would silently never run.
LEGACY_BIN="$TEMP_DIR/legacy-bin"
mkdir -p "$LEGACY_BIN"
REAL_GIT="$(command -v git)"
cat > "$LEGACY_BIN/git" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  if [ "\$arg" = "--path-format=absolute" ]; then
    echo "fatal: unknown option \\\`path-format=absolute'" >&2
    exit 129
  fi
done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$LEGACY_BIN/git"

PATH="$LEGACY_BIN:$PATH" git --version >/dev/null || fail "legacy git shim is not runnable"
if PATH="$LEGACY_BIN:$PATH" git rev-parse --path-format=absolute --git-common-dir >/dev/null 2>&1; then
  fail "legacy git shim did not reject --path-format"
fi

(cd "$REPO" && PATH="$LEGACY_BIN:$PATH" bash scripts/install-git-hooks.sh >/dev/null)

# Force the fallback: blank the baked path so the hook has to re-resolve.
for hook in post-commit post-merge; do
  sed -i.bak "s|^sync=\".*\"$|sync=\"$TEMP_DIR/moved-away/sync.sh\"|" "$REPO/.git/hooks/$hook"
  rm -f "$REPO/.git/hooks/$hook.bak"
done

: > "$SYNC_LOG"
(cd "$WORKTREE" && echo legacy > legacy.txt && git add -A &&
  PATH="$LEGACY_BIN:$PATH" git commit -qm "legacy git")
grep -Fq "$REPO --all" "$SYNC_LOG" ||
  fail "hook fallback did not sync on pre-2.31 git from a linked worktree"

(cd "$REPO" && bash scripts/install-git-hooks.sh --uninstall >/dev/null) || true
rm -f "$REPO/.git/hooks/post-commit" "$REPO/.git/hooks/post-merge"

# 9. A relative core.hooksPath is resolved by git per worktree, so the install
#    covers only the worktree it ran in. That must be said out loud, not
#    reported as a repository-wide install.
git -C "$REPO" config core.hooksPath .githooks
warning_output="$(cd "$REPO" && bash scripts/install-git-hooks.sh 2>&1 >/dev/null)"
case "$warning_output" in
  *"resolves it per worktree"*) ;;
  *) fail "relative core.hooksPath installed without warning about worktree scope" ;;
esac
[[ -x "$REPO/.githooks/post-commit" ]] || fail "relative core.hooksPath hook was not installed"
git -C "$REPO" config --unset core.hooksPath

echo "sync-arcade-adapters.test.sh: all checks passed"
