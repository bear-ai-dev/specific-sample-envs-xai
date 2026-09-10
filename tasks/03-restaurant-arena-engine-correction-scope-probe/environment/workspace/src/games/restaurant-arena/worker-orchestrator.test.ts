import { describe, expect, it } from "bun:test";
import { RestaurantGame } from "./restaurant-game.js";
import { TURN_ORDER, WorkerOrchestrator } from "./worker-orchestrator.js";
import type { ActionContext } from "./worker-client.js";

const actions = {
  host: { tool: "update_guest", arguments: { message: "A table is being cleared now." } },
  supply_lead: { tool: "coordinate", arguments: { workerId: "worker-chef", orderId: "order-2", priority: "high" } },
  get expediter() {
    return this.supply_lead;
  },
  chef: { tool: "prepare", arguments: { orderId: "order-2" } },
  server: { tool: "serve", arguments: { tableId: "table-1", orderId: "order-1" } },
} as const;

function clientThatActs(seen: ActionContext[] = []) {
  let id = 0;
  return {
    act: async (context: ActionContext) => {
      seen.push(context);
      const action = actions[context.role as keyof typeof actions];
      id += 1;
      return {
        version: "restaurant-arena-action/v1" as const,
        episodeId: context.episodeId,
        actorId: context.actorId,
        actorType: "worker" as const,
        role: context.role,
        tool: action.tool,
        arguments: action.arguments,
        tick: context.observation.tick,
        timestamp: "2026-09-03T00:00:00.000Z",
        requestId: `model-${id}`,
        idempotencyKey: `${context.episodeId}:model-${id}`,
      };
    },
  };
}

async function waitForMicrotasksUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
}

describe("WorkerOrchestrator (#250)", () => {
  it("queries all workers, applies actions through envelopes, then advances one tick", async () => {
    const game = new RestaurantGame();
    const seen: ActionContext[] = [];
    const orchestrator = new WorkerOrchestrator(game, { client: clientThatActs(seen) });

    const report = await orchestrator.runTick();

    expect(report.advanced).toBe(true);
    expect(report.turns.map((turn) => [turn.role, turn.status])).toEqual([
      ["host", "accepted"], ["supply_lead", "accepted"], ["chef", "accepted"], ["server", "accepted"],
    ]);
    expect(seen.map((context) => context.observation.tick)).toEqual([0, 0, 0, 0]);
    expect(game.state().episode.tick).toBe(1);
    expect(game.state().workers.find((worker) => worker.role === "chef")?.lastAction).toContain("prepare");
  });

  it("uses safe fallbacks and still advances when a model request fails or action is rejected", async () => {
    const game = new RestaurantGame();
    let calls = 0;
    const orchestrator = new WorkerOrchestrator(game, {
      client: {
        act: async (context) => {
          calls += 1;
          if (context.role === "host") throw new Error("API unavailable");
          if (context.role === "chef") return {
            version: "restaurant-arena-action/v1", episodeId: context.episodeId, actorId: context.actorId,
            actorType: "worker", role: "chef", tool: "prepare", arguments: { orderId: "order-2" },
            tick: context.observation.tick - 1, timestamp: "2026-09-03T00:00:00.000Z", requestId: "stale", idempotencyKey: "stale",
          };
          return clientThatActs().act(context);
        },
      },
      requestId: () => `fallback-${calls}`,
      model: { provider: "test", name: "worker-model" },
    });

    const report = await orchestrator.runTick();

    expect(report.advanced).toBe(true);
    expect(report.turns.find((turn) => turn.role === "host")?.status).toBe("fallback");
    expect(report.turns.find((turn) => turn.role === "chef")?.status).toBe("fallback");
    expect(game.state().episode.tick).toBe(1);
    const fallbackIds = new Set(report.turns.filter((turn) => turn.status === "fallback").map((turn) => turn.action?.requestId));
    const fallbackEvents = game.getRecordedEvents().filter((event) => event.requestId && fallbackIds.has(event.requestId));
    expect(fallbackEvents.every((event) => event.model === undefined)).toBe(true);
  });

  it("records the client's reported metrics, plus roundMs, on the accepted trace event", async () => {
    const game = new RestaurantGame();
    const metrics = { queueMs: 5, providerMs: 220, inputTokens: 500, outputTokens: 30, cachedInputTokens: 400, finishReason: "stop" };
    const orchestrator = new WorkerOrchestrator(game, {
      client: {
        act: (context) => clientThatActs().act(context),
        lastMetrics: () => metrics,
      },
      model: { provider: "test", name: "worker-model" },
    });

    await orchestrator.runTick();

    const hostEvent = game.getRecordedEvents().find((event) => event.role === "host" && event.kind === "action");
    expect(hostEvent?.toolResult).toMatchObject({
      queueMs: 5,
      providerMs: 220,
      inputTokens: 500,
      outputTokens: 30,
      cachedInputTokens: 400,
      finishReason: "stop",
    });
    expect(hostEvent?.toolResult?.roundMs).toBeGreaterThanOrEqual(0);
  });

  it("grows roundMs across the round while latencyMs stays per-worker", async () => {
    const game = new RestaurantGame();
    let clock = 0;
    const acting = clientThatActs();
    const orchestrator = new WorkerOrchestrator(game, {
      client: {
        act: async (context) => {
          clock += 100;
          return acting.act(context);
        },
      },
      elapsedMs: () => clock,
    });

    await orchestrator.runTick();

    const events = TURN_ORDER.map((role) => game.getRecordedEvents().find((event) => event.role === role && event.kind === "action"));
    expect(events.map((event) => event?.toolResult?.latencyMs)).toEqual([100, 100, 100, 100]);
    expect(events.map((event) => event?.toolResult?.roundMs)).toEqual([100, 200, 300, 400]);
  });

  it("leaves metrics fields absent when the client reports none", async () => {
    const game = new RestaurantGame();
    const orchestrator = new WorkerOrchestrator(game, { client: clientThatActs() });

    await orchestrator.runTick();

    const hostEvent = game.getRecordedEvents().find((event) => event.role === "host" && event.kind === "action");
    expect(hostEvent?.toolResult?.queueMs).toBeUndefined();
    expect(hostEvent?.toolResult?.tokens).toBeUndefined();
  });

  it("does not start a tick while paused for a player intervention", async () => {
    const game = new RestaurantGame();
    const orchestrator = new WorkerOrchestrator(game, { client: clientThatActs() });

    orchestrator.intervene(() => game.step("prioritize_allergy"));
    const report = await orchestrator.runTick();

    expect(orchestrator.isPaused()).toBe(true);
    expect(report).toMatchObject({ advanced: false, paused: true, turns: [] });
    expect(game.state().episode.tick).toBe(0);
    orchestrator.resume();
    expect((await orchestrator.runTick()).advanced).toBe(true);
  });

  it("resumes a partially completed round without replaying accepted worker actions", async () => {
    const game = new RestaurantGame();
    const calls: string[] = [];
    let aborts = 0;
    let releaseSupplyLead: (() => void) | undefined;
    const supplyLeadRequest = new Promise<void>((resolve) => {
      releaseSupplyLead = resolve;
    });
    const orchestrator = new WorkerOrchestrator(game, {
      client: {
        abort: () => { aborts += 1; },
        act: async (context) => {
          calls.push(context.role);
          if (context.role === "supply_lead") await supplyLeadRequest;
          return clientThatActs().act(context);
        },
      },
    });

    const firstRun = orchestrator.runTick();
    await waitForMicrotasksUntil(() => calls.length === 2);
    expect(calls).toEqual(["host", "supply_lead"]);
    orchestrator.pause();
    releaseSupplyLead?.();

    expect(aborts).toBe(1);

    const pausedReport = await firstRun;
    expect(pausedReport).toMatchObject({
      advanced: false,
      paused: true,
      turns: [{ role: "host", status: "accepted" }, { role: "supply_lead", status: "paused" }],
    });
    expect(game.state().episode.tick).toBe(0);

    orchestrator.resume();
    const resumedReport = await orchestrator.runTick();

    expect(resumedReport.advanced).toBe(true);
    expect(calls).toEqual(["host", "supply_lead", "supply_lead", "chef", "server"]);
    expect(game.state().episode.tick).toBe(1);
  });

  it("discards a pending response even when play resumes before it returns", async () => {
    const game = new RestaurantGame();
    const calls: string[] = [];
    let releaseHost: (() => void) | undefined;
    const hostRequest = new Promise<void>((resolve) => { releaseHost = resolve; });
    const orchestrator = new WorkerOrchestrator(game, {
      client: {
        act: async (context) => {
          calls.push(context.role);
          if (calls.length === 1) await hostRequest;
          return clientThatActs().act(context);
        },
      },
    });

    const firstRun = orchestrator.runTick();
    await waitForMicrotasksUntil(() => calls.length === 1);
    orchestrator.pause();
    orchestrator.resume();
    releaseHost?.();

    expect((await firstRun).advanced).toBe(false);
    expect((await orchestrator.runTick()).advanced).toBe(true);
    expect(calls).toEqual(["host", "host", "supply_lead", "chef", "server"]);
  });

  it("uses only the remainder of the tick interval after model work", async () => {
    const game = new RestaurantGame();
    let elapsed = 0;
    let completedTicks = 0;
    let orchestrator: WorkerOrchestrator;
    orchestrator = new WorkerOrchestrator(game, {
      client: {
        act: async (context) => {
          elapsed += 300;
          return clientThatActs().act(context);
        },
      },
      elapsedMs: () => elapsed,
      tickIntervalMs: 1_000,
      onTick: (report) => {
        if (report.advanced && ++completedTicks === 2) orchestrator.stop();
      },
    });

    orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completedTicks).toBe(2);
  });
});
