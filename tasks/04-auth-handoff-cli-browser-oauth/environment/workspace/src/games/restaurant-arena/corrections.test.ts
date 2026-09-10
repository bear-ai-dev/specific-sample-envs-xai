import { describe, expect, it } from "bun:test";
import { buildFullRolePrompt } from "./prompts.js";
import { RestaurantGame } from "./restaurant-game.js";
import { WorkerOrchestrator } from "./worker-orchestrator.js";
import type { ActionContext } from "./worker-client.js";
import { ACTION_VERSION, type ActionEnvelope, type Role, type Tool } from "./types.js";

function envelope(
  game: RestaurantGame,
  role: Role,
  tool: Tool,
  args: Record<string, unknown>,
  requestId: string,
): ActionEnvelope {
  const state = game.state();
  return {
    version: ACTION_VERSION,
    episodeId: state.episode.id,
    actorId: `worker-${role}`,
    actorType: "worker",
    role,
    tool,
    arguments: args,
    tick: state.episode.tick,
    timestamp: "2026-09-04T00:00:00.000Z",
    requestId,
    idempotencyKey: `${state.episode.id}:${requestId}`,
  };
}

describe("player corrections reach the workers (#256)", () => {
  it("puts a standing correction in front of every targeted role, and only those roles", () => {
    const game = new RestaurantGame();
    game.step("verify_substitution");

    expect(game.directivesFor("chef").map((d) => d.id)).toEqual(["directive-verify-substitution"]);
    expect(game.directivesFor("supply_lead").map((d) => d.id)).toEqual(["directive-verify-substitution"]);
    expect(game.directivesFor("host")).toEqual([]);

    const directive = game.directivesFor("chef")[0]!;
    expect(directive.category).toBe("safety");
    expect(directive.orderId).toBe("order-2");
  });

  it("keeps the correction in the turn prompt on later ticks", () => {
    const game = new RestaurantGame();
    game.step("verify_substitution");
    const issuedAt = game.state().episode.tick;

    for (let i = 0; i < 4; i += 1) game.step("tick");
    expect(game.state().episode.tick).toBeGreaterThan(issuedAt);

    const prompts = buildFullRolePrompt(game.observe("chef"), { directives: game.directivesFor("chef") });
    expect(prompts.turnPrompt).toContain("Standing Corrections From the Shift Manager");
    expect(prompts.turnPrompt).toContain("no substitution leaves the pass unverified");
    expect(prompts.turnPrompt).toContain(`Since tick ${issuedAt}`);
    expect(prompts.systemPrompt).toContain("Standing Corrections From the Shift Manager");
  });

  it("does not leak the correction into a fresh run", () => {
    const game = new RestaurantGame();
    game.step("verify_substitution");
    expect(game.directivesFor("chef")).toHaveLength(1);

    game.reset();
    expect(game.directivesFor("chef")).toEqual([]);
    expect(game.activeDirectives()).toEqual([]);
    expect(
      buildFullRolePrompt(game.observe("chef"), { directives: game.directivesFor("chef") }).turnPrompt,
    ).not.toContain("Standing Corrections");
  });

  it("lifts a pacing correction when the player reopens the door", () => {
    const game = new RestaurantGame();
    game.step("hold_seating");
    expect(game.directivesFor("host").map((d) => d.id)).toEqual(["directive-hold-seating"]);

    // Closing the door and reopening it are two exercises of authority, so
    // they fall in two rounds under the #262 budget.
    game.step("tick");
    game.step("tick");
    game.step("hold_seating");
    expect(game.directivesFor("host")).toEqual([]);
  });

  it("halts an unverified substitution at the action boundary once corrected", () => {
    const game = new RestaurantGame();
    const before = game.stepEnvelope(
      envelope(game, "chef", "prepare", { orderId: "order-2", substitution: "house-sauce" }, "req-1"),
    );
    expect(before.accepted).toBe(true);

    game.step("verify_substitution");

    const after = game.stepEnvelope(
      envelope(game, "chef", "prepare", { orderId: "order-2", substitution: "house-sauce" }, "req-2"),
    );
    expect(after.accepted).toBe(false);
    expect(after.error?.code).toBe("unsafe_action");
    expect(after.error?.message).toContain("verify the substitution");
  });

  it("does not halt or credit an unverified substitution on a different order", () => {
    const game = new RestaurantGame();
    game.step("verify_substitution");
    const uptake = game.state().outcomes.correctionUptake;

    const unrelated = game.stepEnvelope(
      envelope(game, "chef", "prepare", { orderId: "order-1", substitution: "house-sauce" }, "req-other-1"),
    );
    expect(unrelated.accepted).toBe(true);
    expect(unrelated.state.outcomes.correctionUptake).toBe(uptake);

    const verifiedElsewhere = game.stepEnvelope(
      envelope(game, "chef", "prepare", { orderId: "order-1", substitution: "house-sauce", verified: true }, "req-other-2"),
    );
    expect(verifiedElsewhere.accepted).toBe(true);
    expect(verifiedElsewhere.state.outcomes.correctionUptake).toBe(uptake);
  });

  it("tells the chef how to mark a substitution as verified", () => {
    const game = new RestaurantGame();
    const prompts = buildFullRolePrompt(game.observe("chef"), { directives: game.directivesFor("chef") });
    expect(prompts.systemPrompt).toContain("verified: true");
    expect(prompts.systemPrompt).toContain("verifiedSafe");
    expect(prompts.systemPrompt).toContain('"orderId":"order-2"');
    expect(prompts.systemPrompt).toContain('"verified":true');
  });

  it("credits uptake when the chef verifies instead of substituting", () => {
    const game = new RestaurantGame();
    game.step("verify_substitution");
    const uptakeAfterCorrection = game.state().outcomes.correctionUptake;

    const result = game.stepEnvelope(
      envelope(game, "chef", "prepare", { orderId: "order-2", substitution: "house-sauce", verified: true }, "req-3"),
    );

    expect(result.accepted).toBe(true);
    expect(result.state.outcomes.correctionUptake).toBeGreaterThan(uptakeAfterCorrection);
  });

  it("credits the supply lead for re-timing the pass around the prioritised ticket", () => {
    const game = new RestaurantGame();
    game.step("prioritize_allergy");
    const before = game.state().outcomes;

    const result = game.stepEnvelope(
      envelope(game, "supply_lead", "coordinate", { workerId: "worker-chef", orderId: "order-2", priority: "high" }, "req-4"),
    );

    expect(result.accepted).toBe(true);
    expect(result.state.outcomes.correctionUptake).toBeGreaterThan(before.correctionUptake);
    expect(result.state.outcomes.coordination).toBeGreaterThan(before.coordination);
  });

  it("credits legacy expediter envelope for re-timing the pass under supply_lead directives", () => {
    const game = new RestaurantGame();
    game.step("prioritize_allergy");
    const before = game.state().outcomes;

    const legacyAction: ActionEnvelope = {
      version: ACTION_VERSION,
      episodeId: game.state().episode.id,
      actorId: "worker-expediter",
      actorType: "worker",
      role: "expediter" as any,
      tool: "coordinate",
      arguments: { workerId: "worker-chef", orderId: "order-2", priority: "high" },
      tick: game.state().episode.tick,
      timestamp: "2026-09-04T00:00:00.000Z",
      requestId: "req-legacy-uptake",
      idempotencyKey: `${game.state().episode.id}:req-legacy-uptake`,
    };

    const result = game.stepEnvelope(legacyAction);
    expect(result.accepted).toBe(true);
    expect(result.state.outcomes.correctionUptake).toBeGreaterThan(before.correctionUptake);
    expect(result.state.outcomes.coordination).toBeGreaterThan(before.coordination);
  });

  it("holds a new seating while the door correction stands", () => {
    const game = new RestaurantGame();
    game.step("hold_seating");

    const result = game.stepEnvelope(
      envelope(game, "host", "seat", { tableId: "table-3", partyId: "party-1" }, "req-5"),
    );

    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("invalid_state");
  });

  it("journals the seating hold as a pace correction and links the halt to it, not the allergy decision", () => {
    const game = new RestaurantGame();
    game.step("hold_seating");
    game.stepEnvelope(
      envelope(game, "host", "seat", { tableId: "table-3", partyId: "party-1" }, "req-hold-1"),
    );

    const events = game.getRecordedEvents();
    const correction = events.find((e) => e.kind === "player_correction" && e.correctionCategory === "pace");
    expect(correction).toBeDefined();
    expect(correction!.text).toBe("Held the door.");
    expect(correction!.changedDecisionEventId).toBe(`evt-hold-seating-${game.state().seed}`);

    const halt = events.find((e) => e.toolResult?.status === "halted" && e.toolResult?.directiveId === "directive-hold-seating");
    expect(halt).toBeDefined();
    expect(halt!.changedDecisionEventId).toBe(correction!.changedDecisionEventId);
    expect(halt!.changedDecisionEventId).not.toBe(`evt-dec-allergy-${game.state().seed}`);
  });

  it("reads proposal, correction, then updated decision in journal order", () => {
    const game = new RestaurantGame();
    game.stepEnvelope(
      envelope(game, "chef", "prepare", { orderId: "order-2", substitution: "house-sauce" }, "req-6"),
    );
    game.step("verify_substitution");
    game.stepEnvelope(
      envelope(game, "chef", "prepare", { orderId: "order-2", substitution: "house-sauce", verified: true }, "req-7"),
    );

    const events = game.getRecordedEvents();
    const proposal = events.findIndex((e) => {
      const args = (e.action?.arguments ?? {}) as Record<string, unknown>;
      return args.substitution === "house-sauce" && args.verified !== true;
    });
    const correction = events.findIndex((e) => e.kind === "player_correction");
    const updated = events.findIndex((e) => e.toolResult?.status === "applied");

    expect(proposal).toBeGreaterThanOrEqual(0);
    expect(correction).toBeGreaterThan(proposal);
    expect(updated).toBeGreaterThan(correction);
  });
});

describe("an autonomous shift changes course after the correction (#256)", () => {
  /**
   * Stands in for a model that reads its prompt: it substitutes to save time
   * until a standing safety correction appears, then verifies instead.
   */
  function correctableClient(prompts: string[]) {
    let id = 0;
    return {
      act: async (context: ActionContext, _systemPrompt: string, turnPrompt: string) => {
        prompts.push(turnPrompt);
        id += 1;
        const corrected = turnPrompt.includes("Standing Corrections From the Shift Manager");
        const byRole: Record<Role, { tool: Tool; arguments: Record<string, unknown> }> = {
          chef: {
            tool: "prepare",
            arguments: corrected
              ? { orderId: "order-2", substitution: "house-sauce", verified: true }
              : { orderId: "order-2", substitution: "house-sauce" },
          },
          supply_lead: {
            tool: "coordinate",
            arguments: { workerId: "worker-chef", orderId: "order-2", priority: corrected ? "high" : "normal" },
          },
          host: { tool: "update_guest", arguments: { message: "A table is being cleared now." } },
          server: { tool: "inspect", arguments: { targetId: "pass" } },
        };
        const action = byRole[context.role];
        return {
          version: ACTION_VERSION,
          episodeId: context.episodeId,
          actorId: context.actorId,
          actorType: "worker" as const,
          role: context.role,
          tool: action.tool,
          arguments: action.arguments,
          tick: context.observation.tick,
          timestamp: "2026-09-04T00:00:00.000Z",
          requestId: `model-${id}`,
          idempotencyKey: `${context.episodeId}:model-${id}`,
        };
      },
    };
  }

  it("changes a later worker action and the shift outcome from one correction", async () => {
    const game = new RestaurantGame();
    const prompts: string[] = [];
    const orchestrator = new WorkerOrchestrator(game, { client: correctableClient(prompts) });

    const beforeReport = await orchestrator.runTick();
    expect(beforeReport.turns.find((turn) => turn.role === "chef")?.status).toBe("accepted");
    expect(prompts.some((prompt) => prompt.includes("Standing Corrections"))).toBe(false);
    const uptakeBefore = game.state().outcomes.correctionUptake;

    orchestrator.intervene(() => game.step("verify_substitution"));
    orchestrator.resume();

    prompts.length = 0;
    const afterReport = await orchestrator.runTick();

    expect(prompts.filter((prompt) => prompt.includes("Standing Corrections")).length).toBeGreaterThan(0);
    expect(afterReport.turns.find((turn) => turn.role === "chef")?.action?.arguments.verified).toBe(true);
    expect(game.state().outcomes.correctionUptake).toBeGreaterThan(uptakeBefore);
  });

  it("reaches roles that have not acted yet when the correction lands mid-round", async () => {
    const game = new RestaurantGame();
    const prompts: string[] = [];
    const orchestrator = new WorkerOrchestrator(game, {
      client: {
        act: async (context, _systemPrompt, turnPrompt) => {
          prompts.push(`${context.role}:${turnPrompt.includes("Standing Corrections") ? "corrected" : "plain"}`);
          if (context.role === "host") game.step("verify_substitution");
          return {
            version: ACTION_VERSION,
            episodeId: context.episodeId,
            actorId: context.actorId,
            actorType: "worker" as const,
            role: context.role,
            tool: "inspect" as Tool,
            arguments: { targetId: "pass" },
            tick: context.observation.tick,
            timestamp: "2026-09-04T00:00:00.000Z",
            requestId: `mid-${prompts.length}`,
            idempotencyKey: `${context.episodeId}:mid-${prompts.length}`,
          };
        },
      },
    });

    await orchestrator.runTick();

    expect(prompts).toEqual([
      "host:plain",
      "supply_lead:corrected",
      "chef:corrected",
      "server:corrected",
    ]);
  });
});
