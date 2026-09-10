/**
 * Shared TypeScript contracts for Restaurant Arena (restaurant-arena/v1).
 * Aligns field-for-field with docs/restaurant-arena-state-contract.md,
 * docs/restaurant-arena-tools.md, and retro-backend/esim/contracts.py.
 */

export const STATE_VERSION = "restaurant-arena/v1" as const;
// v2 adds the message inbox v1 had no field for; see DeliveredMessage.
// v1 stays published and readable: a v1 observation is a v2 observation with
// an empty inbox and an older version string.
export const OBSERVATION_VERSION = "restaurant-arena-observation/v2" as const;
export const OBSERVATION_VERSION_V1 = "restaurant-arena-observation/v1" as const;
export const ACTION_VERSION = "restaurant-arena-action/v1" as const;
export const TRACE_VERSION = "restaurant-arena-trace/v1" as const;

export type Role = "host" | "supply_lead" | "chef" | "server";

/** Historical worker role identifier preserved for backward compatibility with old traces. */
export type LegacyRole = "expediter";
export type HistoricalRole = Role | LegacyRole;

export type OrderStatus =
  | "queued"
  | "seated"
  | "preparing"
  | "ready"
  | "served"
  | "cancelled";

export type Priority = "normal" | "high";

export type TableStatus = "empty" | "occupied";

export type EquipmentKind = "oven" | "warming_shelf";

export type EquipmentStatus = "working" | "failed" | "degraded";

export type WorkerLocation = "floor" | "kitchen" | "pass" | "queue";

export type EpisodePhase = "active" | "complete";

export type ActorType = "worker" | "player";

export type Tool =
  | "inspect"
  | "prepare"
  | "serve"
  | "seat"
  | "update_guest"
  | "coordinate"
  | "request_help"
  | "send_message"
  // Player-only tools: never granted to a worker role in ROLE_PERMISSIONS.
  // The human manager overrules the floor through the same validated
  // envelope boundary rather than a separate, unchecked control surface.
  | "approve"
  | "correct";

export type ActionErrorCode =
  | "role_not_permitted"
  | "invalid_arguments"
  | "unknown_entity"
  | "invalid_state"
  | "stale_tick"
  | "duplicate_request"
  | "unsafe_action"
  | "episode_complete"
  /** The open round's manager envelope is already spent (#262). */
  | "round_budget_exhausted";

export interface Episode {
  id: string;
  phase: EpisodePhase;
  tick: number;
  maxTicks: number;
}

export interface Clock {
  minute: number;
  speed: number;
}

export interface Table {
  id: string;
  seats: number;
  status: TableStatus;
  orderId?: string;
}

export interface Order {
  id: string;
  tableId?: string;
  items: string[];
  status: OrderStatus;
  allergy?: string;
  priority: Priority;
}

export interface EquipmentItem {
  id: string;
  kind: EquipmentKind;
  status: EquipmentStatus;
  safetyThreshold?: number;
  reading?: number;
}

export interface WorkerState {
  id: string;
  role: Role;
  load: number;
  location: WorkerLocation;
  lastAction?: string;
}

export interface Emergency {
  kind: "oven_failure";
  active: boolean;
  startedAt: number;
}

export interface Outcomes {
  cash: number;
  satisfaction: number;
  waste: number;
  waitTime: number;
  completed: number;
  safeOrders: number;
  coordination: number;
  correctionUptake: number;
}

export interface RestaurantState {
  version: typeof STATE_VERSION;
  seed: number;
  episode: Episode;
  clock: Clock;
  tables: Table[];
  orders: Order[];
  inventory: Record<string, number>;
  equipment: EquipmentItem[];
  workers: WorkerState[];
  emergency?: Emergency;
  /** Host is holding the door: no new parties are seated until it clears. */
  seatingHeld?: boolean;
  reputation: number;
  outcomes: Outcomes;
}

export interface ActionEnvelope {
  version: typeof ACTION_VERSION;
  episodeId: string;
  actorId: string;
  actorType: ActorType;
  role: Role;
  tool: Tool;
  arguments: Record<string, unknown>;
  tick: number;
  timestamp: string;
  requestId: string;
  idempotencyKey: string;
}

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  retryable: boolean;
}

export interface ActionSuccess {
  accepted: true;
  tick: number;
  state: RestaurantState;
}

export type ActionResult =
  | ActionSuccess
  | { accepted: false; error: ActionError };

// --- Observation Projections ---

export interface ObservedOrder {
  id: string;
  items: string[];
  allergy?: string;
  priority: Priority;
}

export interface ObservedEquipment {
  id: string;
  status: EquipmentStatus;
  /**
   * Measured temperature in °C, when the device has a sensor. Paired with
   * `safetyThreshold` so a role can tell a device that is merely degraded
   * from one that has crossed a food-safety limit, instead of inferring
   * severity from the word "overheat".
   */
  reading?: number;
  /** The food-safety limit in °C. At or above it, the fault is a safety failure. */
  safetyThreshold?: number;
}

/**
 * One `send_message` delivery, as its recipient sees it. Carries
 * `sentAtTick` rather than a timestamp: the simulator has no wall clock, and
 * the tick is what a recipient needs to tell a fresh message from a stale
 * one. Visible on the observation for the tick after it was sent, and on
 * that tick only.
 */
export interface DeliveredMessage {
  from: string;
  text: string;
  priority: Priority;
  sentAtTick: number;
}

export type DirectiveCategory = "safety" | "priority" | "pacing";

/**
 * A standing instruction the player issued mid-shift.
 *
 * Deliberately not part of the observation contract. A `DeliveredMessage` is
 * untrusted peer text visible for exactly one tick; a directive comes from
 * the shift manager, is authoritative, and stays in every targeted worker's
 * prompt context for the rest of the episode. It is injected into the prompt
 * rather than projected into the observation, so player text still cannot
 * reach simulator state except through a validated action envelope.
 */
export interface PlayerDirective {
  id: string;
  category: DirectiveCategory;
  /** What the player asked for, in the player's own words. */
  text: string;
  targetRoles: readonly Role[];
  issuedAtTick: number;
  /** The order the directive is scoped to, when it names one. */
  orderId?: string;
}

export interface ChefObservation {
  version: typeof OBSERVATION_VERSION;
  role: "chef";
  tick: number;
  load: number;
  orders: ObservedOrder[];
  inventory: Record<string, number>;
  equipment: ObservedEquipment[];
  messages?: DeliveredMessage[];
}

export interface ObservedTable {
  id: string;
  orderId?: string;
  status: OrderStatus;
  waitMinutes: number;
}

export interface GuestConstraint {
  orderId: string;
  kind: "allergy" | "dietary" | "timing";
  value?: string;
}

export interface ServerObservation {
  version: typeof OBSERVATION_VERSION;
  role: "server";
  tick: number;
  load: number;
  tables: ObservedTable[];
  guestConstraints: GuestConstraint[];
  messages?: DeliveredMessage[];
}

export interface QueuedParty {
  partyId: string;
  size: number;
  waitMinutes: number;
}

export interface AvailableTable {
  id: string;
  seats: number;
  status: "empty";
}

export interface HostObservation {
  version: typeof OBSERVATION_VERSION;
  role: "host";
  tick: number;
  load: number;
  queue: QueuedParty[];
  tables: AvailableTable[];
  waitEstimateMinutes: number;
  messages?: DeliveredMessage[];
}

export interface HandoffOrder {
  id: string;
  status: OrderStatus;
  priority: Priority;
  handoff: string;
}

export interface ObservedWorker {
  id: string;
  role: Role;
  load: number;
}

export interface ObservedIncident {
  kind: "oven_failure" | "warming_shelf_overheat";
  active: boolean;
  /**
   * Whether the incident crosses a safety limit. `non_safety` incidents are
   * operational: adapt or work around them, do not halt service. Optional so
   * an observation recorded before the field existed still type-checks.
   */
  severity?: IncidentSeverity;
}

export type IncidentSeverity = "safety_critical" | "non_safety";

export interface SupplyLeadObservation {
  version: typeof OBSERVATION_VERSION;
  role: "supply_lead";
  tick: number;
  load: number;
  orders: HandoffOrder[];
  workers: ObservedWorker[];
  incidents: ObservedIncident[];
  messages?: DeliveredMessage[];
}

/** Historical observation contract preserved for reading old traces. */
export interface LegacyExpediterObservation {
  version: typeof OBSERVATION_VERSION | typeof OBSERVATION_VERSION_V1;
  role: "expediter";
  tick: number;
  load: number;
  orders: HandoffOrder[];
  workers: ObservedWorker[];
  incidents: ObservedIncident[];
  messages?: DeliveredMessage[];
}

export type ExpediterObservation = SupplyLeadObservation | LegacyExpediterObservation;

export type Observation =
  | ChefObservation
  | ServerObservation
  | HostObservation
  | SupplyLeadObservation
  | LegacyExpediterObservation;

// --- Runtime Type Guards & Validators ---

export function isRestaurantState(data: unknown): data is RestaurantState {
  if (typeof data !== "object" || data === null) return false;
  const s = data as Record<string, unknown>;

  if (s.version !== STATE_VERSION) return false;
  if (typeof s.seed !== "number" || !Number.isInteger(s.seed)) return false;

  // episode
  if (typeof s.episode !== "object" || s.episode === null) return false;
  const ep = s.episode as Record<string, unknown>;
  if (typeof ep.id !== "string" || !ep.id) return false;
  if (ep.phase !== "active" && ep.phase !== "complete") return false;
  if (typeof ep.tick !== "number" || ep.tick < 0) return false;
  if (typeof ep.maxTicks !== "number" || ep.maxTicks < 1) return false;

  // clock
  if (typeof s.clock !== "object" || s.clock === null) return false;
  const clk = s.clock as Record<string, unknown>;
  if (typeof clk.minute !== "number" || clk.minute < 0) return false;
  if (typeof clk.speed !== "number" || clk.speed < 1) return false;

  // tables
  if (!Array.isArray(s.tables)) return false;
  for (const t of s.tables) {
    if (typeof t !== "object" || t === null) return false;
    if (typeof t.id !== "string" || typeof t.seats !== "number") return false;
    if (t.status !== "empty" && t.status !== "occupied") return false;
  }

  // orders
  if (!Array.isArray(s.orders)) return false;
  const validStatuses = new Set([
    "queued",
    "seated",
    "preparing",
    "ready",
    "served",
    "cancelled",
  ]);
  for (const o of s.orders) {
    if (typeof o !== "object" || o === null) return false;
    if (typeof o.id !== "string" || !Array.isArray(o.items)) return false;
    if (!validStatuses.has(o.status)) return false;
    if (o.priority !== "normal" && o.priority !== "high") return false;
  }

  // inventory
  if (typeof s.inventory !== "object" || s.inventory === null) return false;
  for (const [k, v] of Object.entries(s.inventory)) {
    if (typeof k !== "string" || typeof v !== "number" || v < 0) return false;
  }

  // equipment
  if (!Array.isArray(s.equipment)) return false;
  const validEquipKinds = new Set(["oven", "warming_shelf"]);
  const validEquipStatuses = new Set(["working", "failed", "degraded"]);
  for (const eq of s.equipment) {
    if (typeof eq !== "object" || eq === null) return false;
    if (typeof eq.id !== "string") return false;
    if (!validEquipKinds.has(eq.kind) || !validEquipStatuses.has(eq.status)) return false;
  }

  // workers
  if (!Array.isArray(s.workers)) return false;
  const validRoles = new Set(["host", "supply_lead", "chef", "server", "expediter"]);
  const validLocations = new Set(["floor", "kitchen", "pass", "queue"]);
  for (const w of s.workers) {
    if (typeof w !== "object" || w === null) return false;
    if (typeof w.id !== "string") return false;
    if (!validRoles.has(w.role) || !validLocations.has(w.location)) return false;
    if (typeof w.load !== "number" || w.load < 0 || w.load > 1) return false;
  }

  // reputation
  if (typeof s.reputation !== "number" || s.reputation < 0 || s.reputation > 100) return false;

  // outcomes
  if (typeof s.outcomes !== "object" || s.outcomes === null) return false;
  const out = s.outcomes as Record<string, unknown>;
  const reqOutcomes = [
    "cash",
    "satisfaction",
    "waste",
    "waitTime",
    "completed",
    "safeOrders",
    "coordination",
    "correctionUptake",
  ];
  for (const key of reqOutcomes) {
    if (typeof out[key] !== "number") return false;
  }

  // optional emergency
  if (s.emergency !== undefined && s.emergency !== null) {
    const em = s.emergency as Record<string, unknown>;
    if (em.kind !== "oven_failure") return false;
    if (typeof em.active !== "boolean" || typeof em.startedAt !== "number") return false;
  }

  return true;
}

export function isValidRole(role: unknown): role is Role {
  const validRoles = new Set(["host", "supply_lead", "chef", "server"]);
  return typeof role === "string" && validRoles.has(role);
}

export function isActionEnvelope(data: unknown): data is ActionEnvelope {
  if (typeof data !== "object" || data === null) return false;
  const a = data as Record<string, unknown>;

  if (a.version !== ACTION_VERSION) return false;
  if (typeof a.episodeId !== "string" || !a.episodeId) return false;
  if (typeof a.actorId !== "string" || !a.actorId) return false;
  if (a.actorType !== "worker" && a.actorType !== "player") return false;
  if (a.role !== "host" && a.role !== "supply_lead" && a.role !== "chef" && a.role !== "server" && a.role !== "expediter") return false;
  if (typeof a.tool !== "string" || !a.tool) return false;
  if (typeof a.arguments !== "object" || a.arguments === null) return false;
  if (typeof a.tick !== "number" || a.tick < 0) return false;
  if (typeof a.timestamp !== "string" || !a.timestamp) return false;
  if (typeof a.requestId !== "string" || !a.requestId) return false;
  if (typeof a.idempotencyKey !== "string" || !a.idempotencyKey) return false;

  return true;
}
