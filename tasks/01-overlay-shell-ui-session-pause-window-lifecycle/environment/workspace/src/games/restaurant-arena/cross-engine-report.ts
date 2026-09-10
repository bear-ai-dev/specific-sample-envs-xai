import { RestaurantGame } from "./restaurant-game.js";
import type { OrderStatus, Priority, Role } from "./types.js";
import fixture from "../../../contracts/fixtures/restaurant-arena-cross-engine-v2.json" with { type: "json" };

export const CROSS_ENGINE_ROLES = ["host", "supply_lead", "chef", "server"] as const;
export type CrossEngineRole = (typeof CROSS_ENGINE_ROLES)[number];

export interface CrossEngineRecord {
  scenario: "routine" | "incident" | "manager-correction";
  accepted: boolean;
  tick: number;
  /** Every published fixture step actually applied to this isolated run. */
  steps: readonly CrossEngineStep[];
  orders: Array<{ id: string; priority: Priority; status: OrderStatus }>;
  oven: { status: string; emergency: boolean };
  outcomes: ReturnType<RestaurantGame["state"]>["outcomes"];
  stateChanged: boolean;
  canonicalRoles: readonly CrossEngineRole[];
}

type CrossEngineScenario = CrossEngineRecord["scenario"];
type CrossEngineStep =
  | { kind: "priority"; tick: number; role: CrossEngineRole; orderId: string; priority: Priority }
  | { kind: "advance"; tick: number }
  | { kind: "correction"; tick: number; role: CrossEngineRole; text: string; managerCorrection?: boolean };

export type CrossEngineFixture = {
  scenarios: Array<{ id: CrossEngineScenario; steps: CrossEngineStep[] }>;
};

const nativeRole = (role: CrossEngineRole): Role => role;

function record(
  game: RestaurantGame,
  scenario: CrossEngineScenario,
  steps: readonly CrossEngineStep[],
  accepted: boolean,
  stateChanged: boolean,
): CrossEngineRecord {
  const state = game.state();
  return {
    scenario,
    accepted,
    tick: state.episode.tick,
    steps,
    orders: state.orders.map(({ id, priority, status }) => ({ id, priority, status })),
    oven: { status: state.equipment.find(({ id }) => id === "oven-1")?.status ?? "unknown", emergency: state.emergency?.active === true },
    outcomes: { ...state.outcomes },
    stateChanged,
    canonicalRoles: CROSS_ENGINE_ROLES,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function validateCrossEngineFixture(value: unknown): CrossEngineFixture {
  if (!isRecord(value) || !Array.isArray(value.scenarios)) throw new Error("cross-engine fixture must contain scenarios");
  const scenarios: CrossEngineFixture["scenarios"] = [];
  for (const scenario of value.scenarios) {
    if (!isRecord(scenario) || !["routine", "incident", "manager-correction"].includes(String(scenario.id)) || !Array.isArray(scenario.steps) || scenario.steps.length !== 1) {
      throw new Error("cross-engine fixture scenarios must contain exactly one valid step");
    }
    const step = scenario.steps[0];
    if (!isRecord(step) || !Number.isInteger(step.tick) || (step.tick as number) < 0) throw new Error("cross-engine fixture step has an invalid tick");
    if (step.kind === "advance") {
      if (Object.keys(step).some((key) => !["kind", "tick"].includes(key))) throw new Error("cross-engine fixture advance step has invalid fields");
      scenarios.push({ id: scenario.id as CrossEngineScenario, steps: [{ kind: "advance", tick: step.tick as number }] });
      continue;
    }
    if (step.kind === "priority" && ["host", "supply_lead", "chef", "server"].includes(String(step.role)) && typeof step.orderId === "string" && step.orderId.length > 0 && ["normal", "high"].includes(String(step.priority))) {
      scenarios.push({ id: scenario.id as CrossEngineScenario, steps: [{ kind: "priority", tick: step.tick as number, role: step.role as CrossEngineRole, orderId: step.orderId, priority: step.priority as Priority }] });
      continue;
    }
    if (step.kind === "correction" && ["host", "supply_lead", "chef", "server"].includes(String(step.role)) && typeof step.text === "string" && step.text.length > 0 && (step.managerCorrection === undefined || typeof step.managerCorrection === "boolean")) {
      scenarios.push({ id: scenario.id as CrossEngineScenario, steps: [{ kind: "correction", tick: step.tick as number, role: step.role as CrossEngineRole, text: step.text, ...(step.managerCorrection === undefined ? {} : { managerCorrection: step.managerCorrection }) }] });
      continue;
    }
    throw new Error("cross-engine fixture step has invalid fields");
  }
  const typed = { scenarios };
  const ids = typed.scenarios.map(({ id }) => id);
  if (
    typed.scenarios.length !== 3
    || (["routine", "incident", "manager-correction"] as const).some((id) => ids.filter((candidate) => candidate === id).length !== 1)
  ) throw new Error("cross-engine fixture must contain exactly one routine, incident, and manager-correction scenario");
  return typed;
}

function crossEngineFixture(): CrossEngineFixture {
  return validateCrossEngineFixture(fixture);
}

function executeStep(game: RestaurantGame, step: CrossEngineStep): boolean {
  if (!Number.isInteger(step.tick) || step.tick < game.state().episode.tick) {
    throw new Error(`cross-engine fixture step has an invalid tick: ${step.tick}`);
  }
  while (game.state().episode.tick < step.tick) {
    const before = game.state().episode.tick;
    game.advanceTime();
    if (game.state().episode.tick === before) throw new Error(`cross-engine fixture step cannot reach tick ${step.tick}`);
  }
  if (step.kind === "advance") return true;
  if (step.kind === "priority") {
    return game.submitPlayerIntervention({
      kind: "priority",
      targetRole: nativeRole(step.role),
      orderId: step.orderId,
      priority: step.priority,
    }).accepted;
  }
  return game.submitPlayerIntervention({
    kind: "correction",
    targetRole: nativeRole(step.role),
    text: step.text,
  }).accepted;
}

/** Execute the three shared cases against the native engine at its v1 boundary. */
export function runCrossEngineReport(seed = 218220): CrossEngineRecord[] {
  return crossEngineFixture().scenarios.map(({ id, steps }) => {
    const game = new RestaurantGame(seed);
    const initial = game.state();
    let accepted = true;
    for (const step of steps) accepted = executeStep(game, step) && accepted;
    return record(game, id, steps, accepted, JSON.stringify(initial) !== JSON.stringify(game.state()));
  });
}
