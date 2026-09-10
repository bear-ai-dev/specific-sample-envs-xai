#!/usr/bin/env bash
# solve.sh already applied the reference solution.patch in this container.
# Revert it back to the feature-removed state, then apply a plausible-looking
# but incorrect implementation: it adds the expected method names but they
# are no-op stubs that never enforce anything or classify probe evidence.
# Confirms the verifier still scores 0 for work that only looks done.
set -euo pipefail

cd "${SOLVER_WORKDIR:-/app}"

CONTROLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLUTION_PATCH="$CONTROLS_DIR/../solution.patch"
WRONG_PATCH="$CONTROLS_DIR/wrong.patch"

patch -p1 --forward -R -s < "$SOLUTION_PATCH"
patch -p1 --forward -s < "$WRONG_PATCH"

echo "wrong.sh: reverted solution.patch and applied wrong.patch"

