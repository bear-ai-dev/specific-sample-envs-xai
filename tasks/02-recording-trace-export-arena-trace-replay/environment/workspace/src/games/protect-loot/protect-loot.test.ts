import { describe, expect, test } from "bun:test";
import { CORRECTION, ProtectLootGame, ROOM_NAMES, type ProtectLootAction } from "./protect-loot.js";

const toExit: ProtectLootAction[] = ["down", "right", "right", "right", "right", "right", "right", "right", "up", "up"];
const DEMO: ProtectLootAction[] = [...toExit, "correct", ...toExit, ...toExit, ...toExit, ...toExit];

function replay(seed: number, actions: readonly ProtectLootAction[]) {
  const game = new ProtectLootGame();
  game.reset(seed);
  const states = [game.state()];
  for (const action of actions) {
    game.step(action);
    states.push(game.state());
  }
  return states;
}

describe("Protect vs. Loot MVP", () => {
  test("the player can move through the room while Tui follows", () => {
    const game = new ProtectLootGame((observation) => observation.memory ? "protect" : "follow");
    game.reset(42);
    game.step("right");
    expect(game.state()).toMatchObject({ player: { x: 3, y: 4 }, tui: { x: 2, y: 4 } });
  });

  test("collision, hazard, loot, and extraction are player-controlled", () => {
    const game = new ProtectLootGame();
    game.reset(42);
    for (const action of toExit) game.step(action);
    expect(game.step("right").moved).toBe(true);
    game.step("right");
    game.step("right");
    game.step("right");
    expect(game.step("right").moved).toBe(false);
    game.step("down");
    for (let i = 0; i < 2; i++) game.step("right");
    for (let i = 0; i < 3; i++) game.step("up");
    game.step("left");
    expect(game.state()).toMatchObject({ player: { x: 7, y: 2 }, loot: 2 });
    expect(game.state().rooms[1]).toMatchObject({ loot: 0 });

    const hazard = new ProtectLootGame();
    hazard.reset(42);
    for (const action of toExit) hazard.step(action);
    expect(hazard.step("left")).toMatchObject({ moved: true, done: true });
    expect(hazard.state()).toMatchObject({ health: 0, done: true });
  });

  test("the exact correction changes the later choice and a seeded run replays identically", () => {
    const first = replay(42, DEMO);
    const second = replay(42, DEMO);

    expect(second).toEqual(first);
    expect(first.find((state) => state.room === 1)).toMatchObject({ health: 1, companionAction: "loot" });
    expect(first.find((state) => state.memory === CORRECTION)).toBeTruthy();
    expect(first.find((state) => state.room === 3)).toMatchObject({ health: 1, companionAction: "protect" });
    expect(first.find((state) => state.message.includes(CORRECTION))).toBeTruthy();
    expect(first.at(-1)).toMatchObject({ room: 4, extracted: true, done: true });
  });

  test("without the correction, Tui repeats the mistake", () => {
    expect(replay(42, [...toExit, ...toExit, ...toExit, ...toExit]).at(-1)).toMatchObject({
      room: 3,
      health: 0,
      companionAction: "loot",
      done: true,
    });
  });

  test("scouting requires explicit approval in the safe hall", () => {
    const game = new ProtectLootGame((observation) =>
      observation.available.includes("scout") ? "scout" : "protect",
    );
    game.reset(42);
    for (const action of toExit) game.step(action);
    for (const action of toExit) game.step(action);
    expect(game.state()).toMatchObject({ room: 2, health: 3, companionAction: "follow" });
    game.step("approve_scouting");
    expect(game.state()).toMatchObject({ scoutingApproved: true, companionAction: "scout", done: false });
  });

  test("unsafe scouting fails the mission", () => {
    const game = new ProtectLootGame((observation) => (observation.room === 3 ? "scout" : "protect"));
    game.reset(42);
    for (const action of toExit) game.step(action);
    for (const action of toExit) game.step(action);
    for (const action of toExit) game.step(action);
    expect(game.state()).toMatchObject({ room: 3, health: 0, companionAction: "scout", done: true });
  });

  test("each room is a launchable level", () => {
    expect(ProtectLootGame.VARIATIONS).toHaveLength(5);
    for (const [index, variation] of ProtectLootGame.VARIATIONS.entries()) {
      const game = new ProtectLootGame(undefined, { variationId: variation.id });
      game.reset(42);
      expect(game.state().room).toBe(index);
      expect(game.state().rooms[index]?.name).toBe(ROOM_NAMES[index]);
      expect(game.isOver()).toBe(false);
    }
  });

  test("starting at Last Stand already remembers the correction", () => {
    const game = new ProtectLootGame(undefined, { variationId: "room-3" });
    game.reset(42);
    expect(game.state()).toMatchObject({
      room: 3,
      memory: CORRECTION,
      companionAction: "protect",
      health: 1,
      done: false,
    });
  });

  test("picking a later room starts there and continues through the remaining mission", () => {
    const game = new ProtectLootGame(undefined, { variationId: "room-1" });
    game.reset(42);
    expect(game.state().room).toBe(1);
    for (const action of toExit) game.step(action);
    expect(game.state().room).toBe(2);
  });

  test("a capture run cannot start mid-mission", () => {
    expect(() => new ProtectLootGame(undefined, { autoCompanion: false, variationId: "room-3" })).toThrow(
      /must start at room 0/,
    );
    expect(() => new ProtectLootGame(undefined, { autoCompanion: false })).not.toThrow();
    expect(() => new ProtectLootGame(undefined, { variationId: "room-3" })).not.toThrow();
  });

  test("picking Extraction starts at the exit room", () => {
    const game = new ProtectLootGame(undefined, { variationId: "room-4" });
    game.reset(42);
    expect(game.state()).toMatchObject({ room: 4, companionAction: "wait", done: false });
    for (const action of toExit) game.step(action);
    expect(game.state()).toMatchObject({ extracted: true, done: true });
  });

  test("the player can traverse forward and backward between biomes", () => {
    const game = new ProtectLootGame();
    game.reset(42);
    expect(game.state().room).toBe(0);
    expect(game.state().biome?.name).toBe("Surface Safehouse");

    // Advance to Room 1 (Broken Caverns)
    for (const action of toExit) game.step(action);
    expect(game.state().room).toBe(1);
    expect(game.state().biome?.name).toBe("Broken Caverns");

    // Backtrack from Room 1 to Room 0 (Surface Safehouse) via entrance
    // In room 1, start pos is (2, 4). Move to (0, 3) to backtrack: up -> left -> left
    game.step("up");
    game.step("left");
    game.step("left");
    expect(game.state().room).toBe(0);
    expect(game.state().biome?.name).toBe("Surface Safehouse");
    expect(game.state().message).toContain("Backtracked");

    // Advance forward again to Room 1
    game.step("right"); // from (8,3) to (9,3) -> exit!
    expect(game.state().room).toBe(1);
    expect(game.state().biome?.name).toBe("Broken Caverns");
  });
});
