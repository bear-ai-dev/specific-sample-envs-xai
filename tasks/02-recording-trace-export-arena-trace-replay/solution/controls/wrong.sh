#!/usr/bin/env bash
# A materially wrong "implementation": the CLI scripts and captureTrace exist
# and the happy path even produces something JSON-shaped, but the validator
# accepts anything and native replay never actually checks a checkpoint. This
# must score 0.
set -euo pipefail
WORKDIR="${TASK_WORKDIR:-/app}"
cd "$WORKDIR"

bun - <<'NODE'
const fs = require("fs");
const p = "src/games/restaurant-arena/trace.ts";
let s = fs.readFileSync(p, "utf8");
s = s.replace(
  /export function validateArenaTraceV3\(data: unknown\): ValidationResult \{[\s\S]*?\n  return \{\n    valid: errors\.length === 0,\n    errors,\n  \};\n\}/,
  `export function validateArenaTraceV3(data: unknown): ValidationResult {
  return { valid: true, errors: [] };
}`
);
fs.writeFileSync(p, s);
NODE

bun - <<'NODE'
const fs = require("fs");
const p = "src/games/restaurant-arena/replay.ts";
let s = fs.readFileSync(p, "utf8");
s = s.replace(
  /export function applyArenaReplayInput\(game: RestaurantGame, input: ArenaInputRecord, index: number\): void \{[\s\S]*?\n\}/,
  `export function applyArenaReplayInput(game: RestaurantGame, input: ArenaInputRecord, index: number): void {
    switch (input.kind) {
      case "step":
        game.step(input.action);
        break;
      case "time":
        game.advanceTime();
        break;
      case "envelope":
        game.stepEnvelope(input.envelope, input.telemetry);
        break;
      case "controllers":
        game.setExternalControllers(input.roles);
        break;
    }
}`
);
fs.writeFileSync(p, s);
NODE

echo "wrong control applied"

