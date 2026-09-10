#!/usr/bin/env bash
set -euo pipefail

# Re-install the Tui adapters so every harness points at this checkout.
#
# Intended as the body of a post-commit / post-merge hook: edit an adapter,
# commit, and the installed copies stop being stale. `scripts/install-git-hooks.sh`
# wires it up. Safe to run by hand, and takes the same flags as
# install-adapters.sh (default: --all).
#
# Resolving the checkout is the whole reason this script exists.
# install-adapters.sh bakes its ROOT_DIR into all six generated adapters, and
# git hooks live in $GIT_COMMON_DIR/hooks, so a single hook is shared by the
# main checkout and every linked worktree. A hook that resolved the root with
# `--show-toplevel` would therefore rewire all six harnesses to whichever
# worktree the commit happened in, and the moment that worktree is removed the
# adapters point into nothing. install-adapters.sh describes the result: Tui
# "fails silently on every prompt with no error surface".
#
# `--git-common-dir` always names the main checkout's .git even from inside a
# linked worktree, so its parent is the directory that outlives worktrees.

resolve_root() {
  local common_dir
  # --path-format needs git 2.31; older git returns a bare ".git" relative to
  # the top level, so fall back to resolving it against --show-toplevel.
  if common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
    :
  else
    common_dir="$(git rev-parse --git-common-dir)"
    case "$common_dir" in
      /*) ;;
      *) common_dir="$(git rev-parse --show-toplevel)/$common_dir" ;;
    esac
  fi
  (cd "$(dirname "$common_dir")" && pwd)
}

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "sync-arcade-adapters: not inside a git checkout; nothing to sync" >&2
  exit 0
fi

ROOT_DIR="$(resolve_root)"
installer="$ROOT_DIR/scripts/install-adapters.sh"

if [[ ! -f "$installer" ]]; then
  echo "sync-arcade-adapters: no installer at $installer; nothing to sync" >&2
  exit 0
fi

# Invoked through bash rather than executed: the installer is committed 100644
# in some checkouts, and an exec-bit assumption turns this into a silent no-op.
exec bash "$installer" "${@:---all}"
