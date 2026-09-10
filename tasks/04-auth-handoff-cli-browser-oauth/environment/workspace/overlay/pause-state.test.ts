import { describe, expect, test } from "bun:test";
import { shouldReopenGameOver, shouldScheduleTick } from "./pause-state.js";

describe("restoring the game-over prompt", () => {
  test("reopens when a finished run comes back with no prompt on screen", () => {
    // Enter → Coding closes the prompt but leaves the run over (issue #141).
    expect(shouldReopenGameOver({ screen: "game", gameOver: true, pauseReason: undefined })).toBe(true);
  });

  test("leaves an in-progress run alone", () => {
    expect(shouldReopenGameOver({ screen: "game", gameOver: false, pauseReason: undefined })).toBe(false);
  });

  test("does not stack a second prompt on the one already shown", () => {
    for (const pauseReason of ["game-over", "agent", "signout", "how-to-play"] as const) {
      expect(shouldReopenGameOver({ screen: "game", gameOver: true, pauseReason })).toBe(false);
    }
  });

  test("stays off the menu, variations and score screens", () => {
    for (const screen of ["menu", "variations", "scores", "gate"]) {
      expect(shouldReopenGameOver({ screen, gameOver: true, pauseReason: undefined })).toBe(false);
    }
  });
});

describe("the self-running tick loop", () => {
  test("runs while a game is in progress and nothing is prompting", () => {
    expect(shouldScheduleTick({ screen: "game", gameOver: false, pauseReason: undefined })).toBe(true);
  });

  test("freezes the board behind every prompt", () => {
    // The snake used to keep crawling under the agent pause dialog.
    for (const pauseReason of ["agent", "game-over", "signout", "how-to-play"] as const) {
      expect(shouldScheduleTick({ screen: "game", gameOver: false, pauseReason })).toBe(false);
    }
  });

  test("stops once the run is over", () => {
    expect(shouldScheduleTick({ screen: "game", gameOver: true, pauseReason: undefined })).toBe(false);
  });

  test("stops when the player leaves the board", () => {
    for (const screen of ["menu", "variations", "scores", "gate"]) {
      expect(shouldScheduleTick({ screen, gameOver: false, pauseReason: undefined })).toBe(false);
    }
  });
});
