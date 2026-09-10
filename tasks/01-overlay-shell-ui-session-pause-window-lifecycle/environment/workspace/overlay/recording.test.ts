import { describe, expect, test } from "bun:test";
import { extractBehaviorCloningSamples } from "@tui-games/trace-export";
import { REGISTRY } from "../src/games/registry.js";
import {
  appendOverlayAction,
  buildOverlayGameResult,
  buildOverlayTraceChunks,
  buildSealedOverlayTraceChunks,
  createOverlayTrace,
} from "./recording.js";

describe("overlay recording", () => {
  test("builds replay-safe schema-v2 chunks for every registered game", () => {
    for (const entry of REGISTRY) {
      const variation = entry.variations[0]!;
      const trace = createOverlayTrace(entry, variation.id, 42, 1_000, {
        width: 520,
        height: 740,
      });
      appendOverlayAction(trace, entry.create!(variation.id).actions[0]!, "human", 1_100);

      const chunks = buildOverlayTraceChunks(trace, "user_quit", "test", 2_000);
      const events = chunks.flatMap((chunk) => chunk.events);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((chunk) =>
        chunk.schema_version === 2 &&
        chunk.event_count === chunk.events.length &&
        chunk.events.every((event) =>
          event.user_id === chunk.user_id &&
          event.game_id === chunk.game_id &&
          event.chunk_id === chunk.chunk_id
        )
      )).toBe(true);
      expect(events.some((event) =>
        event.event_type === "observation" &&
        event.payload.representation === "engine_state_v1"
      )).toBe(true);
      expect(extractBehaviorCloningSamples(chunks, { includeNoops: true })).toEqual([
        expect.objectContaining({
          game_type: entry.id,
          action: trace.actions[0]!.action,
          actor: "human",
        }),
      ]);
      expect(events.at(-1)?.event_type).toBe("episode_ended");
    }
  });

  test("splits long episodes at the deployed 50-event boundary", () => {
    const entry = REGISTRY.find((item) => item.id === "restaurant-arena")!;
    const trace = createOverlayTrace(entry, "dinner-rush", 7, 1_000, {
      width: 520,
      height: 740,
    });
    for (let index = 0; index < 30; index++) {
      appendOverlayAction(trace, entry.create!("dinner-rush").actions[index % 4]!, "human", 1_100 + index);
    }

    const chunks = buildOverlayTraceChunks(trace, "user_quit", "test", 2_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.events.length <= 50)).toBe(true);
    expect(chunks.map((chunk) => chunk.chunk_sequence)).toEqual(
      chunks.map((_, index) => index + 1),
    );
  });

  test("rebuilds the same durable payload and completed result after a retry", () => {
    const entry = REGISTRY.find((item) => item.id === "restaurant-arena")!;
    const trace = createOverlayTrace(entry, "dinner-rush", 7, 1_000, {
      width: 520,
      height: 740,
    });
    trace.endReason = "game_over";
    trace.endedAtMs = 2_000;
    trace.completedScore = 4;
    appendOverlayAction(trace, "tick", "human", 1_100);

    expect(buildOverlayTraceChunks(trace, trace.endReason, "test", trace.endedAtMs)).toEqual(
      buildOverlayTraceChunks(trace, trace.endReason, "test", trace.endedAtMs),
    );
    expect(buildOverlayGameResult(trace)).toEqual({
      result_id: `res_${trace.gameId.slice("game_".length)}_1`,
      game_id: trace.gameId,
      game_type: "restaurant-arena",
      score: 4,
      completed_at: new Date(2_000).toISOString(),
    });
  });

  test("seals mid-episode chunks byte-identically to the final build", () => {
    const entry = REGISTRY.find((item) => item.id === "restaurant-arena")!;
    const trace = createOverlayTrace(entry, "dinner-rush", 11, 1_000, {
      width: 470,
      height: 650,
    });
    const directions = ["tick", "prioritize_allergy", "inspect_oven", "hold_seating"];
    for (let index = 0; index < 60; index++) {
      appendOverlayAction(trace, directions[index % 4]!, "human", 1_100 + index);
    }

    const sealed = buildSealedOverlayTraceChunks(trace, "test");
    const final = buildOverlayTraceChunks(trace, "game_over", "test", 9_000);

    // The trailing partial chunk is withheld until the episode ends.
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.length).toBeLessThan(final.length);
    // The local store rejects a chunk id whose bytes changed, so the prefix
    // must survive the end-of-episode rebuild untouched.
    expect(JSON.stringify(sealed)).toBe(JSON.stringify(final.slice(0, sealed.length)));
  });

  test("only ever extends the sealed prefix as an episode continues", () => {
    const entry = REGISTRY.find((item) => item.id === "restaurant-arena")!;
    const trace = createOverlayTrace(entry, "dinner-rush", 11, 1_000, {
      width: 470,
      height: 650,
    });
    const directions = ["tick", "prioritize_allergy", "inspect_oven", "hold_seating"];
    let previous = buildSealedOverlayTraceChunks(trace, "test");
    for (let index = 0; index < 60; index++) {
      appendOverlayAction(trace, directions[index % 4]!, "human", 1_100 + index);
      const sealed = buildSealedOverlayTraceChunks(trace, "test");
      expect(sealed.length).toBeGreaterThanOrEqual(previous.length);
      expect(JSON.stringify(sealed.slice(0, previous.length))).toBe(JSON.stringify(previous));
      previous = sealed;
    }
    expect(previous.length).toBeGreaterThan(0);
  });
});
