import { describe, expect, it } from "bun:test";
import { findGame } from "../../games/registry.js";
import { maskedGameIds, maskerFor } from "./index.js";

describe("masker registry", () => {
  it("returns undefined for games without a policy path yet", () => {
    expect(maskerFor("restaurant-arena")).toBeUndefined();
    expect(maskerFor("nonsense")).toBeUndefined();
  });

  it("every registered masker matches a real game id", () => {
    for (const gameId of maskedGameIds()) {
      expect(findGame(gameId)).toBeDefined();
    }
  });

  it("every masker exposes a non-empty action space", () => {
    for (const gameId of maskedGameIds()) {
      expect(maskerFor(gameId)!.actions.length).toBeGreaterThan(0);
    }
  });
});
