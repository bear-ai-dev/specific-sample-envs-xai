#!/usr/bin/env bash
# An alternate, behaviorally-equivalent implementation of a couple of the
# restored functions, written with different internal structure than the
# reference solution (loop-based instead of map/filter-based). Must still
# score 1.
set -euo pipefail
WORKDIR="${TASK_WORKDIR:-/app}"
cd "$WORKDIR"

bun - <<'NODE'
const fs = require("fs");
const p = "src/games/restaurant-arena/trace.ts";
let s = fs.readFileSync(p, "utf8");

s = s.replace(
  `  events = events.map((event) => (event.round === undefined ? { ...event, round: roundForTick(event.tick) } : event));`,
  `  const stampedEvents: TraceV3Event[] = [];
  for (const event of events) {
    stampedEvents.push(event.round === undefined ? { ...event, round: roundForTick(event.tick) } : event);
  }
  events = stampedEvents;`
);

s = s.replace(
  `export function selectFailedEvents(trace: RestaurantArenaTraceV3): TraceV3Event[] {
  return trace.events.filter((event) => event.toolResult?.ok === false);
}`,
  `export function selectFailedEvents(trace: RestaurantArenaTraceV3): TraceV3Event[] {
  const failed: TraceV3Event[] = [];
  for (const event of trace.events) {
    if (event.toolResult?.ok === false) failed.push(event);
  }
  return failed;
}`
);

fs.writeFileSync(p, s);
NODE

echo "alternate control applied"

