import { describe, expect, it } from "bun:test";
import actionSchema from "../../../contracts/restaurant-arena-action-v1.schema.json" with { type: "json" };
import fixture from "../../../contracts/fixtures/restaurant-arena-v1.json" with { type: "json" };
import {
  isActionEnvelope,
  isRestaurantState,
  STATE_VERSION,
  type ActionEnvelope,
  type RestaurantState,
} from "./types.js";

describe("Restaurant Arena Types and Contracts (#240)", () => {
  it("validates contracts/fixtures/restaurant-arena-v1.json against isRestaurantState", () => {
    expect(isRestaurantState(fixture)).toBe(true);
    const state = fixture as RestaurantState;
    expect(state.version).toBe(STATE_VERSION);
    expect(state.seed).toBe(218220);
    expect(state.episode.id).toBe("dinner-rush-001");
    expect(state.episode.phase).toBe("active");
    expect(state.episode.tick).toBe(0);
    expect(state.episode.maxTicks).toBe(24);
    expect(state.tables.length).toBe(3);
    expect(state.orders.length).toBe(2);
    expect(state.workers.length).toBe(4);
    expect(state.equipment.length).toBe(2);
    expect(state.emergency?.kind).toBe("oven_failure");
    expect(state.emergency?.active).toBe(false);
  });

  it("rejects state with invalid version or missing fields", () => {
    expect(isRestaurantState(null)).toBe(false);
    expect(isRestaurantState({})).toBe(false);
    expect(isRestaurantState({ ...fixture, version: "unknown/v1" })).toBe(false);
    expect(isRestaurantState({ ...fixture, tables: "not-an-array" })).toBe(false);
    expect(
      isRestaurantState({
        ...fixture,
        episode: { ...fixture.episode, phase: "invalid-phase" },
      })
    ).toBe(false);
    expect(
      isRestaurantState({
        ...fixture,
        reputation: -10,
      })
    ).toBe(false);
  });

  it("validates action envelope structure", () => {
    const validAction: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-chef",
      actorType: "worker",
      role: "chef",
      tool: "prepare",
      arguments: { orderId: "order-1" },
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-001",
      idempotencyKey: "dinner-rush-001:req-001",
    };

    expect(isActionEnvelope(validAction)).toBe(true);
    expect(isActionEnvelope({ ...validAction, role: "supply_lead", actorId: "worker-supply_lead" })).toBe(true);
    expect(isActionEnvelope({ ...validAction, role: "invalid-role" })).toBe(false);
    expect(isActionEnvelope({ ...validAction, version: "wrong/v1" })).toBe(false);
    expect(isActionEnvelope({ ...validAction, actorType: "admin" })).toBe(false);
  });

  it("declares approve and correct in contracts/restaurant-arena-action-v1.schema.json tool enum", () => {
    const toolEnum = actionSchema.properties.tool.enum;
    expect(toolEnum).toContain("approve");
    expect(toolEnum).toContain("correct");
  });

  it("recognizes approve and correct envelopes as valid action envelopes", () => {
    const approveEnvelope: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "player",
      actorType: "player",
      role: "chef",
      tool: "approve",
      arguments: { decisionId: "allergy_ticket", optionId: "verify" },
      tick: 1,
      timestamp: "2026-09-02T00:01:00Z",
      requestId: "req-approve-001",
      idempotencyKey: "dinner-rush-001:req-approve-001",
    };
    expect(isActionEnvelope(approveEnvelope)).toBe(true);

    const correctEnvelope: ActionEnvelope = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "player",
      actorType: "player",
      role: "chef",
      tool: "correct",
      arguments: { note: "verify substitutions" },
      tick: 1,
      timestamp: "2026-09-02T00:01:00Z",
      requestId: "req-correct-001",
      idempotencyKey: "dinner-rush-001:req-correct-001",
    };
    expect(isActionEnvelope(correctEnvelope)).toBe(true);
  });

  it("validates historical state and action envelopes carrying expediter as legacy", () => {
    const legacyState = {
      ...fixture,
      workers: [
        { id: "worker-host", role: "host", load: 0.2, location: "queue" },
        { id: "worker-expediter", role: "expediter", load: 0.1, location: "pass" },
        { id: "worker-chef", role: "chef", load: 0.5, location: "kitchen" },
        { id: "worker-server", role: "server", load: 0.3, location: "floor" },
      ],
    };
    expect(isRestaurantState(legacyState)).toBe(true);

    const legacyAction = {
      version: "restaurant-arena-action/v1",
      episodeId: "dinner-rush-001",
      actorId: "worker-expediter",
      actorType: "worker",
      role: "expediter",
      tool: "coordinate",
      arguments: {},
      tick: 0,
      timestamp: "2026-09-02T00:00:00Z",
      requestId: "req-legacy-001",
      idempotencyKey: "dinner-rush-001:req-legacy-001",
    };
    expect(isActionEnvelope(legacyAction)).toBe(true);
  });
});
