import { expect, test } from "bun:test";
import { posthogProperties } from "./analytics.js";

test("maps overlay lifecycle data to a deduplicated PostHog event", () => {
  expect(posthogProperties({
    specversion: "1.0",
    id: "evt_test",
    source: "/tui-gamepigeon/overlay",
    type: "game.ended",
    time: "2026-07-20T00:00:00.000Z",
    datacontenttype: "application/json",
    subject: "game_session_test",
    data: {
      game_type: "restaurant-arena",
      variation_id: "classic",
      outcome: "completed",
      score: 130,
      success: true,
      duration_ms: 12_000,
      actions_taken: 42,
    },
  }, "device_test")).toEqual(expect.objectContaining({
    distinct_id: "device_test",
    $insert_id: "evt_test",
    cloud_event_subject: "game_session_test",
    game_type: "restaurant-arena",
    duration_ms: 12_000,
    actions_taken: 42,
  }));
});
