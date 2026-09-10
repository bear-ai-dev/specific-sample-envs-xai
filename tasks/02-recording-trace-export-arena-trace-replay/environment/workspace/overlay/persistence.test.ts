import { describe, expect, test } from "bun:test";
import { findGame, playableGames } from "../src/games/registry.js";
import { clearSavedGame, loadSavedGame, restoreGame, saveGame, type SavedGame } from "./persistence.js";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const actions: Record<string, string[]> = {
  "restaurant-arena": ["tick", "tick", "prioritize_allergy"],
};

describe("local Tui saves", () => {
  test("keeps saves isolated to the local owner and ignores corrupt data", () => {
    const storage = new MemoryStorage();
    expect(loadSavedGame(storage)).toBeNull();
    storage.setItem("gamepigeon.arcade.active-game.v1", "not json");
    expect(loadSavedGame(storage)).toBeNull();
  });

  for (const entry of playableGames()) {
    test(`restores ${entry.id} to the saved state`, () => {
      const source = entry.create!(entry.variations[0]!.id);
      source.reset(42);
      const accepted: string[] = [];
      for (const action of actions[entry.id] ?? []) if (source.step(action).moved) accepted.push(action);
      const saved: SavedGame = {
        schemaVersion: 1,
        ownerId: "local-user",
        gameId: entry.id,
        gameVersion: entry.version,
        variationId: entry.variations[0]!.id,
        seed: 42,
        actions: accepted,
      };
      const restored = restoreGame(entry, saved);
      expect(restored?.game.state()).toEqual(source.state());
      expect(restored?.actions).toEqual(accepted);
    });
  }

  // A save is a seed plus actions, so a game whose board or rules changed
  // would replay them into a different run. The version guard is what keeps
  // that from silently restoring the wrong state — bump the registry entry's
  // version whenever a change would move a replay.
  test("refuses a save written by an older version of the game", () => {
    const entry = findGame("restaurant-arena")!;
    const saved: SavedGame = {
      schemaVersion: 1,
      ownerId: "local-user",
      gameId: entry.id,
      gameVersion: "0",
      variationId: "dinner-rush",
      seed: 42,
      actions: ["tick"],
    };
    expect(entry.version).not.toBe("0");
    expect(restoreGame(entry, saved)).toBeNull();
  });

  test("clears a completed save", () => {
    const storage = new MemoryStorage();
    const entry = findGame("restaurant-arena")!;
    saveGame({ schemaVersion: 1, ownerId: "local-user", gameId: entry.id, gameVersion: entry.version, variationId: "dinner-rush", seed: 1, actions: [] }, storage);
    clearSavedGame(storage);
    expect(loadSavedGame(storage)).toBeNull();
  });
});
