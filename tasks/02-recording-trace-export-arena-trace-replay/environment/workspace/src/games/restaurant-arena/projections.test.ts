import { describe, expect, it } from "bun:test";
import fixture from "../../../contracts/fixtures/restaurant-arena-v1.json" with { type: "json" };
import {
  projectChefObservation,
  projectServerObservation,
  projectHostObservation,
  projectSupplyLeadObservation,
  projectExpediterObservation,
  projectObservation,
  ROLE_PERMISSIONS,
  workerLoad,
  tableWaitMinutes,
  orderStatusForTable,
  observedIncidents,
  observeEquipment,
  equipmentSeverity,
} from "./projections.js";
import {
  OBSERVATION_VERSION,
  type DeliveredMessage,
  type RestaurantState,
} from "./types.js";

describe("Restaurant Arena Role Projections (#248)", () => {
  const baseState: RestaurantState = JSON.parse(JSON.stringify(fixture)) as RestaurantState;

  it("exposes strict role permissions matching the specification", () => {
    expect(ROLE_PERMISSIONS.host).toEqual(["inspect", "seat", "update_guest", "request_help", "send_message"]);
    expect(ROLE_PERMISSIONS.supply_lead).toEqual(["inspect", "coordinate", "request_help", "send_message"]);
    expect(ROLE_PERMISSIONS.chef).toEqual(["inspect", "prepare", "request_help", "send_message"]);
    expect(ROLE_PERMISSIONS.server).toEqual(["inspect", "serve", "seat", "update_guest", "request_help", "send_message"]);
    expect(ROLE_PERMISSIONS.expediter).toEqual(["inspect", "coordinate", "request_help", "send_message"]);
  });

  it("does not mutate the source RestaurantState", () => {
    const originalJson = JSON.stringify(baseState);
    const messages: DeliveredMessage[] = [
      { from: "worker-supply_lead", text: "Rush table 2", priority: "high", sentAtTick: 1 },
    ];

    projectChefObservation(baseState, messages);
    projectServerObservation(baseState, messages);
    projectHostObservation(baseState, messages);
    projectSupplyLeadObservation(baseState, messages);
    projectExpediterObservation(baseState, messages);

    expect(JSON.stringify(baseState)).toBe(originalJson);
  });

  describe("projectChefObservation", () => {
    it("projects chef view with active orders, inventory, and equipment", () => {
      const chefObs = projectChefObservation(baseState);
      expect(chefObs.version).toBe(OBSERVATION_VERSION);
      expect(chefObs.role).toBe("chef");
      expect(chefObs.tick).toBe(baseState.episode.tick);
      expect(chefObs.load).toBe(0);
      expect(chefObs.messages).toEqual([]);
      expect(chefObs.inventory).toEqual(baseState.inventory);
      expect(chefObs.equipment).toHaveLength(baseState.equipment.length);
      expect(chefObs.orders).toHaveLength(2);
      expect(chefObs.orders[0]).toEqual({
        id: "order-1",
        items: ["pasta"],
        allergy: undefined,
        priority: "normal",
      });
      expect(chefObs.orders[1]).toEqual({
        id: "order-2",
        items: ["fish"],
        allergy: "peanut",
        priority: "high",
      });
    });

    it("filters out served and cancelled orders for chef", () => {
      const stateWithCompleted: RestaurantState = {
        ...baseState,
        orders: [
          ...baseState.orders,
          { id: "order-served", items: ["pasta"], status: "served", priority: "normal" },
          { id: "order-cancelled", items: ["fish"], status: "cancelled", priority: "normal" },
        ],
      };
      const obs = projectChefObservation(stateWithCompleted);
      expect(obs.orders.map((o) => o.id)).not.toContain("order-served");
      expect(obs.orders.map((o) => o.id)).not.toContain("order-cancelled");
    });
  });

  describe("projectServerObservation", () => {
    it("projects server view with occupied tables and guest constraints", () => {
      const serverObs = projectServerObservation(baseState);
      expect(serverObs.version).toBe(OBSERVATION_VERSION);
      expect(serverObs.role).toBe("server");
      expect(serverObs.tick).toBe(baseState.episode.tick);
      expect(serverObs.load).toBe(0);
      expect(serverObs.tables).toHaveLength(2); // table-1 and table-2 are occupied in fixture
      expect(serverObs.guestConstraints).toEqual([
        { orderId: "order-2", kind: "allergy", value: "peanut" },
      ]);
    });

    it("calculates table wait minutes from clock minute for active orders", () => {
      const stateAtMinute5: RestaurantState = {
        ...baseState,
        clock: { minute: 5, speed: 1 },
      };
      const obs = projectServerObservation(stateAtMinute5);
      expect(obs.tables[0]?.waitMinutes).toBe(5);
    });
  });

  describe("projectHostObservation", () => {
    it("projects host view with empty capacity tables and wait estimate", () => {
      const hostObs = projectHostObservation(baseState);
      expect(hostObs.version).toBe(OBSERVATION_VERSION);
      expect(hostObs.role).toBe("host");
      expect(hostObs.tick).toBe(baseState.episode.tick);
      expect(hostObs.tables).toEqual([{ id: "table-3", seats: 2, status: "empty" }]);
      expect(hostObs.waitEstimateMinutes).toBe(0); // empty tables available
    });

    it("shows the live door queue when one is provided", () => {
      const obs = projectHostObservation(baseState, [], [
        { partyId: "party-1", size: 2, waitMinutes: 3 },
      ]);
      expect(obs.queue).toEqual([{ partyId: "party-1", size: 2, waitMinutes: 3 }]);
      expect(obs.waitEstimateMinutes).toBe(3);
    });

    it("calculates waitEstimateMinutes when all tables are occupied", () => {
      const fullyOccupiedState: RestaurantState = {
        ...baseState,
        tables: baseState.tables.map((t) => ({ ...t, status: "occupied" })),
      };
      const obs = projectHostObservation(fullyOccupiedState);
      expect(obs.waitEstimateMinutes).toBe(15); // 3 occupied * 5
      expect(obs.tables).toHaveLength(0);
    });
  });

  describe("projectSupplyLeadObservation", () => {
    it("projects supply lead view with handoffs, workers, and incidents", () => {
      const supplyLeadObs = projectSupplyLeadObservation(baseState);
      expect(supplyLeadObs.version).toBe(OBSERVATION_VERSION);
      expect(supplyLeadObs.role).toBe("supply_lead");
      expect(supplyLeadObs.tick).toBe(baseState.episode.tick);
      expect(supplyLeadObs.orders).toHaveLength(2);
      expect(supplyLeadObs.orders[0]).toEqual({
        id: "order-1",
        status: "queued",
        priority: "normal",
        handoff: "kitchen",
      });
      expect(supplyLeadObs.workers).toHaveLength(4);
      expect(supplyLeadObs.incidents).toEqual([
        { kind: "oven_failure", active: false, severity: "safety_critical" },
      ]);

      const expediterObs = projectExpediterObservation(baseState);
      expect(expediterObs.role).toBe("supply_lead");
    });

    it("marks a shelf at or over its limit as safety-critical", () => {
      const overLimit: RestaurantState = {
        ...baseState,
        equipment: [
          { id: "shelf-1", kind: "warming_shelf", status: "degraded", safetyThreshold: 70, reading: 71 },
        ],
      };
      expect(projectSupplyLeadObservation(overLimit).incidents).toEqual([
        { kind: "oven_failure", active: false, severity: "safety_critical" },
        { kind: "warming_shelf_overheat", active: true, severity: "safety_critical" },
      ]);
    });

    it("surfaces emergency and degraded warming shelf incidents", () => {
      const incidentState: RestaurantState = {
        ...baseState,
        emergency: { kind: "oven_failure", active: true, startedAt: 8 },
        equipment: [
          ...baseState.equipment,
          { id: "shelf-1", kind: "warming_shelf", status: "degraded", safetyThreshold: 75, reading: 68 },
        ],
      };
      const obs = projectSupplyLeadObservation(incidentState);
      // The shelf sits at 68°C under a 75°C limit: an operational fault the
      // supply lead must not run the emergency protocol over.
      expect(obs.incidents).toEqual([
        { kind: "oven_failure", active: true, severity: "safety_critical" },
        { kind: "warming_shelf_overheat", active: true, severity: "non_safety" },
      ]);
    });
  });

  describe("equipment readings", () => {
    const sensedState: RestaurantState = {
      ...baseState,
      equipment: [
        { id: "oven-1", kind: "oven", status: "failed" },
        { id: "warming-shelf-1", kind: "warming_shelf", status: "degraded", safetyThreshold: 70, reading: 68 },
      ],
    };

    it("passes the reading and safety limit through to the chef observation", () => {
      const equipment = projectChefObservation(sensedState).equipment;
      expect(equipment).toEqual([
        { id: "oven-1", status: "failed" },
        { id: "warming-shelf-1", status: "degraded", reading: 68, safetyThreshold: 70 },
      ]);
    });

    it("omits reading fields for devices without a sensor", () => {
      const observed = observeEquipment({ id: "oven-1", kind: "oven", status: "working" });
      expect(observed).toEqual({ id: "oven-1", status: "working" });
      expect("reading" in observed).toBe(false);
    });

    it("scores severity off the numbers, and off status when there are none", () => {
      expect(equipmentSeverity(sensedState.equipment[1]!)).toBe("non_safety");
      expect(equipmentSeverity({ ...sensedState.equipment[1]!, reading: 70 })).toBe("safety_critical");
      expect(equipmentSeverity({ id: "oven-1", kind: "oven", status: "failed" })).toBe("safety_critical");
      expect(equipmentSeverity({ id: "oven-1", kind: "oven", status: "degraded" })).toBe("non_safety");
    });
  });

  describe("projectObservation dispatcher", () => {
    it("dispatches correctly for all 4 roles", () => {
      expect(projectObservation(baseState, "host").role).toBe("host");
      expect(projectObservation(baseState, "supply_lead").role).toBe("supply_lead");
      expect(projectObservation(baseState, "chef").role).toBe("chef");
      expect(projectObservation(baseState, "server").role).toBe("server");
      expect(projectObservation(baseState, "expediter").role).toBe("supply_lead");
    });
  });

  describe("projection helper functions", () => {
    it("workerLoad throws for unknown role", () => {
      expect(() => workerLoad({ ...baseState, workers: [] }, "chef")).toThrow("no worker occupies role chef");
    });

    it("tableWaitMinutes returns 0 for unassigned or unseated table", () => {
      const emptyTable = baseState.tables.find((t) => t.id === "table-3")!;
      expect(tableWaitMinutes(baseState, emptyTable)).toBe(0);
    });

    it("orderStatusForTable returns queued if no order attached", () => {
      const emptyTable = baseState.tables.find((t) => t.id === "table-3")!;
      expect(orderStatusForTable(baseState, emptyTable)).toBe("queued");
    });

    it("observedIncidents collects incidents cleanly", () => {
      expect(observedIncidents(baseState)).toEqual([
        { kind: "oven_failure", active: false, severity: "safety_critical" },
      ]);
    });
  });
});
