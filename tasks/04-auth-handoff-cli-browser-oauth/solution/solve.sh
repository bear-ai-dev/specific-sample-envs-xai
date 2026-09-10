#!/usr/bin/env bash
# Applies the source-only OAuth handoff implementation on top of the
# feature-removed workspace. Run as the non-root `agent` user with the
# repository root ($GAMEPIGEON workdir, normally /app) as the cwd.
set -euo pipefail

repo_root="${1:-$(pwd)}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$repo_root"
patch -p1 --no-backup-if-mismatch < "$script_dir/solution.patch"

echo "Applied OAuth handoff solution to $repo_root"

