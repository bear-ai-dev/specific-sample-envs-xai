#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$SCRIPT_DIR/solution.patch"

cd /app
patch -p1 --fuzz=0 < "$PATCH_FILE"

echo "solve.sh: applied solution.patch to /app"

