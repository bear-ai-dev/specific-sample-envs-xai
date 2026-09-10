# Restaurant Arena trace capture / replay contract (v3)

This is the binding API and CLI surface for the restaurant-arena-trace-v3
pipeline described in the task instructions. `contracts/restaurant-arena-trace-v3.schema.json`
is the wire format; this document fixes the TypeScript entry points and exact
CLI wording that callers (including the existing overlay code and the
project's own tests) depend on.

## Capturing a trace

`RestaurantGame` must expose trace capture as an **instance method**, in
addition to (and delegating to) any standalone helper:

```ts
class RestaurantGame {
  captureTrace(options: TraceCaptureOptions): RestaurantArenaTraceV3;
}

interface TraceCaptureOptions {
  episodeId?: string;
  sessionId?: string;
  /** Required: live gameplay, synthetic episodes and benchmark episodes must stay distinguishable. */
  runKind: "live" | "synthetic" | "benchmark";
  envVersion?: string;
  startTime?: string;
  deletion?: Partial<{ requestId: string | null; status: "retained" | "requested" | "deleted" }>;
  /** Omit to capture the run's own recorded event journal; pass to replace it wholesale. */
  events?: TraceV3Event[];
  /**
   * Events the caller wants merged into the captured journal alongside the
   * game's own recorded events (e.g. an out-of-band player note). Each
   * caller-supplied event is stamped with the `round` its `tick` falls in,
   * using the same round-boundary rule as `roundForTick` in
   * `src/games/restaurant-arena/rounds.ts` (round r covers ticks 2r-1 and 2r;
   * tick 0 is round 1).
   */
  additionalEvents?: TraceV3Event[];
}
```

Existing callers such as `overlay/app.ts` already use a standalone
`captureArenaTrace(game, options)` helper with the same `TraceCaptureOptions`
shape; that helper must keep working exactly as today, and `game.captureTrace(options)`
is required as a thin instance-method wrapper around it (`captureTrace(options) { return captureArenaTrace(this, options); }`
satisfies both).

The captured `trace.terminal` field is whatever `game.getTerminalStatus()`
returns at capture time: the object `{ status, tick, reason }`, not just the
`status` string.

## Replaying a trace

```ts
function replayArenaTrace(trace: RestaurantArenaTraceV3): RestaurantGame;
```

`replayArenaTrace` rebuilds a live `RestaurantGame` from the captured record
and **returns that rebuilt game instance itself**, not a summary object, so a
caller can call the game's own methods directly on the result, e.g.
`replayArenaTrace(trace).checkpointState()`, `.state()`, or
`.getTerminalStatus()`.

Replay starts from a **freshly constructed** `RestaurantGame` for `trace.seed`
and `trace.replay.variation` — the same engine's own tick-0 state, not the
recorded `trace.initialState` taken on faith. Before applying any replay
input, `replayArenaTrace` must compare that freshly constructed game's own
initial state against `trace.initialState` (each canonicalized the same way,
see below) via `computeStateHash`, and throw if they disagree. This check is
independent of, and in addition to, the per-input checkpoint hashes and the
final-state hash carried in `trace.replay`: a `trace.initialState` that has
been altered in any field — including fields with no dedicated schema rule, e.g. `cash` — while keeping the same overall shape must still be rejected,
because it no longer matches what this engine's own seed actually produces at
tick 0, even though every individual field still parses.

The only initial-state divergence `replayArenaTrace` must tolerate is the
legacy `expediter` role/worker id in place of `supply_lead`: canonicalize
worker `role`/`id` on both the freshly constructed engine's initial state and
`trace.initialState` (mapping `expediter`/`worker-expediter` to
`supply_lead`/`worker-supply_lead`) before hashing and comparing them, so a
historical trace naming the legacy roster still passes this check and then
replays and reaches the identical terminal record (status, tick, and reason);
only the role name is legacy, not the worker's real behavior or the outcome
it produces.

It must throw if any checkpoint or state hash recorded in `trace.replay`
disagrees with what native replay actually produces, or if the recorded
`trace.terminal` disagrees with the terminal record native replay itself
reaches. That comparison covers the **whole** terminal record, not just the
`status` field: `status`, `tick`, and `reason` must all match exactly, e.g.

```ts
if (JSON.stringify(game.getTerminalStatus()) !== JSON.stringify(trace.terminal)) {
  throw new Error("terminal mismatch");
}
```

A trace whose `status` and `tick` are correct but whose `reason` has been
altered (or vice versa) is exactly as invalid as one whose `status` disagrees,
and `replayArenaTrace` must throw on it too.

## CLI scripts

- `bun scripts/export-arena-trace.ts` — captures a fresh benchmark trace for
  the fixture variation and writes it to
  `contracts/fixtures/restaurant-arena-trace-v3.json`. On success it must
  print a line containing the word `Wrote` (and the path it wrote).
- `bun scripts/export-arena-trace.ts --check` — captures the same trace
  without writing it, and compares it against the fixture already on disk.
  If they match, it must print a line containing the exact phrase
  `Fixture is current` and exit `0`. If they differ, it must exit non-zero.
- `bun scripts/replay-arena-trace.ts <path-to-trace.json-or-.jsonl>` — loads a
  trace file (accepting both the JSON export from `exportTraceJson` and the
  JSONL export from `exportTraceJsonl`), natively replays it, and validates it
  against `validateArenaTraceV3` and `replayArenaTrace`. On a fully passing
  replay it must print a line containing the exact phrase
  `Native replay passed` and exit `0`. On any validation failure, replay
  mismatch, or thrown error (e.g. a tampered or truncated trace) it must exit
  non-zero and must not print that phrase.

