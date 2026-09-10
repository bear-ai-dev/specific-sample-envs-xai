import { readFileSync } from "node:fs";
import { replayArenaTrace } from "../src/games/restaurant-arena/replay.js";
import type { RestaurantArenaTraceV3 } from "../src/games/restaurant-arena/trace.js";

export function readArenaTrace(path: string): RestaurantArenaTraceV3 {
  const text = readFileSync(path, "utf8");
  if (!path.endsWith(".jsonl")) return JSON.parse(text);
  const [header, ...events] = text.trim().split("\n").map((line) => JSON.parse(line));
  return { ...header, events };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun scripts/replay-arena-trace.ts <trace.json|trace.jsonl>");
  const trace = readArenaTrace(path);
  const game = replayArenaTrace(trace);
  console.log(`Native replay passed: ${trace.replay.inputs.length} inputs, tick ${game.state().episode.tick}, ${trace.terminal.status}, ${trace.replay.finalStateHash}`);
}
