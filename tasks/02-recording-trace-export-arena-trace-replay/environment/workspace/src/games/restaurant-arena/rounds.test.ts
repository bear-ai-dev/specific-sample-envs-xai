import { expect, test } from "bun:test";
import { RestaurantGame } from "./restaurant-game.js";
import { roundContractFor, roundForTick, TICKS_PER_ROUND } from "./rounds.js";
import { SHIFT_PRESETS } from "./arena-view.js";

test("round counts are derived from level length, not declared per level", () => {
  expect(roundContractFor("quiet-tuesday")).toMatchObject({ rounds: 12, maxTicks: 24, ticksPerRound: 2 });
  expect(roundContractFor("dinner-rush")).toMatchObject({ rounds: 12, maxTicks: 24, ticksPerRound: 2 });
  // 28 ticks, so 14 rounds. Trimming the level to fit a uniform 12 costs it
  // roughly two served orders against a goal it only just reaches.
  expect(roundContractFor("saturday-night")).toMatchObject({ rounds: 14, maxTicks: 28, ticksPerRound: 2 });
});

test("round r contains ticks 2r-1 and 2r, so incidents land where the contract says", () => {
  expect(roundForTick(0)).toBe(1);
  expect(roundForTick(1)).toBe(1);
  expect(roundForTick(2)).toBe(1);
  expect(roundForTick(3)).toBe(2);
  // The three levels' scheduled incidents, per the #262 contract.
  expect(roundForTick(15)).toBe(8); // quiet-tuesday + dinner-rush warming shelf
  expect(roundForTick(8)).toBe(4); // dinner-rush oven failure
  expect(roundForTick(6)).toBe(3); // saturday-night oven failure
  expect(roundForTick(12)).toBe(6); // saturday-night warming shelf
});

test("the manager gets one envelope per round, and a second is refused and recorded", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  expect(game.roundStatus()).toMatchObject({ round: 1, totalRounds: 12, envelopesSpent: 0, canAct: true });

  const first = game.submitPlayerIntervention({ kind: "message", targetRole: "host", text: "Hold the door." });
  expect(first.accepted).toBe(true);
  expect(game.roundStatus()).toMatchObject({ envelopesSpent: 1, canAct: false });

  const second = game.submitPlayerIntervention({ kind: "message", targetRole: "chef", text: "Fire table two." });
  expect(second.accepted).toBe(false);
  expect(second.error?.code).toBe("round_budget_exhausted");

  // Refused, not dropped: the attempt is in the trace.
  const rejected = game.getRecordedEvents().filter((e) => e.action?.tool === "rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.round).toBe(1);

  // The round closes after its two ticks and hands over a fresh envelope.
  game.step("tick");
  expect(game.roundStatus()).toMatchObject({ round: 1, canAct: false });
  game.step("tick");
  expect(game.roundStatus()).toMatchObject({ round: 2, envelopesSpent: 0, canAct: true });
  expect(game.submitPlayerIntervention({ kind: "message", targetRole: "chef", text: "Fire table two." }).accepted).toBe(true);
});

test("a malformed intervention costs the manager nothing", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  expect(game.submitPlayerIntervention({ kind: "priority", targetRole: "supply_lead", orderId: "" }).accepted).toBe(false);
  expect(game.roundStatus()).toMatchObject({ envelopesSpent: 0, canAct: true });
});

test("passing a round is a recorded choice, not an absence of one", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  expect(game.passRound().accepted).toBe(true);
  expect(game.roundStatus()).toMatchObject({ envelopesSpent: 1, canAct: false });

  const noop = game.getRecordedEvents().find((e) => e.action?.tool === "no_op");
  expect(noop?.round).toBe(1);

  // Having passed, the manager has spent the round like anyone else.
  expect(game.submitPlayerIntervention({ kind: "message", targetRole: "host", text: "Actually…" }).accepted).toBe(false);
});

test("answering an open decision is exempt, so a spent round cannot deadlock the shift", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  // Run to the oven failure at tick 8, which raises a decision and stops the clock.
  while (!game.view().decision && !game.isOver()) game.step("tick");
  const decision = game.view().decision;
  expect(decision).toBeDefined();

  // Spend the round's envelope, then answer the decision anyway.
  game.submitPlayerIntervention({ kind: "message", targetRole: "chef", text: "Talk to me." });
  expect(game.roundStatus().canAct).toBe(false);
  const answered = game.submitPlayerIntervention({
    kind: "approve",
    targetRole: "chef",
    decisionId: decision!.id,
    optionId: decision!.options[0]!.id,
  });
  expect(answered.accepted).toBe(true);
});

test("every recorded event carries the round it happened in", () => {
  for (const variation of ["dinner-rush", "quiet-tuesday", "saturday-night"]) {
    const game = new RestaurantGame(275, variation);
    game.step("sim_start");
    while (!game.isOver()) {
      const decision = game.view().decision;
      if (decision) {
        game.submitPlayerIntervention({
          kind: "approve",
          targetRole: "chef",
          decisionId: decision.id,
          optionId: decision.options[0]!.id,
        });
        continue;
      }
      game.step("tick");
    }
    const events = game.getRecordedEvents();

    const contract = roundContractFor(variation);
    for (const event of events) {
      expect(event.round).toBeDefined();
      expect(event.round).toBeGreaterThanOrEqual(1);
      expect(event.round).toBeLessThanOrEqual(contract.rounds);
      // An event stamped with round r happened inside that round's tick pair,
      // give or take the manager envelope recorded at the round's opening tick.
      expect(Math.abs(event.round! - roundForTick(event.tick, TICKS_PER_ROUND))).toBeLessThanOrEqual(1);
    }
  }
});

/** A manager envelope built by hand, the way a direct API caller would. */
function playerEnvelope(game: RestaurantGame, requestId: string, text = "Pick up the pace.") {
  const episodeId = game.state().episode.id;
  return {
    version: "restaurant-arena-action/v1" as const,
    episodeId,
    actorId: "player",
    actorType: "player" as const,
    role: "host" as const,
    tool: "send_message" as const,
    arguments: { to: "worker-host", text, priority: "normal" as const },
    tick: game.state().episode.tick,
    timestamp: new Date().toISOString(),
    requestId,
    idempotencyKey: `${episodeId}:${requestId}`,
  };
}

test("a direct envelope cannot walk around the round budget", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  expect(game.submitPlayerIntervention({ kind: "message", targetRole: "host", text: "Hold." }).accepted).toBe(true);
  expect(game.roundStatus().canAct).toBe(false);

  // The panel is guarded, but stepEnvelope is the boundary a replay and any
  // direct caller crosses; the budget has to hold there too.
  const direct = game.stepEnvelope(playerEnvelope(game, "req-direct-1"));
  expect(direct.accepted).toBe(false);
  expect(direct.error?.code).toBe("round_budget_exhausted");
});

test("an action that is refused on its merits does not cost the round", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");

  // A coordinate against an order that does not exist fails inside
  // applyEnvelope, after the budget used to have been charged.
  const bogus = game.stepEnvelope({
    ...playerEnvelope(game, "req-bogus"),
    tool: "coordinate" as const,
    arguments: { workerId: "worker-supply_lead", orderId: "order-does-not-exist", priority: "high" as const },
    role: "supply_lead" as const,
  });
  expect(bogus.accepted).toBe(false);
  expect(game.roundStatus()).toMatchObject({ envelopesSpent: 0, canAct: true });

  // And the round is still there to be used.
  expect(game.submitPlayerIntervention({ kind: "message", targetRole: "host", text: "Now this." }).accepted).toBe(true);
});

test("a reused request stem does not buy a free action in the next round", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  expect(game.stepEnvelope(playerEnvelope(game, "req-stem")).accepted).toBe(true);
  expect(game.roundStatus().envelopesSpent).toBe(1);

  game.step("tick");
  game.step("tick");
  expect(game.roundStatus()).toMatchObject({ round: 2, envelopesSpent: 0 });

  // Same stem as last round, fresh idempotency key. It must still be charged,
  // or the round-2 budget would silently stay at zero.
  const reused = game.stepEnvelope({ ...playerEnvelope(game, "req-stem", "Again."), idempotencyKey: `${game.state().episode.id}:req-stem-2` });
  expect(reused.accepted).toBe(true);
  expect(game.roundStatus()).toMatchObject({ envelopesSpent: 1, canAct: false });
});

test("the round budget is part of the checkpoint, so a dropped pass cannot hide", () => {
  const game = new RestaurantGame(275, "dinner-rush");
  game.step("sim_start");
  const before = JSON.stringify(game.checkpointState());
  game.passRound();
  // Passing changes nothing about the restaurant, only the manager's budget.
  // If the checkpoint omitted that, this assertion would fail and a tampered
  // replay could drop the pass unnoticed.
  expect(JSON.stringify(game.checkpointState())).not.toEqual(before);
});


test("cash goals keep the levels in difficulty order", () => {
  // Measured against a baseline that answers every raised decision and takes
  // no discretionary action — competent minimum play. Pass rates over 60
  // seeds: Quiet Tuesday 83%, Dinner Rush 60%, Saturday Night 35%.
  //
  // Dinner Rush sat at $220 and passed 2%, making the middle level harder
  // than the hardest one. A founder-check play-through scored $194 with a
  // clean service — 11 covers, no walkouts, every plate verified — and still
  // missed, which is what sent us back to the numbers.
  const goals = ["quiet-tuesday", "dinner-rush", "saturday-night"].map(
    (id) => SHIFT_PRESETS[id]!.goal.cash,
  );
  expect(goals).toEqual([140, 190, 320]);
  // Each level asks for more than the one before it.
  expect(goals[0]!).toBeLessThan(goals[1]!);
  expect(goals[1]!).toBeLessThan(goals[2]!);
});
