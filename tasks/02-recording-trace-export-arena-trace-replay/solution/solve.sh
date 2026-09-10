#!/usr/bin/env bash
# Applies the source-only fix that restores restaurant-arena trace capture,
# validation, export and native replay verification. Runs as the non-root
# agent user against the baked workspace at $TASK_WORKDIR (default /app).
set -euo pipefail

WORKDIR="${TASK_WORKDIR:-/app}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$WORKDIR"
patch -p1 --no-backup-if-mismatch < "${SCRIPT_DIR}/solution.patch"

