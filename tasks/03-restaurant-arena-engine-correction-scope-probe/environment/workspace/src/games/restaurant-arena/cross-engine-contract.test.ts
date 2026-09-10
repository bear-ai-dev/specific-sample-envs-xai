import { describe, expect, it } from "bun:test";
import crossEngineFixture from "../../../contracts/fixtures/restaurant-arena-cross-engine-v2.json" with { type: "json" };
import crossEngineSchema from "../../../contracts/restaurant-arena-cross-engine-v2.schema.json" with { type: "json" };
import v1Fixture from "../../../contracts/fixtures/restaurant-arena-v1.json" with { type: "json" };
import { isRestaurantState } from "./types.js";
import { runCrossEngineReport, validateCrossEngineFixture } from "./cross-engine-report.js";

describe("Restaurant Arena cross-engine fixture v2", () => {
  it("pins the shared roster and scenario set", () => {
    expect(crossEngineFixture.version).toBe("restaurant-arena-cross-engine/v2");
    expect(crossEngineFixture.roles).toEqual(["host", "supply_lead", "chef", "server"]);
    expect(crossEngineFixture.scenarios.map(({ id }) => id)).toEqual([
      "routine",
      "incident",
      "manager-correction",
    ]);
    const correction = crossEngineFixture.scenarios.find(({ id }) => id === "manager-correction");
    expect(correction?.steps.some((step) => "managerCorrection" in step && step.managerCorrection === true)).toBe(true);
  });

  it("requires each published scenario ID exactly once in the schema", () => {
    const scenarios = crossEngineSchema.properties.scenarios as { maxItems: number; allOf: Array<{ contains: { properties: { id: { const: string } } }; minContains: number; maxContains: number }> };
    expect(scenarios.maxItems).toBe(3);
    expect(scenarios.allOf.map(({ contains, minContains, maxContains }) => [contains.properties.id.const, minContains, maxContains])).toEqual([
      ["routine", 1, 1],
      ["incident", 1, 1],
      ["manager-correction", 1, 1],
    ]);
    const stepSchema = (crossEngineSchema.properties.scenarios as { items: { properties: { steps: { maxItems: number } } } }).items.properties.steps;
    expect(stepSchema.maxItems).toBe(1);
  });

  it("rejects duplicate IDs and malformed steps before execution", () => {
    const duplicate = { ...crossEngineFixture, scenarios: crossEngineFixture.scenarios.map((scenario) => ({ ...scenario, id: "routine" })) };
    expect(() => validateCrossEngineFixture(duplicate)).toThrow();
    const malformed = { ...crossEngineFixture, scenarios: crossEngineFixture.scenarios.map((scenario, index) => index === 0 ? { ...scenario, steps: [{ kind: "unknown", tick: 0 }] } : scenario) };
    expect(() => validateCrossEngineFixture(malformed)).toThrow();
  });

  it("keeps the published v1 state fixture accepted by the existing guard", () => {
    expect(isRestaurantState(v1Fixture)).toBe(true);
  });

  it("runs all three shared scenarios into normalized records", () => {
    const report = runCrossEngineReport();
    expect(report.map(({ scenario }) => scenario)).toEqual(["routine", "incident", "manager-correction"]);
    expect(report.every(({ canonicalRoles }) => canonicalRoles.join(",") === "host,supply_lead,chef,server")).toBe(true);
    expect(report.every(({ accepted }) => accepted)).toBe(true);
    expect(report.map(({ steps }) => steps.length)).toEqual(crossEngineFixture.scenarios.map(({ steps }) => steps.length));
    expect(report[1]?.oven.emergency).toBe(true);
    expect(report[2]?.stateChanged).toBe(true);
  });
});
