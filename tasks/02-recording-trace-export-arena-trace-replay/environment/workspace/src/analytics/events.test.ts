import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENT_TYPES,
  createAnalyticsEvent,
  createAuthAnalyticsEvent,
} from "./events.js";

describe("analytics CloudEvents contract", () => {
  it("builds a CloudEvents 1.0 envelope with typed product data", () => {
    expect(createAnalyticsEvent(
      ANALYTICS_EVENT_TYPES.gameEnded,
      {
        game_type: "2048",
        variation_id: "classic",
        outcome: "completed",
        score: 2048,
        success: true,
        duration_ms: 12_000,
        actions_taken: 42,
      },
      {
        id: "evt_test",
        subject: "game_test",
        time: new Date("2026-07-17T12:00:00.000Z"),
      },
    )).toEqual({
      specversion: "1.0",
      id: "evt_test",
      source: "/tui-gamepigeon/client",
      type: "game.ended",
      time: "2026-07-17T12:00:00.000Z",
      datacontenttype: "application/json",
      subject: "game_test",
      data: {
        game_type: "2048",
        variation_id: "classic",
        outcome: "completed",
        score: 2048,
        success: true,
        duration_ms: 12_000,
        actions_taken: 42,
      },
    });
  });

  it("keeps application and game-start payloads to their public product fields", () => {
    const options = { id: "evt_test", time: new Date("2026-07-17T12:00:00.000Z") };

    expect(createAnalyticsEvent(
      ANALYTICS_EVENT_TYPES.appOpened,
      { app_version: "0.2.0", platform: "tui" },
      options,
    ).data).toEqual({ app_version: "0.2.0", platform: "tui" });

    expect(createAnalyticsEvent(
      ANALYTICS_EVENT_TYPES.gameStarted,
      { game_type: "2048", variation_id: "classic" },
      { ...options, subject: "game_test" },
    )).toMatchObject({
      type: "game.started",
      subject: "game_test",
      data: { game_type: "2048", variation_id: "classic" },
    });
  });

  it("keeps auth events pseudonymous and limited to the sign-in method", () => {
    expect(createAuthAnalyticsEvent({
      kind: "signed_in",
      method: "github",
      userId: "usr_test",
    })).toMatchObject({
      type: "account.signed_in",
      subject: "usr_test",
      data: { method: "github" },
    });
  });
});
