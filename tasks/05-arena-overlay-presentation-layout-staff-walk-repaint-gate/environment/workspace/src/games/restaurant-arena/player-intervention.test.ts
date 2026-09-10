import { describe, expect, it } from "bun:test";
import { RestaurantGame } from "./restaurant-game.js";
import { isActionEnvelope } from "./types.js";

describe("Player intervention HUD (#255)", () => {
  it("sends a natural-language message to a worker as a valid player ActionEnvelope", () => {
    const game = new RestaurantGame(218220);
    const result = game.submitPlayerIntervention({
      kind: "message",
      targetRole: "chef",
      text: "Verify every substitution before it leaves the pass.",
    });

    expect(result.accepted).toBe(true);

    const line = game.view().feed.at(-1);
    expect(line?.voice).toBe("you");
    expect(line?.kind).toBe("player");
    expect(line?.text).toContain("Verify every substitution");

    // Not a raw mutation: the recipient sees it as a normal delivered
    // message on the next tick, exactly like a worker-to-worker one.
    expect(game.observe("chef").messages).toEqual([]);
    game.step("tick");
    expect(game.observe("chef").messages).toEqual([
      {
        from: "player",
        text: "Verify every substitution before it leaves the pass.",
        priority: "normal",
        sentAtTick: 0,
      },
    ]);
  });

  it("rejects an empty message without mutating state or the tick", () => {
    const game = new RestaurantGame(218220);
    const before = game.state();
    const result = game.submitPlayerIntervention({ kind: "message", targetRole: "chef", text: "   " });
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("invalid_arguments");
    expect(game.state()).toEqual(before);
  });

  it("broadcasts a manager message to everyone", () => {
    const game = new RestaurantGame(218220);
    const result = game.submitPlayerIntervention({ targetRole: "everyone", kind: "message", text: "Stay coordinated." });
    expect(result.accepted).toBe(true);
    game.step("tick");
    for (const role of ["host", "supply_lead", "chef", "server"] as const) {
      expect(game.observe(role).messages?.[0]?.text).toBe("Stay coordinated.");
      expect(game.observe(role).messages?.[0]?.from).toBe("player");
    }
  });

  it("rejects a message exceeding 256 characters in submitPlayerIntervention", () => {
    const game = new RestaurantGame(218220);
    const before = game.state();
    const oversized = "x".repeat(257);
    const result = game.submitPlayerIntervention({ kind: "message", targetRole: "chef", text: oversized });
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("invalid_arguments");
    expect(result.error?.message).toBe("message text cannot exceed 256 characters");
    expect(game.state()).toEqual(before);
  });

  it("rejects a send_message envelope exceeding 256 characters in stepEnvelope", () => {
    const game = new RestaurantGame(218220);
    const before = game.state();
    const oversized = "x".repeat(257);
    const result = game.stepEnvelope({
      version: "restaurant-arena-action/v1",
      episodeId: game.state().episode.id,
      actorId: "player",
      actorType: "player",
      role: "chef",
      tool: "send_message",
      arguments: { to: "worker-chef", text: oversized, priority: "normal" },
      tick: 0,
      timestamp: new Date().toISOString(),
      requestId: "req-oversized-envelope",
      idempotencyKey: "dinner-rush-001:req-oversized-envelope",
    });
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("invalid_arguments");
    expect(result.error?.message).toBe("send_message requires string 'to' and non-empty 'text' up to 256 characters");
    expect(game.state()).toEqual(before);
  });

  it("sets a ticket's priority through the coordinate tool", () => {
    const game = new RestaurantGame(218220);
    expect(game.state().orders.find((o) => o.id === "order-1")?.priority).toBe("normal");

    const result = game.submitPlayerIntervention({
      kind: "priority",
      targetRole: "supply_lead",
      orderId: "order-1",
      priority: "high",
    });

    expect(result.accepted).toBe(true);
    expect(result.state.orders.find((o) => o.id === "order-1")?.priority).toBe("high");
    expect(game.view().feed.some((line) => line.kind === "player" && line.text.includes("Prioritised"))).toBe(true);
  });

  it("rejects a priority change against an unknown order without mutating state or the tick", () => {
    const game = new RestaurantGame(218220);
    const before = game.state();
    const result = game.submitPlayerIntervention({
      kind: "priority",
      targetRole: "supply_lead",
      orderId: "order-does-not-exist",
      priority: "high",
    });
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("unknown_entity");
    expect(game.state()).toEqual(before);
  });

  it("rejects a priority change against a served order via submitPlayerIntervention and stepEnvelope", () => {
    const game = new RestaurantGame(218220);
    game.step("assign_host_kitchen");
    game.step("tick");
    game.step("tick");
    expect(game.state().orders.find((o) => o.id === "order-2")?.status).toBe("served");

    // The approve above spent this round's envelope; open the next one so the
    // rejection under test is the cancelled order, not the budget (#262).
    game.step("tick");
    game.step("tick");
    const before = game.state();
    const resultIntervention = game.submitPlayerIntervention({
      kind: "priority",
      targetRole: "supply_lead",
      orderId: "order-2",
      priority: "normal",
    });
    expect(resultIntervention.accepted).toBe(false);
    expect(resultIntervention.error?.code).toBe("invalid_state");
    expect(resultIntervention.error?.message).toBe("order order-2 is served and cannot be prioritised");
    expect(game.state()).toEqual(before);

    const resultEnvelope = game.stepEnvelope({
      version: "restaurant-arena-action/v1",
      episodeId: game.state().episode.id,
      actorId: "player",
      actorType: "player",
      role: "supply_lead",
      tool: "coordinate",
      arguments: { workerId: "worker-supply_lead", orderId: "order-2", priority: "normal" },
      tick: game.state().episode.tick,
      timestamp: new Date().toISOString(),
      requestId: "req-coord-served",
      idempotencyKey: `${game.state().episode.id}:req-coord-served`,
    });
    expect(resultEnvelope.accepted).toBe(false);
    expect(resultEnvelope.error?.code).toBe("invalid_state");
    expect(resultEnvelope.error?.message).toBe("order order-2 is served and cannot be prioritised");
    expect(game.state()).toEqual(before);
  });

  it("rejects a priority change against a cancelled order via submitPlayerIntervention and stepEnvelope", () => {
    const game = new RestaurantGame(218220);
    game.step("tick");
    const pullResult = game.submitPlayerIntervention({
      kind: "approve",
      targetRole: "chef",
      decisionId: "allergy_ticket",
      optionId: "pull",
    });
    expect(pullResult.accepted).toBe(true);
    expect(game.state().orders.find((o) => o.id === "order-2")?.status).toBe("cancelled");
    expect(game.state().outcomes.cash).toBe(-22);

    const before = game.state();
    const resultIntervention = game.submitPlayerIntervention({
      kind: "priority",
      targetRole: "supply_lead",
      orderId: "order-2",
      priority: "normal",
    });
    expect(resultIntervention.accepted).toBe(false);
    expect(resultIntervention.error?.code).toBe("invalid_state");
    expect(resultIntervention.error?.message).toBe("order order-2 is cancelled and cannot be prioritised");
    expect(game.state()).toEqual(before);

    const resultEnvelope = game.stepEnvelope({
      version: "restaurant-arena-action/v1",
      episodeId: game.state().episode.id,
      actorId: "player",
      actorType: "player",
      role: "supply_lead",
      tool: "coordinate",
      arguments: { workerId: "worker-supply_lead", orderId: "order-2", priority: "normal" },
      tick: game.state().episode.tick,
      timestamp: new Date().toISOString(),
      requestId: "req-coord-cancelled",
      idempotencyKey: `${game.state().episode.id}:req-coord-cancelled`,
    });
    expect(resultEnvelope.accepted).toBe(false);
    expect(resultEnvelope.error?.code).toBe("invalid_state");
    expect(resultEnvelope.error?.message).toBe("order order-2 is cancelled and cannot be prioritised");
    expect(game.state()).toEqual(before);
  });

  it("submits the safety-first correction and raises correctionUptake", () => {
    const game = new RestaurantGame(218220);
    const result = game.submitPlayerIntervention({ kind: "correction", targetRole: "chef" });

    expect(result.accepted).toBe(true);
    expect(result.state.outcomes.correctionUptake).toBeGreaterThan(0);
    // order-2 is the seeded allergy ticket and starts high already; the
    // correction should not be a no-op just because priority didn't move.
    expect(result.state.orders.find((o) => o.id === "order-2")?.priority).toBe("high");
    const line = game.view().feed.at(-1);
    expect(line?.who).toBe("Mira");
  });

  it("approves a flagged risky decision through the approve tool", () => {
    const game = new RestaurantGame(218220);
    // The seeded allergy ticket (order-2) is already active at tick 0, so
    // the very first tick raises it as a decision holding the clock.
    game.step("tick");
    expect(game.view().decision?.id).toBe("allergy_ticket");

    const result = game.submitPlayerIntervention({
      kind: "approve",
      targetRole: "chef",
      decisionId: "allergy_ticket",
      optionId: "verify",
    });

    expect(result.accepted).toBe(true);
    expect(game.view().decision).toBeUndefined();
    expect(result.state.outcomes.correctionUptake).toBeGreaterThan(0);
  });

  it("rejects an approval that does not match the open decision, without mutating state or the tick", () => {
    const game = new RestaurantGame(218220);
    game.step("tick");
    expect(game.view().decision?.id).toBe("allergy_ticket");
    const before = game.state();

    const result = game.submitPlayerIntervention({
      kind: "approve",
      targetRole: "chef",
      decisionId: "allergy_ticket",
      optionId: "not-a-real-option",
    });

    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("invalid_state");
    expect(game.state()).toEqual(before);
  });

  it("rejects an approval when no decision is open", () => {
    const game = new RestaurantGame(218220);
    const before = game.state();
    const result = game.submitPlayerIntervention({
      kind: "approve",
      targetRole: "chef",
      decisionId: "oven_down",
      optionId: "repair",
    });
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("invalid_state");
    expect(game.state()).toEqual(before);
  });

  it("every accepted intervention is a valid, player-attributed ActionEnvelope routed through stepEnvelope", () => {
    const game = new RestaurantGame(218220);
    const messageResult = game.submitPlayerIntervention({ kind: "message", targetRole: "server", text: "Hold the floor calm." });
    expect(messageResult.accepted).toBe(true);

    // Rebuild the envelope stepEnvelope would have seen, to prove the shape
    // is contract-valid rather than trusting submitPlayerIntervention's own
    // bookkeeping.
    const envelope = {
      version: "restaurant-arena-action/v1" as const,
      episodeId: game.state().episode.id,
      actorId: "player",
      actorType: "player" as const,
      role: "server" as const,
      tool: "send_message" as const,
      arguments: { to: "worker-server", text: "Hold the floor calm.", priority: "normal" },
      tick: 0,
      timestamp: new Date().toISOString(),
      requestId: "req-shape-check",
      idempotencyKey: "dinner-rush-001:req-shape-check",
    };
    expect(isActionEnvelope(envelope)).toBe(true);
  });

  it("a worker can never use a player-only tool", () => {
    const game = new RestaurantGame(218220);
    const result = game.stepEnvelope({
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-chef",
      actorType: "worker",
      role: "chef",
      tool: "correct",
      arguments: { note: "self-approved" },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-worker-correct",
      idempotencyKey: "dinner-rush-001:req-worker-correct",
    });
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("role_not_permitted");
  });
});
