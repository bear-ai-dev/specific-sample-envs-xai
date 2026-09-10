import { findGame, type GameEntry, type PlayableGame } from "../src/games/registry.js";
import type {
  EpisodeEndReason,
  TraceActor,
  TraceEvent,
  TraceEventChunk,
} from "../src/recording/types.js";

const PENDING_USER_ID = "usr_pending";
const MAX_EVENTS_PER_CHUNK = 50;
const MAX_CHUNK_BYTES = 120 * 1024;

export interface StoredOverlayAction {
  action: string;
  actor: TraceActor;
  atMs: number;
}

export interface StoredOverlayTrace {
  gameId: string;
  gameType: string;
  gameVersion: string;
  rulesetId: string;
  seed: number;
  startedAtMs: number;
  viewport: { width: number; height: number };
  controlSchema: string[];
  actions: StoredOverlayAction[];
  endReason?: EpisodeEndReason;
  endedAtMs?: number;
  completedScore?: number;
  /** Sealed chunks already handed to the local recording store mid-episode. */
  flushedChunks?: number;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function traceId(trace: StoredOverlayTrace, prefix: string, suffix: string | number): string {
  return `${prefix}_${trace.gameId.slice("game_".length)}_${suffix}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function checkpointState(game: PlayableGame): unknown {
  return clone(game.checkpointState?.() ?? game.state());
}

export function createOverlayTrace(
  entry: GameEntry,
  variationId: string,
  seed: number,
  startedAtMs = Date.now(),
  viewport = { width: window.innerWidth, height: window.innerHeight },
): StoredOverlayTrace {
  const game = entry.create!(variationId);
  return {
    gameId: id("game"),
    gameType: entry.id,
    gameVersion: entry.version,
    rulesetId: variationId,
    seed,
    startedAtMs,
    viewport,
    controlSchema: [...game.actions],
    actions: [],
  };
}

export function appendOverlayAction(
  trace: StoredOverlayTrace,
  action: string,
  actor: TraceActor,
  atMs = Date.now(),
): void {
  trace.actions.push({ action, actor, atMs });
}

function splitEvents(events: TraceEvent[]): TraceEvent[][] {
  const groups: TraceEvent[][] = [];
  let current: TraceEvent[] = [];
  for (const event of events) {
    const next = [...current, event];
    if (
      current.length > 0 &&
      (next.length > MAX_EVENTS_PER_CHUNK ||
        new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_CHUNK_BYTES)
    ) {
      groups.push(current);
      current = [event];
    } else {
      current = next;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

interface TraceEnding {
  reason: EpisodeEndReason;
  endedAtMs: number;
}

/**
 * Replays the journal into v2 events. `ending` is null while the episode is
 * still being played, which keeps the prefix byte-identical to the eventual
 * final build — the local store rejects a chunk id whose bytes changed.
 */
function buildOverlayTraceEvents(
  trace: StoredOverlayTrace,
  ending: TraceEnding | null,
): TraceEvent[] {
  const entry = findGame(trace.gameType);
  if (!entry?.create) throw new Error(`Unknown recorded game: ${trace.gameType}`);
  const game = entry.create(trace.rulesetId);
  game.reset(trace.seed);

  let sequence = 0;
  let observationSequence = 0;
  let observationId = traceId(trace, "obs", observationSequence);
  const elapsedUs = (atMs: number) => Math.max(0, Math.round((atMs - trace.startedAtMs) * 1_000));
  const event = (
    eventType: TraceEvent["event_type"],
    visibility: TraceEvent["visibility"],
    payload: Record<string, unknown>,
    atMs: number,
  ): TraceEvent => {
    sequence++;
    return {
      schema_version: 2,
      user_id: PENDING_USER_ID,
      game_id: trace.gameId,
      chunk_id: "chk_pending",
      event_id: traceId(trace, "evt", sequence),
      event_sequence: sequence,
      event_version: 1,
      event_type: eventType,
      visibility,
      client_time_ms: atMs,
      monotonic_time_us: elapsedUs(atMs),
      payload,
    } as TraceEvent;
  };

  const events: TraceEvent[] = [
    event("episode_started", "policy", {
      game_type: trace.gameType,
      game_version: trace.gameVersion,
      ruleset_id: trace.rulesetId,
      telemetry_version: 2,
      platform: "overlay",
      viewport: trace.viewport,
      control_schema: trace.controlSchema,
      input_semantics: "engine_impulse",
    }, trace.startedAtMs),
    event("engine_checkpoint", "privileged", {
      state_version: 1,
      reason: "episode_start",
      state: checkpointState(game),
      seed: trace.seed,
    }, trace.startedAtMs),
    event("observation", "policy", {
      observation_id: observationId,
      representation: "engine_state_v1",
      state: clone(game.state()),
    }, trace.startedAtMs),
  ];

  for (const recorded of trace.actions) {
    const scoreBefore = game.score();
    const control = event("control_changed", "policy", {
      based_on_observation_id: observationId,
      control: recorded.action,
      action: recorded.action,
      kind: "impulse",
      actor: recorded.actor,
    }, recorded.atMs);
    events.push(control);

    const result = game.step(recorded.action);
    observationId = traceId(trace, "obs", ++observationSequence);
    events.push(event("observation", "policy", {
      observation_id: observationId,
      representation: "engine_state_v1",
      state: clone(game.state()),
      caused_by_event_id: control.event_id,
    }, recorded.atMs));
    events.push(event("outcome_changed", "policy", {
      score_before: scoreBefore,
      score_after: game.score(),
      score_delta: game.score() - scoreBefore,
      engine_reward: result.reward,
      reward_spec_id: "engine_v1",
      terminal: result.done,
      caused_by_event_id: control.event_id,
      progress: { moved: result.moved, success: result.success },
    }, recorded.atMs));
    events.push(event("engine_checkpoint", "privileged", {
      state_version: 1,
      reason: result.done ? "terminal" : result.randomEffects === undefined ? "periodic" : "random_outcome",
      state: checkpointState(game),
      ...(result.randomEffects === undefined ? {} : { random_effects: clone(result.randomEffects) }),
      caused_by_event_id: control.event_id,
    }, recorded.atMs));
  }

  if (ending) {
    const { reason, endedAtMs } = ending;
    events.push(event("episode_ended", "policy", {
      reason,
      final_event_sequence: sequence + 1,
      final_score: game.score(),
      duration_us: elapsedUs(endedAtMs),
      completed: reason === "game_over" || reason === "won" || reason === "lost",
    }, endedAtMs));
  }

  return events;
}

function toChunks(
  trace: StoredOverlayTrace,
  groups: TraceEvent[][],
  applicationVersion: string,
): TraceEventChunk[] {
  return groups.map((group, index) => {
    const chunkId = traceId(trace, "chk", index + 1);
    const chunkEvents = group.map((item) => ({ ...item, chunk_id: chunkId }));
    return {
      schema_version: 2,
      user_id: PENDING_USER_ID,
      game_id: trace.gameId,
      game_type: trace.gameType,
      game_version: trace.gameVersion,
      chunk_id: chunkId,
      chunk_sequence: index + 1,
      first_event_sequence: chunkEvents[0]!.event_sequence,
      last_event_sequence: chunkEvents.at(-1)!.event_sequence,
      event_count: chunkEvents.length,
      // Derived from the chunk's own events so a chunk sealed mid-episode and
      // rebuilt at episode end serializes to identical bytes.
      created_at_ms: chunkEvents.at(-1)!.client_time_ms,
      client: {
        platform: "tui",
        application_version: applicationVersion,
        recording_sdk_version: "2",
      },
      events: chunkEvents,
    };
  });
}

export function buildOverlayTraceChunks(
  trace: StoredOverlayTrace,
  reason: EpisodeEndReason,
  applicationVersion: string,
  endedAtMs = Date.now(),
): TraceEventChunk[] {
  const events = buildOverlayTraceEvents(trace, { reason, endedAtMs });
  return toChunks(trace, splitEvents(events), applicationVersion);
}

/**
 * Chunks that are already full for an in-progress episode, so long games reach
 * the local recording store while they are still being played. The trailing
 * partial chunk is withheld until it fills or the episode ends.
 */
export function buildSealedOverlayTraceChunks(
  trace: StoredOverlayTrace,
  applicationVersion: string,
): TraceEventChunk[] {
  const groups = splitEvents(buildOverlayTraceEvents(trace, null));
  return toChunks(trace, groups.slice(0, -1), applicationVersion);
}

export function buildOverlayGameResult(trace: StoredOverlayTrace): Record<string, unknown> | null {
  if (trace.completedScore === undefined || trace.endedAtMs === undefined) return null;
  return {
    result_id: traceId(trace, "res", 1),
    game_id: trace.gameId,
    game_type: trace.gameType,
    score: trace.completedScore,
    completed_at: new Date(trace.endedAtMs).toISOString(),
  };
}
