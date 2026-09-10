import { describe, expect, it } from "vitest";
import { localScoreForCompletion } from "./local-score.js";

const completion = {
  gameId: "game_test",
  gameType: "2048",
  variationId: "classic",
  score: 512,
  success: false,
  endedAtMs: 2_000,
  startedAtMs: 500,
  platform: "overlay" as const,
};

describe("local score completion", () => {
  it("builds the existing completed-result fields for a natural completion", () => {
    expect(localScoreForCompletion({ ...completion, outcome: "completed" })).toEqual({
      game_id: "game_test",
      game_type: "2048",
      variation_id: "classic",
      score: 512,
      success: false,
      completed_at: "1970-01-01T00:00:02.000Z",
      duration_ms: 1_500,
      platform: "overlay",
    });
  });

  it("does not create a score for quit, restart, or shutdown paths", () => {
    expect(localScoreForCompletion({ ...completion, outcome: "abandoned" })).toBeNull();
  });
});
