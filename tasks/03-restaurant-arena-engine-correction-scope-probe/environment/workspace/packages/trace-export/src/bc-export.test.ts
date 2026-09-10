import { describe, expect, test } from "bun:test";
import type { TraceEvent, TraceEventChunk } from "./types.js";
import { extractBehaviorCloningSamples } from "./bc-export.js";

function event(
  sequence: number,
  eventType: TraceEvent["event_type"],
  payload: Record<string, unknown>,
): TraceEvent {
  return {
    schema_version: 2,
    user_id: "usr_test",
    game_id: "game_test",
    chunk_id: sequence <= 4 ? "chk_1" : "chk_2",
    event_id: `evt_${sequence}`,
    event_sequence: sequence,
    event_version: 1,
    event_type: eventType,
    visibility: eventType === "engine_checkpoint" ? "privileged" : "policy",
    client_time_ms: sequence,
    monotonic_time_us: sequence * 1_000,
    payload,
  } as TraceEvent;
}

function chunk(sequence: number, events: TraceEvent[]): TraceEventChunk {
  const chunkId = `chk_${sequence}`;
  return {
    schema_version: 2,
    user_id: "usr_test",
    game_id: "game_test",
    game_type: "2048",
    game_version: "1",
    chunk_id: chunkId,
    chunk_sequence: sequence,
    first_event_sequence: events[0]!.event_sequence,
    last_event_sequence: events.at(-1)!.event_sequence,
    event_count: events.length,
    created_at_ms: 10,
    client: {
      platform: "tui",
      application_version: "test",
      recording_sdk_version: "2",
    },
    events: events.map((item) => ({ ...item, chunk_id: chunkId })),
  };
}

describe("behavior cloning export", () => {
  test("joins observations, human controls, and outcomes across chunks", () => {
    const chunks = [
      chunk(2, [
        event(5, "outcome_changed", {
          score_before: 0,
          score_after: 4,
          score_delta: 4,
          engine_reward: 4,
          reward_spec_id: "engine_v1",
          terminal: false,
          caused_by_event_id: "evt_4",
          progress: { moved: true, success: false },
        }),
        event(6, "control_changed", {
          based_on_observation_id: "obs_2",
          control: "left",
          action: "left",
          kind: "impulse",
          actor: "environment",
        }),
      ]),
      chunk(1, [
        event(1, "episode_started", {
          game_type: "2048",
          game_version: "1",
          ruleset_id: "classic",
          telemetry_version: 2,
          platform: "overlay",
          viewport: { width: 520, height: 740 },
          control_schema: ["left", "right"],
          input_semantics: "engine_impulse",
        }),
        event(2, "observation", {
          observation_id: "obs_1",
          representation: "engine_state_v1",
          state: { board: [0, 2] },
        }),
        event(3, "observation", {
          observation_id: "obs_2",
          representation: "engine_state_v1",
          state: { board: [2, 0] },
        }),
        event(4, "control_changed", {
          based_on_observation_id: "obs_2",
          control: "right",
          action: "right",
          kind: "impulse",
          actor: "human",
        }),
      ]),
    ];

    expect(extractBehaviorCloningSamples(chunks)).toEqual([
      expect.objectContaining({
        schema_version: 1,
        game_id: "game_test",
        game_type: "2048",
        ruleset_id: "classic",
        client_time_ms: 4,
        observation_id: "obs_2",
        observation: {
          representation: "engine_state_v1",
          state: { board: [2, 0] },
        },
        action: "right",
        reward: 4,
        score_delta: 4,
        terminal: false,
        moved: true,
      }),
    ]);
  });

  test("drops no-op human controls by default and can retain them explicitly", () => {
    const chunks = [
      chunk(1, [
        event(1, "observation", {
          observation_id: "obs_1",
          representation: "engine_state_v1",
          state: { board: [2, 0] },
        }),
        event(2, "control_changed", {
          based_on_observation_id: "obs_1",
          control: "left",
          action: "left",
          kind: "impulse",
          actor: "human",
        }),
        event(3, "outcome_changed", {
          score_before: 0,
          score_after: 0,
          score_delta: 0,
          engine_reward: 0,
          reward_spec_id: "engine_v1",
          terminal: false,
          caused_by_event_id: "evt_2",
          progress: { moved: false, success: false },
        }),
      ]),
    ];

    expect(extractBehaviorCloningSamples(chunks)).toEqual([]);
    expect(extractBehaviorCloningSamples(chunks, { includeNoops: true })).toHaveLength(1);
  });
});
