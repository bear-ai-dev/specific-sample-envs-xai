import { describe, expect, it } from "bun:test";
import { BASE_TICK_MS, TUTORIAL_SHIFT_ID, tutorialCoach } from "./arena-view.js";
import { RestaurantGame } from "./restaurant-game.js";
import { validateArenaTraceV3 } from "./trace.js";

describe("Training Shift", () => {
  it("is its own variation with a slower clock and a tagged episode id", () => {
    const game = new RestaurantGame(218220, TUTORIAL_SHIFT_ID);
    expect(game.view().shift.id).toBe(TUTORIAL_SHIFT_ID);
    expect(game.view().goal.cash).toBe(80);
    expect(game.state().episode.id).toBe(`${TUTORIAL_SHIFT_ID}-218220`);
    expect(game.state().episode.maxTicks).toBe(16);
    game.step("sim_start");
    expect(game.tickMs()).toBe(4500);
    expect(game.tickMs()).toBeGreaterThan(BASE_TICK_MS);
  });

  it("starts Mira on the line so the kitchen is already cooking", () => {
    const game = new RestaurantGame(218220, TUTORIAL_SHIFT_ID);
    expect(game.state().workers.find((worker) => worker.role === "chef")?.location).toBe("kitchen");
    expect(game.state().orders.every((order) => !order.allergy)).toBe(true);
    expect(game.view().coach?.step).toBe(0);
  });

  it("walks the coach through rush, then the allergy call", () => {
    const game = new RestaurantGame(218220, TUTORIAL_SHIFT_ID);
    game.step("sim_start");
    expect(game.view().coach?.step).toBe(1);

    game.step("tick");
    game.step("tick");
    game.step("rush_table_1");
    expect(game.view().coach?.title).toMatch(/number|Protect|Allergy/i);

    const started = game.state().orders.length;
    while (game.state().orders.length === started && !game.isOver()) game.step("tick");
    const allergy = game.state().orders.find((order) => order.allergy);
    expect(allergy).toBeDefined();
    expect(game.view().decision?.id).toBe("allergy_ticket");
    expect(game.view().coach?.step).toBe(2);

    game.step("decide_allergy_ticket_verify");
    expect(game.view().decision).toBeUndefined();
    expect(game.view().coach?.step).toBe(3);
  });

  it("does not raise the allergy card while Mira is off the line", () => {
    const game = new RestaurantGame(218220, TUTORIAL_SHIFT_ID);
    game.step("sim_start");
    game.step("assign_chef_pass");
    const started = game.state().orders.length;
    while (game.state().orders.length === started && !game.isOver()) game.step("tick");
    expect(game.state().orders.some((order) => order.allergy)).toBe(true);
    expect(game.view().decision).toBeUndefined();
    game.step("assign_chef_kitchen");
    game.step("tick");
    expect(game.view().decision?.id).toBe("allergy_ticket");
  });

  it("leaves Dinner Rush traces uncoached", () => {
    const game = new RestaurantGame(218220, "dinner-rush");
    expect(game.view().coach).toBeUndefined();
    expect(tutorialCoach(game.view())).toBeUndefined();
  });

  it("records a valid trace tagged as the training variation", () => {
    const game = new RestaurantGame(218220, TUTORIAL_SHIFT_ID);
    game.step("sim_start");
    while (!game.isOver()) game.step("tick");
    const trace = game.captureTrace({ runKind: "live" });
    expect(trace.replay.variation).toBe(TUTORIAL_SHIFT_ID);
    expect(validateArenaTraceV3(trace)).toEqual({ valid: true, errors: [] });
  });

  it("keeps the rush lesson active if table 1 is served before being rushed", () => {
    const game = new RestaurantGame(218220, TUTORIAL_SHIFT_ID);
    game.step("sim_start");
    expect(game.view().coach?.step).toBe(1);
    expect(game.view().coach?.title).toBe("Rush table 1");

    while (game.state().orders.find((o) => o.tableId === "table-1")?.status !== "served") {
      game.step("tick");
    }

    expect(game.view().coach?.step).toBe(1);
    expect(game.view().coach?.title).toBe("Rush table 2");

    game.step("rush_table_2");
    expect(game.view().coach?.step).not.toBe(1);
  });
});
