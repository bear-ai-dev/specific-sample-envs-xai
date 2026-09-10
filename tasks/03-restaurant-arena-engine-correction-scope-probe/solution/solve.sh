#!/usr/bin/env bash
# Applies the source-only restoration of standing player directives and the
# warming-shelf scope-control probe on top of the feature-removed workspace.
set -euo pipefail

cd "${SOLVER_WORKDIR:-/app}"

PATCH_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/solution.patch"

patch -p1 --forward -s < "$PATCH_PATH"

echo "solve.sh: applied solution.patch"

