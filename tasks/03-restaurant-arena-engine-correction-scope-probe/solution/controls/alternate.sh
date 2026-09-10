#!/usr/bin/env bash
# solve.sh already applied the reference solution.patch in this container.
# Revert it back to the feature-removed state, then apply a deliberately
# different, but behaviorally faithful, reimplementation of the same
# standing-correction and scope-probe feature: no scope-probe.ts module,
# different internal field and id naming, keyword checks instead of
# regexes. Confirms the verifier rewards a distinct valid design, not just
# the reference implementation's exact shape.
set -euo pipefail

cd "${SOLVER_WORKDIR:-/app}"

CONTROLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLUTION_PATCH="$CONTROLS_DIR/../solution.patch"
ALT_PATCH="$CONTROLS_DIR/alternate.patch"

patch -p1 --forward -R -s < "$SOLUTION_PATCH"
patch -p1 --forward -s < "$ALT_PATCH"

echo "alternate.sh: reverted solution.patch and applied alternate.patch"

