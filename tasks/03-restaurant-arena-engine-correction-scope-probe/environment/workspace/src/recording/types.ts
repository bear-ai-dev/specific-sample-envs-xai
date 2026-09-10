import type { StepResult } from "../core/game.js";

export {
  RECORDING_SCHEMA_VERSION,
  RECORDING_SDK_VERSION,
} from "@tui-games/trace-export";
export type {
  TerminalColor,
  TerminalCell,
  PositionedTerminalCell,
  TerminalCellChange,
  ObservationCaptureTiming,
  FullTerminalObservation,
  DeltaTerminalObservation,
  TerminalObservation,
  EngineStateObservation,
  PolicyObservation,
  TraceVisibility,
  TraceActor,
  EpisodeEndReason,
  EpisodeStartedTraceEvent,
  ObservationTraceEvent,
  ControlChangedTraceEvent,
  ControlCheckpointTraceEvent,
  OutcomeChangedTraceEvent,
  CheckpointReason,
  EngineCheckpointTraceEvent,
  EpisodeEndedTraceEvent,
  TraceEvent,
  TraceEventChunk,
} from "@tui-games/trace-export";
import type { TraceEvent, TraceEventChunk } from "@tui-games/trace-export";

export type EventSource = "player" | "environment" | "system";
export type ActionSource = Exclude<EventSource, "system">;
export type GameOutcome = "completed" | "abandoned";

interface EventBase {
  event_id: string;
  event_sequence: number;
  event_version: 1;
  source: EventSource;
  client_time_ms: number;
  monotonic_time_ms: number;
}

export interface GameStartedEvent extends EventBase {
  event_type: "game_started";
  source: "system";
  payload: {
    game_type: string;
    game_version: string;
    seed: number;
    initial_state: unknown;
  };
}

export interface ActionEvent extends EventBase {
  event_type: "action";
  source: "player" | "environment";
  payload: {
    action: string;
    state_before: unknown;
    result: Omit<StepResult, "randomEffects">;
    state_after: unknown;
    random_effects?: unknown;
  };
}

export interface GameEndedEvent extends EventBase {
  event_type: "game_ended";
  source: "system";
  payload: {
    outcome: GameOutcome;
    final_state: unknown;
    final_score: number;
    success: boolean;
    final_event_sequence: number;
  };
}

export type GameEvent = GameStartedEvent | ActionEvent | GameEndedEvent;

export interface GameEventChunk {
  schema_version: 1;
  game_id: string;
  game_type: string;
  game_version: string;
  chunk_id: string;
  chunk_sequence: number;
  first_event_sequence: number;
  last_event_sequence: number;
  event_count: number;
  created_at_ms: number;
  client: {
    platform: "tui";
    application_version: string;
    recording_sdk_version: string;
  };
  events: GameEvent[];
}

export type RecordedEvent = GameEvent | TraceEvent;
export type RecordedEventChunk = GameEventChunk | TraceEventChunk;

export function isTraceEvent(event: RecordedEvent): event is TraceEvent {
  return "schema_version" in event && event.schema_version === 2;
}

export function isGameEvent(event: RecordedEvent): event is GameEvent {
  return !("schema_version" in event);
}

export function isTraceEventChunk(chunk: RecordedEventChunk): chunk is TraceEventChunk {
  return chunk.schema_version === 2;
}

export interface PersistedChunk {
  chunk: RecordedEventChunk;
  path: string;
  bytes: string;
}

export interface IngestAcknowledgment {
  accepted: boolean;
  duplicate: boolean;
  game_id: string;
  chunk_id: string;
  chunk_sequence: number;
  accepted_event_range: { first: number; last: number };
  queued: true;
  server_received_at_ms: number;
}

export interface RecordingHealth {
  status: "healthy" | "degraded";
  last_error?: string;
}
