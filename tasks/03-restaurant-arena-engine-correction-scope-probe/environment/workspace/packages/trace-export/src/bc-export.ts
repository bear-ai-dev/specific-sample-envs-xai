import type {
  ControlChangedTraceEvent,
  EpisodeStartedTraceEvent,
  ObservationTraceEvent,
  OutcomeChangedTraceEvent,
  PolicyObservation,
  TraceActor,
  TraceEvent,
  TraceEventChunk,
} from "./types.js";

export interface BehaviorCloningSample {
  schema_version: 1;
  user_id: string;
  game_id: string;
  game_type: string;
  game_version: string;
  ruleset_id: string | null;
  event_sequence: number;
  client_time_ms: number;
  control_event_id: string;
  observation_id: string;
  observation: Omit<PolicyObservation, "observation_id" | "caused_by_event_id">;
  action: string;
  actor: TraceActor;
  reward: number | null;
  score_delta: number | null;
  terminal: boolean | null;
  moved: boolean | null;
}

export interface BehaviorCloningExportOptions {
  actors?: readonly TraceActor[];
  includeNoops?: boolean;
}

function policyObservation(
  payload: ObservationTraceEvent["payload"],
): BehaviorCloningSample["observation"] {
  const { observation_id: _observationId, caused_by_event_id: _cause, ...observation } = payload;
  return observation;
}

function orderedUniqueEvents(chunks: readonly TraceEventChunk[]): TraceEvent[] {
  const events = new Map<string, TraceEvent>();
  for (const chunk of chunks) {
    if (chunk.schema_version !== 2) continue;
    for (const event of chunk.events) events.set(event.event_id, event);
  }
  return [...events.values()].sort((left, right) =>
    left.game_id.localeCompare(right.game_id) ||
    left.event_sequence - right.event_sequence
  );
}

export function extractBehaviorCloningSamples(
  chunks: readonly TraceEventChunk[],
  options: BehaviorCloningExportOptions = {},
): BehaviorCloningSample[] {
  const actors = new Set(options.actors ?? ["human"]);
  const events = orderedUniqueEvents(chunks);
  const observations = new Map<string, ObservationTraceEvent>();
  const outcomes = new Map<string, OutcomeChangedTraceEvent>();
  const rulesets = new Map<string, string>();
  const chunksByGame = new Map(chunks.map((chunk) => [chunk.game_id, chunk]));

  for (const event of events) {
    if (event.event_type === "observation") {
      observations.set(event.payload.observation_id, event);
    } else if (event.event_type === "outcome_changed") {
      outcomes.set(event.payload.caused_by_event_id, event);
    } else if (event.event_type === "episode_started") {
      rulesets.set(event.game_id, (event as EpisodeStartedTraceEvent).payload.ruleset_id);
    }
  }

  const samples: BehaviorCloningSample[] = [];
  for (const event of events) {
    if (event.event_type !== "control_changed") continue;
    const control = event as ControlChangedTraceEvent;
    if (!actors.has(control.payload.actor) || !control.payload.based_on_observation_id) continue;
    const observation = observations.get(control.payload.based_on_observation_id);
    if (!observation || observation.game_id !== control.game_id) continue;
    const outcome = outcomes.get(control.event_id);
    const moved = typeof outcome?.payload.progress?.moved === "boolean"
      ? outcome.payload.progress.moved
      : null;
    if (!options.includeNoops && moved === false) continue;
    const chunk = chunksByGame.get(control.game_id);
    if (!chunk) continue;

    samples.push({
      schema_version: 1,
      user_id: control.user_id,
      game_id: control.game_id,
      game_type: chunk.game_type,
      game_version: chunk.game_version,
      ruleset_id: rulesets.get(control.game_id) ?? null,
      event_sequence: control.event_sequence,
      client_time_ms: control.client_time_ms,
      control_event_id: control.event_id,
      observation_id: observation.payload.observation_id,
      observation: policyObservation(observation.payload),
      action: control.payload.action,
      actor: control.payload.actor,
      reward: outcome?.payload.engine_reward ?? null,
      score_delta: outcome?.payload.score_delta ?? null,
      terminal: outcome?.payload.terminal ?? null,
      moved,
    });
  }
  return samples;
}

export type DatasetSplit = "train" | "validation" | "test";

export function splitForGame(gameId: string): DatasetSplit {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(gameId)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const bucket = hash % 100;
  if (bucket < 90) return "train";
  if (bucket < 95) return "validation";
  return "test";
}
