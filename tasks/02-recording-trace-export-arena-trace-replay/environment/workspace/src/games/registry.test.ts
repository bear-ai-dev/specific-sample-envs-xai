import { describe, expect, it } from "bun:test";
import { MENU_GAMES, playableGames } from "./registry.js";

describe("registry", () => {
  it("exposes Restaurant Arena in menu games", () => {
    expect(MENU_GAMES.map(({ id }) => id)).toEqual(["restaurant-arena"]);
  });

  it("lists variations for registered games", () => {
    const restaurant = MENU_GAMES.find((g) => g.id === "restaurant-arena");
    expect(restaurant?.variations.map(({ id, title }) => [id, title])).toEqual([
      ["tutorial-shift", "Training Shift"],
      ["dinner-rush", "Dinner Rush"],
      ["quiet-tuesday", "Quiet Tuesday"],
      ["saturday-night", "Saturday Night"],
    ]);
  });

  for (const entry of playableGames()) {
    for (const variation of entry.variations) {
      it(`${entry.id} (${variation.id}) is not over immediately after reset`, () => {
        for (const seed of [0, 1, 2, 42, 12345]) {
          const game = entry.create!(variation.id);
          game.reset(seed);
          expect(game.isOver()).toBe(false);
        }
      });
    }
  }
});
