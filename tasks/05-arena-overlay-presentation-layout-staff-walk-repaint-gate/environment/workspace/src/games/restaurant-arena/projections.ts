import {
  OBSERVATION_VERSION,
  type AvailableTable,
  type ChefObservation,
  type DeliveredMessage,
  type EquipmentItem,
  type ExpediterObservation,
  type GuestConstraint,
  type HandoffOrder,
  type HostObservation,
  type IncidentSeverity,
  type Observation,
  type QueuedParty,
  type ObservedEquipment,
  type ObservedIncident,
  type ObservedOrder,
  type ObservedTable,
  type ObservedWorker,
  type OrderStatus,
  type RestaurantState,
  type Role,
  type ServerObservation,
  type SupplyLeadObservation,
  type Table,
  type Tool,
} from "./types.js";

export const ACTIVE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "queued",
  "seated",
  "preparing",
  "ready",
]);

export const HANDOFF_BY_ORDER_STATUS: Record<OrderStatus, "kitchen" | "pass" | "floor"> = {
  queued: "kitchen",
  seated: "kitchen",
  preparing: "kitchen",
  ready: "pass",
  served: "floor",
  cancelled: "floor",
};

export const ROLE_PERMISSIONS: Record<Role | "expediter", readonly Tool[]> = {
  host: ["inspect", "seat", "update_guest", "request_help", "send_message"],
  supply_lead: ["inspect", "coordinate", "request_help", "send_message"],
  chef: ["inspect", "prepare", "request_help", "send_message"],
  server: ["inspect", "serve", "seat", "update_guest", "request_help", "send_message"],
  expediter: ["inspect", "coordinate", "request_help", "send_message"],
};

export function workerLoad(state: RestaurantState, role: Role | "expediter"): number {
  const canonical = role === "expediter" ? "supply_lead" : role;
  const worker = state.workers.find((w) => w.role === canonical || (canonical === "supply_lead" && (w.role as string) === "expediter"));
  if (!worker) throw new Error(`no worker occupies role ${role}`);
  return worker.load;
}

export function tableWaitMinutes(state: RestaurantState, table: Table): number {
  if (!table.orderId) return 0;
  const order = state.orders.find((o) => o.id === table.orderId);
  if (!order || !ACTIVE_ORDER_STATUSES.has(order.status)) return 0;
  return state.clock.minute;
}

export function orderStatusForTable(state: RestaurantState, table: Table): OrderStatus {
  if (!table.orderId) return "queued";
  const order = state.orders.find((o) => o.id === table.orderId);
  return order?.status ?? "queued";
}

/**
 * A device is a safety failure once its reading reaches its limit, and an
 * operational fault below it. With no sensor to read, a failed device is
 * treated as safety-critical and a degraded one as operational.
 */
export function equipmentSeverity(equipment: EquipmentItem): IncidentSeverity {
  if (equipment.reading !== undefined && equipment.safetyThreshold !== undefined) {
    return equipment.reading >= equipment.safetyThreshold ? "safety_critical" : "non_safety";
  }
  return equipment.status === "failed" ? "safety_critical" : "non_safety";
}

/** What a role can see of one device, including its reading when it has one. */
export function observeEquipment(equipment: EquipmentItem): ObservedEquipment {
  const observed: ObservedEquipment = { id: equipment.id, status: equipment.status };
  if (equipment.reading !== undefined) observed.reading = equipment.reading;
  if (equipment.safetyThreshold !== undefined) observed.safetyThreshold = equipment.safetyThreshold;
  return observed;
}

export function observedIncidents(state: RestaurantState): ObservedIncident[] {
  const incidents: ObservedIncident[] = [];
  if (state.emergency) {
    // A dead oven under live tickets is the safety-critical beat of the shift.
    incidents.push({ kind: state.emergency.kind, active: state.emergency.active, severity: "safety_critical" });
  }
  for (const equipment of state.equipment) {
    if (equipment.kind === "warming_shelf" && equipment.status !== "working") {
      incidents.push({
        kind: "warming_shelf_overheat",
        active: true,
        severity: equipmentSeverity(equipment),
      });
    }
  }
  return incidents;
}

/**
 * Pure projection: RestaurantState -> ChefObservation
 */
export function projectChefObservation(
  state: RestaurantState,
  messages: DeliveredMessage[] = [],
): ChefObservation {
  const orders: ObservedOrder[] = state.orders
    .filter((o) => ACTIVE_ORDER_STATUSES.has(o.status))
    .map((o) => ({ id: o.id, items: [...o.items], allergy: o.allergy, priority: o.priority }));
  const equipment: ObservedEquipment[] = state.equipment.map(observeEquipment);
  return {
    version: OBSERVATION_VERSION,
    role: "chef",
    tick: state.episode.tick,
    load: workerLoad(state, "chef"),
    messages: [...messages],
    orders,
    inventory: { ...state.inventory },
    equipment,
  };
}

/**
 * Pure projection: RestaurantState -> ServerObservation
 */
export function projectServerObservation(
  state: RestaurantState,
  messages: DeliveredMessage[] = [],
): ServerObservation {
  const tables: ObservedTable[] = state.tables
    .filter((t) => t.status === "occupied")
    .map((t) => ({
      id: t.id,
      orderId: t.orderId,
      status: orderStatusForTable(state, t),
      waitMinutes: tableWaitMinutes(state, t),
    }));
  const guestConstraints: GuestConstraint[] = state.orders
    .filter((o) => o.allergy !== undefined)
    .map((o) => ({ orderId: o.id, kind: "allergy", value: o.allergy }));
  return {
    version: OBSERVATION_VERSION,
    role: "server",
    tick: state.episode.tick,
    load: workerLoad(state, "server"),
    messages: [...messages],
    tables,
    guestConstraints,
  };
}

/**
 * Pure projection: RestaurantState -> HostObservation
 */
export function projectHostObservation(
  state: RestaurantState,
  messages: DeliveredMessage[] = [],
  queue: QueuedParty[] = [],
): HostObservation {
  const empty = state.tables.filter((t) => t.status === "empty");
  const occupied = state.tables.filter((t) => t.status === "occupied");
  const doorWait = queue.reduce((sum, party) => sum + party.waitMinutes, 0);
  const waitEstimateMinutes =
    empty.length > 0 || occupied.length === 0
      ? Math.max(0, doorWait)
      : Math.max(5 * occupied.length, doorWait);
  const tables: AvailableTable[] = empty.map((t) => ({ id: t.id, seats: t.seats, status: "empty" }));
  return {
    version: OBSERVATION_VERSION,
    role: "host",
    tick: state.episode.tick,
    load: workerLoad(state, "host"),
    messages: [...messages],
    queue: [...queue],
    tables,
    waitEstimateMinutes,
  };
}

/**
 * Pure projection: RestaurantState -> SupplyLeadObservation
 */
export function projectSupplyLeadObservation(
  state: RestaurantState,
  messages: DeliveredMessage[] = [],
): SupplyLeadObservation {
  const orders: HandoffOrder[] = state.orders
    .filter((o) => ACTIVE_ORDER_STATUSES.has(o.status))
    .map((o) => ({ id: o.id, status: o.status, priority: o.priority, handoff: HANDOFF_BY_ORDER_STATUS[o.status] }));
  const workers: ObservedWorker[] = state.workers.map((w) => ({ id: w.id, role: w.role, load: w.load }));
  return {
    version: OBSERVATION_VERSION,
    role: "supply_lead",
    tick: state.episode.tick,
    load: workerLoad(state, "supply_lead"),
    messages: [...messages],
    orders,
    workers,
    incidents: observedIncidents(state),
  };
}

/** @deprecated Historical alias for traces/tests referencing projectExpediterObservation. */
export const projectExpediterObservation = projectSupplyLeadObservation;

/**
 * Dispatching projection for any valid role
 */
export function projectObservation(
  state: RestaurantState,
  role: Role | "expediter",
  messages: DeliveredMessage[] = [],
  queue: QueuedParty[] = [],
): Observation {
  switch (role) {
    case "host":
      return projectHostObservation(state, messages, queue);
    case "supply_lead":
    case "expediter":
      return projectSupplyLeadObservation(state, messages);
    case "chef":
      return projectChefObservation(state, messages);
    case "server":
      return projectServerObservation(state, messages);
  }
}
