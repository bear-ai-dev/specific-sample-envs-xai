import { describe, expect, it } from "bun:test";
import { RestaurantGame } from "./restaurant-game.js";
import type { ActionEnvelope } from "./types.js";

describe("Restaurant Arena Game Engine (#241)", () => {
  it("passes the determinism checkpoint: fixed action sequence produces identical state twice", () => {
    const game1 = new RestaurantGame(218220);
    const game2 = new RestaurantGame(218220);

    const actionSequence: ("tick" | "prioritize_allergy" | "rush_table_1")[] = [
      "tick",
      "prioritize_allergy",
      "tick",
      "tick",
      "rush_table_1",
      "tick",
      "tick",
      "tick",
      "tick",
      "tick", // tick 8: oven failure triggers
      "tick",
    ];

    for (const action of actionSequence) {
      game1.step(action);
      game2.step(action);
    }

    const state1 = game1.state();
    const state2 = game2.state();

    expect(state1).toEqual(state2);
    expect(JSON.stringify(state1)).toBe(JSON.stringify(state2));
    expect(game1.score()).toBe(game2.score());
    expect(state1.episode.tick).toBe(9);
    expect(state1.emergency?.active).toBe(true);
    expect(state1.emergency?.kind).toBe("oven_failure");
    expect(state1.emergency?.startedAt).toBe(8);
  });

  it("activates scheduled oven failure emergency at tick 8", () => {
    const game = new RestaurantGame(218220);
    expect(game.state().emergency?.active).toBe(false);

    for (let i = 0; i < 7; i++) {
      game.step("tick");
    }
    expect(game.state().episode.tick).toBe(7);
    expect(game.state().emergency?.active).toBe(false);

    // Step to tick 8
    game.step("tick");
    const state = game.state();
    expect(state.episode.tick).toBe(8);
    expect(state.emergency?.active).toBe(true);
    expect(state.emergency?.kind).toBe("oven_failure");
    const oven = state.equipment.find((e) => e.id === "oven-1");
    expect(oven?.status).toBe("failed");
  });

  it("rejects unauthorized tool use with role_not_permitted via stepEnvelope", () => {
    const game = new RestaurantGame(218220);
    const serverPreparing: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-server",
      actorType: "worker",
      role: "server",
      tool: "prepare", // Server is not permitted to prepare food
      arguments: { orderId: "order-1" },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-unauth-01",
      idempotencyKey: "dinner-rush-001:req-unauth-01",
    };

    const initial = game.state();
    const result = game.stepEnvelope(serverPreparing);
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("role_not_permitted");
    expect(game.state()).toEqual(initial);
  });

  it("caches and replays duplicate idempotencyKey without double-applying", () => {
    const game = new RestaurantGame(218220);
    const chefPrepare: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-chef",
      actorType: "worker",
      role: "chef",
      tool: "prepare",
      arguments: { orderId: "order-1" },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-01",
      idempotencyKey: "dinner-rush-001:req-01",
    };

    const first = game.stepEnvelope(chefPrepare);
    expect(first.accepted).toBe(true);

    const second = game.stepEnvelope(chefPrepare);
    expect(second.accepted).toBe(true);
    expect(second).toEqual(first);
  });

  it("delivers send_message to the recipient's next observation only (#54 back-port)", () => {
    const game = new RestaurantGame(218220);
    const sendMessage: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-supply_lead",
      actorType: "worker",
      role: "supply_lead",
      tool: "send_message",
      arguments: { to: "worker-chef", text: "Prioritize the allergy-safe order.", priority: "high" },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-msg-01",
      idempotencyKey: "dinner-rush-001:req-msg-01",
    };

    const result = game.stepEnvelope(sendMessage);
    expect(result.accepted).toBe(true);

    // Not yet visible on the tick it was sent.
    expect(game.observe("chef").messages).toEqual([]);

    // Visible on the very next tick.
    game.step("tick");
    expect(game.observe("chef").messages).toEqual([
      { from: "worker-supply_lead", text: "Prioritize the allergy-safe order.", priority: "high", sentAtTick: 0 },
    ]);

    // Gone the tick after that.
    game.step("tick");
    expect(game.observe("chef").messages).toEqual([]);
  });

  it("rejects send_message to an unknown worker", () => {
    const game = new RestaurantGame(218220);
    const badMessage: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-supply_lead",
      actorType: "worker",
      role: "supply_lead",
      tool: "send_message",
      arguments: { to: "worker-nobody", text: "hello" },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-msg-02",
      idempotencyKey: "dinner-rush-001:req-msg-02",
    };

    const result = game.stepEnvelope(badMessage);
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("unknown_entity");
  });

  it("rejects stale action ticks", () => {
    const game = new RestaurantGame(218220);
    game.step("tick"); // now at tick 1

    const staleAction: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-chef",
      actorType: "worker",
      role: "chef",
      tool: "prepare",
      arguments: { orderId: "order-1" },
      tick: 0, // stale
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-stale-01",
      idempotencyKey: "dinner-rush-001:req-stale-01",
    };

    const result = game.stepEnvelope(staleAction);
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("stale_tick");
  });
  it("lets the player end the oven emergency by inspecting it", () => {
    const game = new RestaurantGame(218220);
    for (let i = 0; i < 8; i++) game.step("tick");
    expect(game.state().emergency?.active).toBe(true);
    expect(game.state().equipment.find((e) => e.kind === "oven")?.status).toBe("failed");

    expect(game.step("inspect_oven").moved).toBe(true);
    expect(game.state().emergency?.active).toBe(false);
    expect(game.state().equipment.find((e) => e.kind === "oven")?.status).toBe("degraded");

    // The repair finishes on its own two ticks later.
    game.step("tick");
    game.step("tick");
    expect(game.state().equipment.find((e) => e.kind === "oven")?.status).toBe("working");
  });

  it("sends a rushed order to the chef ahead of the queue", () => {
    // Table 2 opens the shift already flagged high, so it is what the chef
    // reaches for when the player does nothing.
    const untouched = new RestaurantGame(218220);
    untouched.step("tick");
    expect(untouched.state().orders.find((o) => o.tableId === "table-2")?.status).toBe("preparing");
    expect(untouched.state().orders.find((o) => o.tableId === "table-1")?.status).toBe("queued");

    const rushed = new RestaurantGame(218220);
    expect(rushed.step("rush_table_1").moved).toBe(true);
    rushed.step("tick");
    expect(rushed.state().orders.find((o) => o.tableId === "table-1")?.status).toBe("preparing");
    expect(rushed.state().orders.find((o) => o.tableId === "table-2")?.status).toBe("queued");
  });

  it("shields reputation while the player holds seating through an emergency", () => {
    const held = new RestaurantGame(218220);
    const open = new RestaurantGame(218220);
    for (let i = 0; i < 8; i++) {
      held.step("tick");
      open.step("tick");
    }
    expect(held.step("hold_seating").moved).toBe(true);
    expect(held.state().seatingHeld).toBe(true);

    for (let i = 0; i < 4; i++) {
      held.step("tick");
      open.step("tick");
    }
    expect(held.state().reputation).toBeGreaterThan(open.state().reputation);

    held.step("hold_seating");
    expect(held.state().seatingHeld).toBe(false);
  });

  it("stalls the kitchen when the player drags the chef off the line", () => {
    const game = new RestaurantGame(218220);
    expect(game.step("assign_chef_queue").moved).toBe(true);
    expect(game.state().workers.find((w) => w.role === "chef")?.location).toBe("queue");

    for (let i = 0; i < 5; i++) game.step("tick");
    expect(game.state().orders.every((o) => o.status === "queued")).toBe(true);
    expect(game.state().outcomes.completed).toBe(0);

    // Put them back and the line starts moving again.
    game.step("assign_chef_kitchen");
    game.step("tick");
    expect(game.state().orders.some((o) => o.status === "preparing")).toBe(true);
  });

  it("halves prep time when a second worker is dragged into the kitchen", () => {
    const alone = new RestaurantGame(218220);
    alone.step("tick");
    alone.step("tick");
    expect(alone.state().orders.find((o) => o.tableId === "table-2")?.status).toBe("preparing");

    const helped = new RestaurantGame(218220);
    helped.step("assign_host_kitchen");
    helped.step("tick");
    helped.step("tick");
    expect(helped.state().orders.find((o) => o.tableId === "table-2")?.status).toBe("served");
  });

  describe("the playable layer", () => {
    it("holds the clock until the player starts, and while a decision is open", () => {
      const game = new RestaurantGame(218220);
      // Nothing moves on a cold open.
      expect(game.tickMs()).toBe(0);

      game.step("sim_start");
      expect(game.tickMs()).toBeGreaterThan(0);

      // The fixture opens with an allergy ticket, so tick 1 raises a decision.
      game.step("tick");
      const view = game.view();
      expect(view.decision?.id).toBe("allergy_ticket");
      expect(view.sim.running).toBe(false);
      expect(game.tickMs()).toBe(0);

      game.step("decide_allergy_ticket_verify");
      expect(game.view().decision).toBeUndefined();
      expect(game.tickMs()).toBeGreaterThan(0);
    });

    it("runs the clock faster as the player raises the speed", () => {
      const game = new RestaurantGame(218220);
      game.step("sim_start");
      const atOne = game.tickMs();
      game.step("sim_speed");
      expect(game.tickMs()).toBeLessThan(atOne);
      // Speed wraps back around rather than dead-ending at the top.
      game.step("sim_speed");
      game.step("sim_speed");
      expect(game.tickMs()).toBe(atOne);
    });

    it("seats arriving parties onto real tickets, and loses the ones who wait too long", () => {
      const game = new RestaurantGame(218220);
      game.step("sim_start");
      const startingOrders = game.state().orders.length;
      for (let i = 0; i < 12; i++) game.step("tick");

      // The old fixture ran dry after its two orders; a shift now keeps
      // putting tickets on the board.
      expect(game.state().orders.length).toBeGreaterThan(startingOrders);
      expect(game.view().feed.length).toBeGreaterThan(0);

      // With nobody on the door, the queue backs up and parties give up.
      const abandoned = new RestaurantGame(218220);
      abandoned.step("sim_start");
      abandoned.step("assign_host_kitchen");
      for (let i = 0; i < 16; i++) abandoned.step("tick");
      expect(abandoned.view().debrief).toBeUndefined();
      expect(abandoned.state().reputation).toBeLessThan(50);
    });

    it("fails the night on an unverified allergy plate however good the till is", () => {
      const game = new RestaurantGame(218220);
      game.step("sim_start");
      // Never verify: the allergy ticket goes out unchecked.
      for (let i = 0; i < 24; i++) game.step("tick");
      const debrief = game.view().debrief;
      expect(debrief).toBeDefined();
      expect(debrief!.grade).toBe("D");
      expect(debrief!.met).toBe(false);
      expect(debrief!.lessons.some((lesson) => lesson.includes("not verified"))).toBe(true);
    });

    it("gives each shift its own target, pressure, and incident timing", () => {
      const quiet = new RestaurantGame(218220, "quiet-tuesday");
      const saturday = new RestaurantGame(218220, "saturday-night");
      expect(quiet.view().goal.cash).toBeLessThan(saturday.view().goal.cash);
      expect(saturday.state().episode.maxTicks).toBeGreaterThan(quiet.state().episode.maxTicks);

      for (let i = 0; i < 6; i++) {
        quiet.step("tick");
        saturday.step("tick");
      }
      expect(quiet.state().equipment.find((item) => item.id === "oven-1")?.status).toBe("working");
      expect(saturday.state().equipment.find((item) => item.id === "oven-1")?.status).toBe("failed");
    });
  });

  it("keeps a worker off the floor from running plates", () => {
    const game = new RestaurantGame(218220);
    game.step("assign_server_kitchen");
    for (let i = 0; i < 6; i++) game.step("tick");
    expect(game.state().outcomes.completed).toBe(0);
    expect(game.state().orders.some((o) => o.status === "ready")).toBe(true);
  });

  it("lets a model chef and server actually cook and run a plate", () => {
    const game = new RestaurantGame(218220);
    game.setExternalControllers(["host", "supply_lead", "chef", "server"]);
    const chefPrepare: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-chef",
      actorType: "worker",
      role: "chef",
      tool: "prepare",
      arguments: { orderId: "order-1", verified: true },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-cook-1",
      idempotencyKey: "dinner-rush-001:req-cook-1",
    };
    expect(game.stepEnvelope(chefPrepare).accepted).toBe(true);
    expect(game.state().orders.find((order) => order.id === "order-1")?.status).toBe("preparing");
    expect(game.state().workers.find((worker) => worker.role === "chef")?.location).toBe("kitchen");

    game.step("tick");
    game.step("tick");
    expect(game.state().orders.find((order) => order.id === "order-1")?.status).toBe("ready");

    const serverServe: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-server",
      actorType: "worker",
      role: "server",
      tool: "serve",
      arguments: { tableId: "table-1", orderId: "order-1" },
      tick: game.state().episode.tick,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-run-1",
      idempotencyKey: "dinner-rush-001:req-run-1",
    };
    expect(game.stepEnvelope(serverServe).accepted).toBe(true);
    expect(game.state().orders.find((order) => order.id === "order-1")?.status).toBe("served");
    expect(game.state().outcomes.completed).toBeGreaterThan(0);
  });

  it("binds a worker envelope to the body it names, not the role it claims", () => {
    const game = new RestaurantGame(218220);
    game.setExternalControllers(["host", "supply_lead", "chef", "server"]);
    const spoofed: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-server",
      actorType: "worker",
      role: "chef",
      tool: "prepare",
      arguments: { orderId: "order-1", verified: true },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-spoof-1",
      idempotencyKey: "dinner-rush-001:req-spoof-1",
    };

    const initial = game.state();
    const result = game.stepEnvelope(spoofed);
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("role_not_permitted");
    expect(game.state()).toEqual(initial);
  });

  it("rejects an unknown worker actor before mutating the floor", () => {
    const game = new RestaurantGame(218220);
    const ghost: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-nobody",
      actorType: "worker",
      role: "chef",
      tool: "prepare",
      arguments: { orderId: "order-1" },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-ghost-1",
      idempotencyKey: "dinner-rush-001:req-ghost-1",
    };

    const initial = game.state();
    const result = game.stepEnvelope(ghost);
    expect(result.accepted).toBe(false);
    expect(result.error?.code).toBe("unknown_entity");
    expect(game.state()).toEqual(initial);
  });

  it("does not keep a rejected prepare's verification or chef move", () => {
    const game = new RestaurantGame(218220);
    game.setExternalControllers(["host", "supply_lead", "chef", "server"]);

    const chefPrepare: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-chef",
      actorType: "worker",
      role: "chef",
      tool: "prepare",
      arguments: { orderId: "order-2" },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-allergy-cook",
      idempotencyKey: "dinner-rush-001:req-allergy-cook",
    };
    expect(game.stepEnvelope(chefPrepare).accepted).toBe(true);
    game.step("tick");
    game.step("tick");
    expect(game.state().orders.find((order) => order.id === "order-2")?.status).toBe("ready");

    const serverServe: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-server",
      actorType: "worker",
      role: "server",
      tool: "serve",
      arguments: { tableId: "table-2", orderId: "order-2" },
      tick: game.state().episode.tick,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-allergy-run",
      idempotencyKey: "dinner-rush-001:req-allergy-run",
    };
    expect(game.stepEnvelope(serverServe).accepted).toBe(true);
    expect((game.checkpointState() as { unsafeServed: number }).unsafeServed).toBe(1);

    game.step("assign_chef_queue");
    const lateVerify: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-chef",
      actorType: "worker",
      role: "chef",
      tool: "prepare",
      arguments: { orderId: "order-2", verified: true },
      tick: game.state().episode.tick,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-allergy-late",
      idempotencyKey: "dinner-rush-001:req-allergy-late",
    };
    const rejected = game.stepEnvelope(lateVerify);
    expect(rejected.accepted).toBe(false);
    expect(rejected.error?.code).toBe("invalid_state");
    expect(game.state().workers.find((worker) => worker.role === "chef")?.location).toBe("queue");
    expect(game.state().orders.find((order) => order.id === "order-2")?.status).toBe("served");
    expect((game.checkpointState() as { verifiedOrderIds: string[] }).verifiedOrderIds).toEqual([]);
  });
});
