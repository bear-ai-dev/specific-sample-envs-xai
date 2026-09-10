#!/usr/bin/env bash
set -euo pipefail
OUT=/task/solution/solve.sh
SNAP=/task/.orig_snapshot

{
  echo '#!/usr/bin/env bash'
  echo '# Restores the responsive floor layout, staff corridor walking, and'
  echo '# drag-safe repaint gating for the Restaurant Arena overlay.'
  echo 'set -euo pipefail'
  echo 'cd "$(dirname "${BASH_SOURCE[0]}")/../environment/workspace" 2>/dev/null || cd /app'
  echo

  for f in overlay/restaurant-arena-layout.ts overlay/staff-walk.ts overlay/restaurant-arena-repaint-gate.ts overlay/restaurant-arena-scene.ts; do
    base="$(basename "$f")"
    echo "mkdir -p \"\$(dirname \"$f\")\""
    echo "cat > \"$f\" <<'ARENA_EOF_MARKER'"
    cat "$SNAP/$base"
    echo "ARENA_EOF_MARKER"
    echo
  done
} > "$OUT"

chmod +x "$OUT"
echo "wrote $OUT"
