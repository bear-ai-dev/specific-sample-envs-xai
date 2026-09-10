#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="${1:-}"

usage() {
  cat <<'EOF' >&2
Usage: scripts/dev-harness.sh {claude|codex|antigravity|prepare}

Shared local overlay development launcher:
  prepare      Build overlay web bundle + debug Tauri shell and export dev env
  claude       prepare + claude --plugin-dir .
  codex        prepare + workspace plugin + Codex adapter + codex
  antigravity  prepare + workspace plugin + agy
EOF
  exit 2
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

prepare_overlay() {
  require_command bun
  require_command cargo
  if [[ ! -f "$ROOT_DIR/node_modules/@tauri-apps/api/package.json" ]]; then
    (cd "$ROOT_DIR" && bun install)
  fi
  (cd "$ROOT_DIR" && bun run build:overlay:web)
  cargo build --manifest-path "$ROOT_DIR/tauri/Cargo.toml"
  export GAMEPIGEON_OVERLAY_BIN="$ROOT_DIR/tauri/target/debug/gamepigeon-overlay"
  export GAMEPIGEON_SKIP_UPDATE_CHECK=1
  bun "$ROOT_DIR/scripts/overlay.ts" --quit
}

ensure_codex_plugin() {
  bash "$ROOT_DIR/scripts/materialize-agents-plugin.sh"
  bash "$ROOT_DIR/scripts/install-adapters.sh" --codex
  require_command codex

  if ! codex plugin marketplace list 2>/dev/null | grep -Fq "$ROOT_DIR"; then
    codex plugin marketplace add "$ROOT_DIR" >/dev/null
  fi

  if ! codex plugin list 2>/dev/null | grep -Fq 'tui-gamepigeon@tui-gamepigeon-dev'; then
    codex plugin add tui-gamepigeon@tui-gamepigeon-dev >/dev/null
  fi
}

ensure_antigravity_plugin() {
  bash "$ROOT_DIR/scripts/materialize-agents-plugin.sh"
}

case "$HARNESS" in
  prepare)
    prepare_overlay
    ;;
  claude)
    prepare_overlay
    require_command claude
    exec claude --plugin-dir "$ROOT_DIR"
    ;;
  codex)
    prepare_overlay
    ensure_codex_plugin
    exec codex
    ;;
  antigravity)
    prepare_overlay
    ensure_antigravity_plugin
    require_command agy
    exec agy
    ;;
  *)
    usage
    ;;
esac
