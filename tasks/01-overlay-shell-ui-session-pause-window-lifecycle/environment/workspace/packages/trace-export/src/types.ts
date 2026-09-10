export const RECORDING_SCHEMA_VERSION = 2 as const;
export const RECORDING_SDK_VERSION = "2";

export type TerminalColor = number | string | null;

export interface TerminalCell {
  glyph: string;
  foreground: TerminalColor;
  background: TerminalColor;
  attributes: number;
  width: number;
}

export interface PositionedTerminalCell extends TerminalCell {
  x: number;
  y: number;
}

export interface TerminalCellChange {
  x: number;
  y: number;
  cell: TerminalCell | null;
}

export interface ObservationCaptureTiming {
  generated_time_us: number;
  delivered_time_us: number;
  dropped_observations: number;
}

export interface FullTerminalObservation {
  observation_id: string;
  representation: "terminal_grid_v1";
  width: number;
  height: number;
  state_hash: string;
  cells: PositionedTerminalCell[];
  capture_timing?: ObservationCaptureTiming;
  caused_by_event_id?: string;
}

export interface DeltaTerminalObservation {
  observation_id: string;
  representation: "terminal_grid_delta_v1";
  base_observation_id: string;
  width: number;
  height: number;
  state_hash: string;
  changed_cells: TerminalCellChange[];
  capture_timing?: ObservationCaptureTiming;
  caused_by_event_id?: string;
}

export type TerminalObservation = FullTerminalObservation | DeltaTerminalObservation;

export interface EngineStateObservation {
  observation_id: string;
  representation: "engine_state_v1";
  state: unknown;
  caused_by_event_id?: string;
}

export type PolicyObservation = TerminalObservation | EngineStateObservation;

export type TraceVisibility = "policy" | "privileged";
export type TraceActor = "human" | "model" | "heuristic" | "random" | "environment";
export type EpisodeEndReason =
  | "game_over"
  | "won"
  | "lost"
  | "user_quit"
  | "restart"
  | "timeout"
  | "client_closed"
  | "engine_error";

interface TraceEventBase {
  schema_version: typeof RECORDING_SCHEMA_VERSION;
  user_id: string;
  game_id: string;
  chunk_id: string;
  event_id: string;
  event_sequence: number;
  event_version: 1;
  event_type: string;
  visibility: TraceVisibility;
  client_time_ms: number;
  monotonic_time_us: number;
  simulation_tick?: number;
  payload: unknown;
}

export interface EpisodeStartedTraceEvent extends TraceEventBase {
  event_type: "episode_started";
  visibility: "policy";
  payload: {
    game_type: string;
    game_version: string;
    ruleset_id: string;
    telemetry_version: 2;
    platform: "tui" | "overlay";
    viewport: { width: number; height: number };
    control_schema: string[];
    input_semantics: "terminal_impulse" | "engine_impulse";
  };
}

export interface ObservationTraceEvent extends TraceEventBase {
  event_type: "observation";
  visibility: "policy";
  payload: PolicyObservation;
}

export interface ControlChangedTraceEvent extends TraceEventBase {
  event_type: "control_changed";
  visibility: "policy";
  payload: {
    based_on_observation_id: string | null;
    control: string;
    action: string;
    kind: "impulse";
    actor: TraceActor;
    action_received_us?: number;
  };
}

export interface ControlCheckpointTraceEvent extends TraceEventBase {
  event_type: "control_checkpoint";
  visibility: "policy";
  payload: {
    held_controls: string[];
    input_semantics: "terminal_impulse" | "engine_impulse";
  };
}

export interface OutcomeChangedTraceEvent extends TraceEventBase {
  event_type: "outcome_changed";
  visibility: "policy";
  payload: {
    score_before: number;
    score_after: number;
    score_delta: number;
    engine_reward: number;
    reward_spec_id: "engine_v1";
    terminal: boolean;
    caused_by_event_id: string;
    progress?: Record<string, number | string | boolean | null>;
    performance?: {
      action_received_us: number;
      action_applied_us: number;
      action_completed_us: number;
      queueing_delay_us: number;
      simulation_tick_duration_us: number;
    };
  };
}

export type CheckpointReason =
  | "episode_start"
  | "periodic"
  | "random_outcome"
  | "terminal"
  | "episode_end";

export interface EngineCheckpointTraceEvent extends TraceEventBase {
  event_type: "engine_checkpoint";
  visibility: "privileged";
  payload: {
    state_version: 1;
    reason: CheckpointReason;
    state: unknown;
    state_hash?: string;
    seed?: number;
    random_effects?: unknown;
    caused_by_event_id?: string;
  };
}

export interface EpisodeEndedTraceEvent extends TraceEventBase {
  event_type: "episode_ended";
  visibility: "policy";
  payload: {
    reason: EpisodeEndReason;
    final_event_sequence: number;
    final_score: number;
    duration_us: number;
    completed: boolean;
  };
}

export type TraceEvent =
  | EpisodeStartedTraceEvent
  | ObservationTraceEvent
  | ControlChangedTraceEvent
  | ControlCheckpointTraceEvent
  | OutcomeChangedTraceEvent
  | EngineCheckpointTraceEvent
  | EpisodeEndedTraceEvent;

export interface TraceEventChunk {
  schema_version: typeof RECORDING_SCHEMA_VERSION;
  user_id: string;
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
  events: TraceEvent[];
}
