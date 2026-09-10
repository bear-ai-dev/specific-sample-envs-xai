import { expect, test } from "bun:test";
import { RestaurantGame } from "./restaurant-game.js";
import {
  validateArenaTraceV3,
  computeStateHash,
  exportTraceJson,
  exportTraceJsonl,
  type RestaurantArenaTraceV3,
} from "./trace.js";
import { replayArenaTrace } from "./replay.js";

function freshTrace(seed: number, variation?: string) {
  const game = new RestaurantGame(seed, variation);
  game.step("sim_start");
  for (let i = 0; i < 10; i++) game.step("tick");
  const trace = game.captureTrace({ runKind: "synthetic" });
  return { game, trace };
}

test("verifier: a full shift produces a schema-valid, natively-replayable trace", () => {
  for (const variation of ["dinner-rush", "quiet-tuesday", "saturday-night"]) {
    const game = new RestaurantGame(275, variation);
    game.step("sim_start");
    game.submitPlayerIntervention({ kind: "priority", targetRole: "supply_lead", orderId: "order-2", priority: "high" });
    game.step("tick");
    game.step("tick");
    game.submitPlayerIntervention({ kind: "message", targetRole: "host", text: "Please hold new arrivals while we catch up." });
    game.step("assign_server_kitchen");
    game.advanceTime();
    game.step("assign_server_floor");
    game.step("hold_seating");
    for (let i = 0; i < 10; i++) game.step("tick");
    game.step("inspect_oven");
    game.step("hold_seating");
    while (!game.isOver()) game.step("tick");

    const trace = game.captureTrace({ runKind: "synthetic" });
    expect(validateArenaTraceV3(trace)).toEqual({ valid: true, errors: [] });
    expect(replayArenaTrace(trace).checkpointState()).toEqual(game.checkpointState());

    const tampered = structuredClone(trace);
    tampered.replay.inputs.splice(1, 1);
    expect(() => replayArenaTrace(tampered)).toThrow();

    const wrongRoster = structuredClone(trace);
    (wrongRoster.initialState.workers as { role: string }[])[0]!.role = "inspector";
    expect(validateArenaTraceV3(wrongRoster).valid).toBe(false);

    const wrongTerminal = structuredClone(trace);
    wrongTerminal.terminal = { ...wrongTerminal.terminal, reason: "user_quit" };
    expect(() => replayArenaTrace(wrongTerminal)).toThrow();

    // A terminal record whose status and reason survive intact but whose
    // tick has been altered is exactly as invalid: every field of the
    // recorded terminal outcome must agree with what native replay reaches.
    const wrongTick = structuredClone(trace);
    wrongTick.terminal = { ...wrongTick.terminal, tick: wrongTick.terminal.tick + 1 };
    expect(() => replayArenaTrace(wrongTick)).toThrow();
  }
});

test("verifier: replays historical traces carrying the legacy expediter worker", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  game.step("tick");
  const trace = game.captureTrace({ runKind: "synthetic" });

  const legacyTrace = structuredClone(trace);
  const workers = legacyTrace.initialState.workers as Array<{ id: string; role: string; [key: string]: unknown }>;
  legacyTrace.initialState.workers = workers.map((w) =>
    w.role === "supply_lead" ? { ...w, id: "worker-expediter", role: "expediter" as any } : w,
  );

  const replayed = replayArenaTrace(legacyTrace);
  expect(replayed.state().episode.tick).toBe(game.state().episode.tick);
});

test("verifier: legacy expediter action envelopes normalize to supply_lead in a captured trace", () => {
  const game = new RestaurantGame();
  game.step("sim_start");
  game.step("verify_substitution");

  const legacyEnvelope = {
    version: "restaurant-arena-action/v1" as const,
    episodeId: game.state().episode.id,
    actorId: "worker-expediter",
    actorType: "worker" as const,
    role: "expediter" as any,
    tool: "coordinate" as const,
    arguments: { orderId: "order-2", priority: "high" as const },
    tick: game.state().episode.tick,
    timestamp: "2026-09-06T00:00:00.000Z",
    requestId: "req-legacy-verifier",
    idempotencyKey: `${game.state().episode.id}:req-legacy-verifier`,
  };

  const result = game.stepEnvelope(legacyEnvelope);
  expect(result.accepted).toBe(true);

  const trace = game.captureTrace({ runKind: "synthetic" });
  const traceJson = JSON.stringify(trace);
  expect(traceJson).not.toContain("expediter");
  expect(traceJson).toContain("supply_lead");
});

test("verifier: caller-supplied additionalEvents are stamped with the round they fall in", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  for (let i = 0; i < 6; i++) game.step("tick");

  const trace = game.captureTrace({
    runKind: "synthetic",
    additionalEvents: [
      {
        tick: 5,
        kind: "action",
        timestamp: new Date().toISOString(),
        stateHash: `sha256:${"0".repeat(64)}`,
        actorId: "player",
      },
      {
        tick: 0,
        kind: "action",
        timestamp: new Date().toISOString(),
        stateHash: `sha256:${"1".repeat(64)}`,
        actorId: "player-early",
      },
    ],
  });
  expect(validateArenaTraceV3(trace)).toEqual({ valid: true, errors: [] });
  expect(trace.events.every((e) => typeof e.round === "number")).toBe(true);
  expect(trace.events.find((e) => e.tick === 5 && e.actorId === "player")?.round).toBe(3);
  // Tick 0 is the opening manager envelope, before anything has advanced,
  // and reads as round 1 -- the same boundary rule the engine's own journal
  // stamps its events with, not just the mid-run case above.
  expect(trace.events.find((e) => e.tick === 0 && e.actorId === "player-early")?.round).toBe(1);
  // additionalEvents merge into the journal; they do not replace it. The
  // game's own recorded events must still be present in the captured trace.
  expect(trace.events.some((e) => e.actorId !== "player" && e.actorId !== "player-early")).toBe(true);
});

test("verifier: JSON and JSONL exporters both round-trip a captured trace losslessly", () => {
  const { trace } = freshTrace(303, "quiet-tuesday");

  const json = exportTraceJson(trace);
  const parsedJson = JSON.parse(json);
  expect(parsedJson).toEqual(trace);

  const jsonl = exportTraceJsonl(trace);
  const lines = jsonl.trim().split("\n").map((line) => JSON.parse(line));
  const [header, ...events] = lines;
  const reconstructed = { ...header, events };
  expect(reconstructed).toEqual(trace);
  expect(validateArenaTraceV3(reconstructed)).toEqual({ valid: true, errors: [] });
});

test("verifier: validateArenaTraceV3 rejects malformed traces across independent field families", () => {
  const { trace } = freshTrace(281, "dinner-rush");
  const base = trace as RestaurantArenaTraceV3;
  expect(validateArenaTraceV3(base).valid).toBe(true);

  const cases: Array<[string, unknown]> = [
    ["not an object", "nope"],
    ["disallowed root key", { ...structuredClone(base), extra: 1 }],
    ["wrong version", { ...structuredClone(base), version: "restaurant-arena-trace/v2" }],
    ["bad episodeId", { ...structuredClone(base), episodeId: "" }],
    ["wrong contractVersion", { ...structuredClone(base), contractVersion: "restaurant-arena/v2" }],
    ["invalid runKind", { ...structuredClone(base), runKind: "test" }],
    ["missing terminal", (() => { const c = structuredClone(base) as any; delete c.terminal; return c; })()],
    ["missing deletion", (() => { const c = structuredClone(base) as any; delete c.deletion; return c; })()],
    ["bad deletion status", { ...structuredClone(base), deletion: { requestId: null, status: "gone" } }],
    ["bad deletion.requestId format", { ...structuredClone(base), deletion: { requestId: "!!not-an-id!!", status: "requested" } }],
    ["unknown replay variation", { ...structuredClone(base), replay: { ...structuredClone(base).replay, variation: "unknown-shift" } }],
    ["bad final state hash", { ...structuredClone(base), replay: { ...structuredClone(base).replay, finalStateHash: "not-a-hash" } }],
    ["events not an array", { ...structuredClone(base), events: {} }],
    ["event with disallowed key", (() => { const c = structuredClone(base) as any; c.events[0].bogus = true; return c; })()],
    ["event with invalid kind", (() => { const c = structuredClone(base) as any; c.events[0].kind = "not-a-kind"; return c; })()],
    ["event with bad stateHash", (() => { const c = structuredClone(base) as any; c.events[0].stateHash = "sha1:abc"; return c; })()],
    ["toolResult failure without error body", (() => { const c = structuredClone(base) as any; c.events[0].toolResult = { ok: false }; return c; })()],
    ["toolResult carries error but ok true", (() => { const c = structuredClone(base) as any; c.events[0].toolResult = { ok: true, error: { code: "x", message: "y" } }; return c; })()],
    ["event.model missing provider", (() => { const c = structuredClone(base) as any; c.events[0].model = { name: "worker-model" }; return c; })()],
    ["event.model has disallowed key", (() => { const c = structuredClone(base) as any; c.events[0].model = { provider: "p", name: "n", extra: 1 }; return c; })()],
    ["event.subject has invalid kind", (() => { const c = structuredClone(base) as any; c.events[0].subject = { kind: "bogus", id: "order-1" }; return c; })()],
    ["event.subject has disallowed key", (() => { const c = structuredClone(base) as any; c.events[0].subject = { kind: "order", id: "order-1", extra: true }; return c; })()],
    ["event.idempotencyKey malformed", (() => { const c = structuredClone(base) as any; c.events[0].idempotencyKey = "!!bad!!"; return c; })()],
    ["root sessionId malformed", { ...structuredClone(base), sessionId: "!!bad!!" }],
    ["replay input with duplicate controller roles", (() => {
      const c = structuredClone(base) as any;
      c.replay.inputs.push({ kind: "controllers", tick: 0, stateHash: `sha256:${"0".repeat(64)}`, roles: ["chef", "chef"] });
      return c;
    })()],
    ["replay input with malformed restaurantStateHash", (() => {
      const c = structuredClone(base) as any;
      c.replay.inputs[0].restaurantStateHash = "not-a-hash";
      return c;
    })()],
  ];

  for (const [label, candidate] of cases) {
    const result = validateArenaTraceV3(candidate);
    expect(result.valid, `expected invalid for: ${label}`).toBe(false);
  }
});

test("verifier: computeStateHash is deterministic and canonical", () => {
  const a = computeStateHash({ b: 1, a: 2, cash: 5 });
  const b = computeStateHash({ a: 2, b: 1, cash: 5 });
  expect(a).toBe(b);
  expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("verifier: captureTrace requires an explicit, valid runKind", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  expect(() => game.captureTrace({} as any)).toThrow();
  expect(() => game.captureTrace({ runKind: "not-a-kind" } as any)).toThrow();
  expect(() => game.captureTrace({ runKind: "live" })).not.toThrow();
});

test("verifier: replayArenaTrace rejects a trace whose recorded final state hash was tampered", () => {
  const { trace } = freshTrace(404, "dinner-rush");
  const tampered = structuredClone(trace);
  tampered.replay.finalStateHash = `sha256:${"f".repeat(64)}`;
  expect(() => replayArenaTrace(tampered)).toThrow();
});

test("verifier: replayArenaTrace rejects a tick-0 state that was altered without changing its shape", () => {
  const { trace } = freshTrace(405, "dinner-rush");
  const tampered = structuredClone(trace);
  const initial = tampered.initialState as Record<string, unknown> & { cash: number };
  initial.cash = (initial.cash ?? 0) + 999;
  expect(() => replayArenaTrace(tampered)).toThrow();
});

test("verifier: native replay correctly walks time and external-controller inputs, not just steps", () => {
  const game = new RestaurantGame(406, "dinner-rush");
  game.step("sim_start");
  game.setExternalControllers(["host"]);
  game.advanceTime();
  game.advanceTime();
  game.step("tick");

  const trace = game.captureTrace({ runKind: "synthetic" });
  expect(validateArenaTraceV3(trace)).toEqual({ valid: true, errors: [] });
  expect(trace.replay.inputs.some((input) => input.kind === "time")).toBe(true);
  expect(trace.replay.inputs.some((input) => input.kind === "controllers")).toBe(true);

  const replayed = replayArenaTrace(trace);
  expect(replayed.checkpointState()).toEqual(game.checkpointState());
  expect(replayed.state().episode.tick).toBe(game.state().episode.tick);
  expect(replayed.getTerminalStatus()).toEqual(game.getTerminalStatus());
});

