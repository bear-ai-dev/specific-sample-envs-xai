import { RestaurantGame, type ArenaInputRecord } from "./restaurant-game.js";
import { ARENA_ENV_VERSION, computeStateHash, validateArenaTraceV3, type RestaurantArenaTraceV3 } from "./trace.js";
import type { RestaurantState, Role } from "./types.js";

/** Normalize legacy worker role and ID (expediter -> supply_lead) for initial-state comparison. */
export function normalizeLegacyInitialState(state: Record<string, unknown>): Record<string, unknown> {
  const workers = Array.isArray(state.workers)
    ? state.workers.map((w: any) => {
        const isLegacyRole = w?.role === "expediter";
        const isLegacyId = w?.id === "worker-expediter";
        if (isLegacyRole || isLegacyId) {
          return {
            ...w,
            id: isLegacyId ? "worker-supply_lead" : w.id,
            role: isLegacyRole ? "supply_lead" : w.role,
          };
        }
        return w;
      })
    : state.workers;
  return { ...state, workers };
}

function toLegacyWorkerRepresentation(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(toLegacyWorkerRepresentation);
  const record = obj as Record<string, unknown>;
  const res: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === "workers" && Array.isArray(v)) {
      res[k] = v.map((w: Record<string, unknown>) => {
        if (w.role === "supply_lead" || w.id === "worker-supply_lead") {
          return {
            ...w,
            id: w.id === "worker-supply_lead" ? "worker-expediter" : w.id,
            role: w.role === "supply_lead" ? "expediter" : w.role,
          };
        }
        return w;
      });
    } else {
      res[k] = toLegacyWorkerRepresentation(v);
    }
  }
  return res;
}

/** Native replay from input zero; never apply the derived event diary as actions. */
export function replayArenaTrace(trace: RestaurantArenaTraceV3): RestaurantGame {
  const validation = validateArenaTraceV3(trace);
  if (!validation.valid) throw new Error(validation.errors.join("\n"));
  if (trace.envVersion !== ARENA_ENV_VERSION) throw new Error("Arena environment version does not match this build");
  const game = new RestaurantGame(trace.seed, trace.replay.variation);
  const engineInitialHash = computeStateHash(normalizeLegacyInitialState(game.getInitialState()));
  const traceInitialHash = computeStateHash(normalizeLegacyInitialState(trace.initialState));
  if (engineInitialHash !== traceInitialHash) throw new Error("Initial state differs from this engine");
  for (const [index, input] of trace.replay.inputs.entries()) {
    applyArenaReplayInput(game, input, index);
  }
  const currentFinalHash = computeStateHash(game.checkpointState());
  if (currentFinalHash !== trace.replay.finalStateHash) {
    if (computeStateHash(toLegacyWorkerRepresentation(game.checkpointState())) !== trace.replay.finalStateHash) {
      throw new Error("Final checkpoint mismatch");
    }
  }
  if (trace.terminal.status === "abandoned") game.markAbandoned(trace.terminal.reason ?? "abandoned");
  if (JSON.stringify(game.getTerminalStatus()) !== JSON.stringify(trace.terminal)) throw new Error("Terminal status mismatch");
  return game;
}

export function applyArenaReplayInput(game: RestaurantGame, input: ArenaInputRecord, index: number): void {
    if (game.state().episode.tick !== input.tick) throw new Error(`Input ${index}: tick mismatch`);
    switch (input.kind) {
      case "step":
        if (!game.actions.includes(input.action)) throw new Error(`Input ${index}: unknown game action`);
        game.step(input.action); break;
      case "time": game.advanceTime(); break;
      case "envelope": game.stepEnvelope(input.envelope, input.telemetry); break;
      case "controllers": game.setExternalControllers(input.roles); break;
      default: throw new Error(`Input ${index}: unknown input kind`);
    }
    const currentCheckpointHash = computeStateHash(game.checkpointState());
    if (currentCheckpointHash !== input.stateHash) {
      if (computeStateHash(toLegacyWorkerRepresentation(game.checkpointState())) !== input.stateHash) {
        throw new Error(`Input ${index}: checkpoint mismatch`);
      }
    }
    if (input.restaurantStateHash !== undefined && computeStateHash(game.state()) !== input.restaurantStateHash) {
      if (computeStateHash(toLegacyWorkerRepresentation(game.state())) !== input.restaurantStateHash) {
        throw new Error(`Input ${index}: RestaurantState checkpoint mismatch`);
      }
    }
}
