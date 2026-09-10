import { describe, expect, it } from "vitest";
import type { PostHog } from "posthog-node";
import { ANALYTICS_EVENT_TYPES, createAnalyticsEvent } from "./events.js";
import { Analytics } from "./posthog.js";

type Client = Pick<PostHog, "capture" | "shutdown">;

const gameEnded = createAnalyticsEvent(
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
);

describe("PostHog analytics", () => {
  it("maps a CloudEvent into one PostHog event", () => {
    const captures: unknown[] = [];
    const client = {
      capture: (event: unknown) => { captures.push(event); },
      shutdown: async () => {},
    } as Client;

    new Analytics(client, "usr_test").capture(gameEnded);

    expect(captures).toEqual([{
      distinctId: "usr_test",
      event: "game.ended",
      timestamp: new Date("2026-07-17T12:00:00.000Z"),
      properties: {
        game_type: "2048",
        variation_id: "classic",
        outcome: "completed",
        score: 2048,
        success: true,
        duration_ms: 12_000,
        actions_taken: 42,
        $insert_id: "evt_test",
        cloud_event_id: "evt_test",
        cloud_event_source: "/tui-gamepigeon/client",
        cloud_event_specversion: "1.0",
        cloud_event_datacontenttype: "application/json",
        cloud_event_subject: "game_test",
      },
    }]);
  });

  it("is a no-op without a configured client", () => {
    expect(() => new Analytics(null, "usr_test").capture(gameEnded)).not.toThrow();
  });

  it("does not leak capture failures into gameplay", () => {
    const client = {
      capture: () => { throw new Error("offline"); },
      shutdown: async () => {},
    } as Client;

    expect(() => new Analytics(client, "usr_test").capture(gameEnded)).not.toThrow();
  });

  it("uses a newly authenticated user id for later events", () => {
    const distinctIds: unknown[] = [];
    const client = {
      capture: (event: { distinctId?: string }) => { distinctIds.push(event.distinctId); },
      shutdown: async () => {},
    } as Client;
    const instance = new Analytics(client, "device_test");

    instance.capture(gameEnded);
    instance.setDistinctId("usr_test");
    instance.capture(gameEnded);

    expect(distinctIds).toEqual(["device_test", "usr_test"]);
  });
});
