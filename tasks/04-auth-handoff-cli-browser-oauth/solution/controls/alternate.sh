#!/usr/bin/env bash
# Control: applies a differently-structured but equally faithful OAuth
# handoff implementation (Set-based Arc bundle check, hand-rolled query
# parsing, and swapped provider/next validation order in the worker) to
# prove the verifier rewards behavior, not one specific code shape.
set -euo pipefail

repo_root="${1:-$(pwd)}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$repo_root"
patch -p1 --no-backup-if-mismatch < "$script_dir/alternate.patch"

echo "Applied alternate OAuth handoff implementation to $repo_root"

