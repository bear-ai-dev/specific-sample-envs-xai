import { expect, test } from "bun:test";
import { replayArenaTrace } from "./replay.js";
import { RestaurantGame } from "./restaurant-game.js";
import { validateArenaTraceV3 } from "./trace.js";
import { WorkerOrchestrator } from "./worker-orchestrator.js";
import type { ActionEnvelope } from "./types.js";

test("native trace preserves real roles, inputs and replay checkpoints across variations", () => {
  for (const variation of ["dinner-rush", "quiet-tuesday", "saturday-night"]) {
    const game = new RestaurantGame(275, variation);
    game.step("sim_start");
    game.submitPlayerIntervention({ kind: "priority", targetRole: "supply_lead", orderId: "order-2", priority: "high" });
    // One manager envelope per round (#262), so the message needs the next one.
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
    expect(trace.events.find((event) => event.action?.tool === "coordinate")?.role).toBe("supply_lead");
    expect(trace.events.find((event) => event.action?.tool === "send_message")?.role).toBe("host");
    expect(replayArenaTrace(trace).checkpointState()).toEqual(game.checkpointState());
    const tampered = structuredClone(trace);
    tampered.replay.inputs.splice(1, 1);
    expect(() => replayArenaTrace(tampered)).toThrow("checkpoint mismatch");
    const wrongRoster = structuredClone(trace);
    (wrongRoster.initialState.workers as { role: string }[])[0]!.role = "inspector";
    expect(validateArenaTraceV3(wrongRoster).valid).toBe(false);
  }
});

test("external controllers suppress autonomous cooking, serving and seating; clock and cooking timers still progress", async () => {
  const game = new RestaurantGame();
  game.step("tick"); // Built-in chef starts cooking before control changes.
  const orchestrator = new WorkerOrchestrator(game, {
    client: { act: async (context) => ({
      version: "restaurant-arena-action/v1", episodeId: context.episodeId,
      actorId: context.actorId, actorType: "worker", role: context.role,
      tool: context.role === "host" ? "update_guest" : "inspect",
      arguments: context.role === "host" ? { message: "Please wait." } : { targetId: "oven-1" },
      tick: context.observation.tick, timestamp: "2026-09-05T00:00:00.000Z",
      requestId: `${context.role}-${context.observation.tick}`, idempotencyKey: `${context.role}-${context.observation.tick}`,
    }) },
  });
  const before = game.state();
  await orchestrator.runTick();
  await orchestrator.runTick();
  const after = game.state();
  expect(after.episode.tick).toBe(before.episode.tick + 2);
  expect(after.orders.some((order) => order.status === "ready")).toBe(true);
  expect(after.outcomes.completed).toBe(before.outcomes.completed);
  expect(after.orders.length).toBe(before.orders.length);
  expect(after.inventory).toEqual(before.inventory);
  expect(() => new WorkerOrchestrator(game, { client: { act: async () => { throw new Error("unused"); } } })).toThrow("already has");
  expect(replayArenaTrace(game.captureTrace({ runKind: "synthetic" })).checkpointState()).toEqual(game.checkpointState());
  game.reset();
  expect(replayArenaTrace(game.captureTrace({ runKind: "synthetic" })).checkpointState()).toEqual(game.checkpointState());
});

test("abandonment is distinct from completion and does not fabricate later events", () => {
  const game = new RestaurantGame();
  game.step("sim_start");
  game.step("tick");
  game.markAbandoned("user_quit");
  const trace = game.captureTrace({ runKind: "synthetic" });
  expect(trace.terminal).toEqual({ status: "abandoned", tick: 1, reason: "user_quit" });
  expect(trace.events.some((event) => event.kind === "outcome")).toBe(false);
  expect(replayArenaTrace(trace).getTerminalStatus()).toEqual(trace.terminal);
});

test("rejects malformed replay input payloads before native replay", () => {
  const game = new RestaurantGame();
  const trace = game.captureTrace({ runKind: "synthetic" });
  for (const input of [
    { ...trace, replay: { ...trace.replay, variation: "unknown" } },
    { ...trace, replay: { ...trace.replay, inputs: [{ kind: "envelope", tick: 0, stateHash: trace.replay.finalStateHash }] } },
    { ...trace, replay: { ...trace.replay, inputs: [{ kind: "controllers", tick: 0, stateHash: trace.replay.finalStateHash, roles: ["chef", "chef"] }] } },
  ]) {
    expect(validateArenaTraceV3(input).valid).toBe(false);
  }
});

test("replays historical v3 traces containing legacy expediter worker and inputs", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  game.step("tick");
  const trace = game.captureTrace({ runKind: "synthetic" });

  // Synthesize a historical v3 trace where initialState carries the legacy expediter worker
  const legacyTrace = structuredClone(trace);
  const workers = legacyTrace.initialState.workers as Array<{ id: string; role: string; [key: string]: unknown }>;
  legacyTrace.initialState.workers = workers.map((w) =>
    w.role === "supply_lead"
      ? { ...w, id: "worker-expediter", role: "expediter" as any }
      : w
  );

  const replayed = replayArenaTrace(legacyTrace);
  expect(replayed.state().episode.tick).toBe(game.state().episode.tick);
});

test("adapts legacy expediter action envelopes to supply_lead without leaking legacy role into captured trace", () => {
  const game = new RestaurantGame();
  game.step("sim_start");
  game.step("verify_substitution");

  const legacyEnvelope: ActionEnvelope = {
    version: "restaurant-arena-action/v1",
    episodeId: game.state().episode.id,
    actorId: "worker-expediter",
    actorType: "worker",
    role: "expediter" as any,
    tool: "coordinate",
    arguments: { orderId: "order-2", priority: "high" },
    tick: game.state().episode.tick,
    timestamp: "2026-09-06T00:00:00.000Z",
    requestId: "req-legacy-001",
    idempotencyKey: `${game.state().episode.id}:req-legacy-001`,
  };

  const result = game.stepEnvelope(legacyEnvelope);
  expect(result.accepted).toBe(true);

  // Trace capture must contain supply_lead and zero occurrences of expediter
  const trace = game.captureTrace({ runKind: "synthetic" });
  const traceJson = JSON.stringify(trace);
  expect(traceJson).not.toContain("expediter");
  expect(traceJson).toContain("supply_lead");

  const actionEvent = trace.events.find((e) => e.requestId === "req-legacy-001");
  expect(actionEvent?.role).toBe("supply_lead");
  expect(actionEvent?.actorId).toBe("worker-supply_lead");
});
