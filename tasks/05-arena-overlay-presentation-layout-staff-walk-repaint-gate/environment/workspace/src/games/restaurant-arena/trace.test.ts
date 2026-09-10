import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_PATH, FIXTURE_SEED, buildFixtureTrace } from "../../../scripts/export-arena-trace.js";
import { RestaurantGame } from "./restaurant-game.js";
import { ACTION_VERSION, type ActionEnvelope } from "./types.js";
import {
  TRACE_V3_CONTRACT_VERSION,
  TRACE_V3_VERSION,
  canonicalJson,
  captureArenaTrace,
  computeStateHash,
  exportTraceJson,
  exportTraceJsonl,
  selectFailedEvents,
  summarizeTraceFailures,
  validateArenaTraceV3,
  type RestaurantArenaTraceV3,
} from "./trace.js";

describe("Restaurant Arena Trace Capture & Validation (Issue #263)", () => {
  it("computes valid sha256 state hashes conforming to schema pattern", () => {
    const hash1 = computeStateHash({ test: "data", value: 123 });
    const hash2 = computeStateHash({ test: "data", value: 123 });
    const hash3 = computeStateHash({ test: "different", value: 456 });

    expect(hash1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it("preserves backend float spelling for integral state values", () => {
    expect(canonicalJson({ reputation: 70.0, outcomes: { cash: 0.0 }, workers: [{ load: 0.0 }] }))
      .toBe('{"outcomes":{"cash":0.0},"reputation":70.0,"workers":[{"load":0.0}]}');
    expect(canonicalJson({ tick: 0 })).toBe('{"tick":0}');
  });

  it("records state-only checkpoints separately from native runtime checkpoints (#283)", () => {
    const game = new RestaurantGame(218220);
    game.step("sim_start");
    const trace = captureArenaTrace(game, { runKind: "live" });
    const input = trace.replay.inputs[0]!;

    // Starting simulation changes native control state, but not RestaurantState.
    expect(input.restaurantStateHash).toBe(computeStateHash(trace.initialState));
    expect(input.restaurantStateHash).not.toBe(input.stateHash);
    expect(trace.replay.finalRestaurantStateHash).toBe(computeStateHash(game.state()));
  });

  it("captures a complete trace from a RestaurantGame instance", () => {
    const game = new RestaurantGame(218220);
    game.step("sim_start");
    for (let i = 0; i < 10; i++) game.step("tick");
    game.step("verify_substitution");
    for (let i = 0; i < 14; i++) game.step("tick");

    const trace = captureArenaTrace(game, {
      episodeId: "dinner-rush-test-001",
      envVersion: "0.3.4",
      runKind: "live",
    });

    expect(trace.version).toBe(TRACE_V3_VERSION);
    expect(trace.contractVersion).toBe(TRACE_V3_CONTRACT_VERSION);
    expect(trace.episodeId).toBe("dinner-rush-test-001");
    expect(trace.seed).toBe(218220);
    expect(trace.runKind).toBe("live");
    expect(trace.deletion.status).toBe("retained");
    expect(trace.initialState).toBeDefined();
    expect(trace.events.length).toBeGreaterThan(0);

    const validation = validateArenaTraceV3(trace);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("strictly validates against restaurant-arena-trace-v3 schema constraints", () => {
    const schemaPath = join(import.meta.dir, "../../../contracts/restaurant-arena-trace-v3.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      required: string[];
      properties: Record<string, unknown>;
    };

    const game = new RestaurantGame(218220);
    for (let i = 0; i < 24; i++) game.step("tick");
    const trace = captureArenaTrace(game, { runKind: "live" });

    // Verify all schema required fields are present
    for (const req of schema.required) {
      expect((trace as unknown as Record<string, unknown>)[req]).toBeDefined();
    }

    const validation = validateArenaTraceV3(trace);
    expect(validation.valid).toBe(true);
  });

  it("detects and rejects schema violations in traces", () => {
    const game = new RestaurantGame(218220);
    const validTrace = captureArenaTrace(game, { runKind: "live" });

    // Invalid version
    const badVersion = { ...validTrace, version: "bad-version" };
    expect(validateArenaTraceV3(badVersion).valid).toBe(false);

    // Disallowed extra root property
    const extraProperty = { ...validTrace, unauthorizedField: true };
    expect(validateArenaTraceV3(extraProperty).valid).toBe(false);

    // Invalid event kind
    const badEvents = validTrace.events.map((e, idx) =>
      idx === 0 ? { ...e, kind: "invalid_kind" as any } : e,
    );
    const badEventTrace = { ...validTrace, events: badEvents };
    expect(validateArenaTraceV3(badEventTrace).valid).toBe(false);

    // Invalid state hash
    const badHashEvents = validTrace.events.map((e, idx) =>
      idx === 0 ? { ...e, stateHash: "not-a-hash" } : e,
    );
    const badHashTrace = { ...validTrace, events: badHashEvents };
    expect(validateArenaTraceV3(badHashTrace).valid).toBe(false);

    // Invalid text (e.g. number instead of string)
    const badTextTrace = {
      ...validTrace,
      events: [{ ...validTrace.events[0]!, text: 42 as any }],
    };
    expect(validateArenaTraceV3(badTextTrace).valid).toBe(false);

    // Invalid model (missing provider)
    const badModelTrace = {
      ...validTrace,
      events: [{ ...validTrace.events[0]!, model: { name: "x" } as any }],
    };
    expect(validateArenaTraceV3(badModelTrace).valid).toBe(false);

    // Invalid model (extra disallowed property)
    const extraModelTrace = {
      ...validTrace,
      events: [{ ...validTrace.events[0]!, model: { provider: "anthropic", name: "claude-3", extra: true } as any }],
    };
    expect(validateArenaTraceV3(extraModelTrace).valid).toBe(false);

    // Disallowed extra property on subject
    const badSubjectTrace = {
      ...validTrace,
      events: [{ ...validTrace.events[0]!, subject: { kind: "order", id: "order-1", extraProp: "forbidden" } as any }],
    };
    expect(validateArenaTraceV3(badSubjectTrace).valid).toBe(false);

    // Invalid observation (array instead of object)
    const badObsTrace = {
      ...validTrace,
      events: [{ ...validTrace.events[0]!, observation: [1, 2, 3] as any }],
    };
    expect(validateArenaTraceV3(badObsTrace).valid).toBe(false);

    // Invalid correctionRationale (non-string)
    const badRationaleTrace = {
      ...validTrace,
      events: [{ ...validTrace.events[0]!, correctionRationale: 12345 as any }],
    };
    expect(validateArenaTraceV3(badRationaleTrace).valid).toBe(false);

    // Inherited variation key
    const inheritedVariationTrace = {
      ...validTrace,
      replay: { ...validTrace.replay, variation: "toString" },
    };
    const inheritedResult = validateArenaTraceV3(inheritedVariationTrace);
    expect(inheritedResult.valid).toBe(false);
    expect(inheritedResult.errors).toContain("replay.variation must be a known Arena variation");
  });

  it("links player correction to original decision and downstream probe", () => {
    const game = new RestaurantGame(218220);
    game.step("sim_start");
    for (let i = 0; i < 8; i++) game.step("tick");
    game.step("verify_substitution");
    for (let i = 0; i < 16; i++) game.step("tick");
    const trace = captureArenaTrace(game, { runKind: "live" });

    const correctionEvent = trace.events.find((e) => e.kind === "player_correction");
    expect(correctionEvent).toBeDefined();
    expect(correctionEvent!.changedDecisionEventId).toBeDefined();
    expect(correctionEvent!.probeEventId).toBeDefined();
    expect(correctionEvent!.correctionCategory).toBe("safety");
    expect(correctionEvent!.text).toBe("protect safety and verify before substituting");

    const downstreamProbe = trace.events.find(
      (e) => e.requestId === correctionEvent!.probeEventId,
    );
    expect(downstreamProbe).toBeDefined();
  });

  it("does not fabricate events that did not occur in the run", () => {
    const game = new RestaurantGame(218220);
    game.step("sim_start");
    for (let i = 0; i < 3; i++) game.step("tick");
    const trace = captureArenaTrace(game, { runKind: "live" });

    // Only events up to tick 3 should exist; tick 8 oven failure and player correction did not occur
    const correctionEvent = trace.events.find((e) => e.kind === "player_correction");
    expect(correctionEvent).toBeUndefined();

    const ovenEvent = trace.events.find(
      (e) => e.subject?.kind === "equipment" && e.subject.id === "oven-1",
    );
    expect(ovenEvent).toBeUndefined();

    for (const e of trace.events) {
      expect(e.tick).toBeLessThanOrEqual(3);
    }
  });

  it("exports valid JSON and JSONL representations", () => {
    const game = new RestaurantGame(218220);
    const trace = captureArenaTrace(game, { runKind: "live" });

    const json = exportTraceJson(trace);
    expect(json).toContain('"safetyThreshold": 70.0');
    const parsed = JSON.parse(json) as RestaurantArenaTraceV3;
    expect(validateArenaTraceV3(parsed).valid).toBe(true);

    const jsonl = exportTraceJsonl(trace);
    const lines = jsonl.trim().split("\n");
    expect(lines.length).toBe(trace.events.length + 1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ version: trace.version, replay: trace.replay });
    for (const line of lines.slice(1)) {
      const event = JSON.parse(line);
      expect(event.tick).toBeDefined();
      expect(event.kind).toBeDefined();
      expect(event.stateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe("Restaurant Arena trace capture pipeline (Issue #261)", () => {
  it("refuses to capture without an explicit runKind", () => {
    const game = new RestaurantGame(218220);
    // Defaulting would file a benchmark episode as live gameplay.
    expect(() => captureArenaTrace(game, {} as never)).toThrow(/explicit runKind/);
    expect(() => captureArenaTrace(game, { runKind: "offline" as never })).toThrow(/explicit runKind/);
  });

  it("keeps live, synthetic, and benchmark runs distinguishable", () => {
    for (const runKind of ["live", "synthetic", "benchmark"] as const) {
      const game = new RestaurantGame(218220);
      const trace = captureArenaTrace(game, { runKind });
      expect(trace.runKind).toBe(runKind);
      expect(validateArenaTraceV3(trace).valid).toBe(true);
    }
  });

  it("carries no consent field, which the schema no longer allows", () => {
    const game = new RestaurantGame(218220);
    const trace = captureArenaTrace(game, { runKind: "live" });
    expect("consent" in trace).toBe(false);

    const withConsent = { ...trace, consent: { status: "granted" } };
    expect(validateArenaTraceV3(withConsent).valid).toBe(false);
  });

  it("records the tick-0 world so the episode can be replayed from the seed", () => {
    const game = new RestaurantGame(218220);
    game.step("sim_start");
    for (let i = 0; i < 6; i++) game.step("tick");

    const trace = captureArenaTrace(game, { runKind: "live" });
    const initial = trace.initialState as { seed: number; episode: { tick: number } };
    expect(initial.seed).toBe(218220);
    // The snapshot is frozen before tick 0 and never tracks the live state.
    expect(initial.episode.tick).toBe(0);
    expect(game.state().episode.tick).toBeGreaterThan(0);
  });

  it("rejects a trace whose replay state is missing or from another episode", () => {
    const game = new RestaurantGame(218220);
    const trace = captureArenaTrace(game, { runKind: "live" });

    const { initialState, ...withoutInitial } = trace;
    expect(initialState).toBeDefined();
    expect(validateArenaTraceV3(withoutInitial).valid).toBe(false);

    // A snapshot from a different seed would replay a different episode.
    const wrongSeed = {
      ...trace,
      initialState: { ...(trace.initialState as Record<string, unknown>), seed: 999 },
    };
    expect(validateArenaTraceV3(wrongSeed).valid).toBe(false);

    // A mid-run snapshot would replay from the wrong point.
    const wrongTick = {
      ...trace,
      initialState: { ...(trace.initialState as Record<string, unknown>), episode: { tick: 7 } },
    };
    expect(validateArenaTraceV3(wrongTick).valid).toBe(false);
  });

  it("records a rejected action as a failure a grader can sort on", () => {
    const game = new RestaurantGame(218220);
    game.step("sim_start");

    const state = game.state();
    const stale: ActionEnvelope = {
      version: ACTION_VERSION,
      episodeId: state.episode.id,
      actorId: "worker-chef",
      actorType: "worker",
      role: "chef",
      tool: "prepare",
      arguments: { orderId: "order-1" },
      // A tick behind the simulator: the boundary must refuse this.
      tick: state.episode.tick + 99,
      timestamp: new Date().toISOString(),
      requestId: "req-stale-1",
      idempotencyKey: `${state.episode.id}:req-stale-1`,
    };

    const result = game.stepEnvelope(stale, { latencyMs: 412, model: { provider: "anthropic", name: "claude-x" } });
    expect(result.accepted).toBe(false);

    const trace = captureArenaTrace(game, { runKind: "live" });
    expect(validateArenaTraceV3(trace).valid).toBe(true);

    const failures = selectFailedEvents(trace);
    expect(failures.length).toBe(1);
    expect(failures[0]!.toolResult?.ok).toBe(false);
    expect(failures[0]!.toolResult?.error?.code).toBe("stale_tick");
    expect(failures[0]!.toolResult?.latencyMs).toBe(412);
    expect(failures[0]!.model?.name).toBe("claude-x");

    const summary = summarizeTraceFailures(trace);
    expect(summary.total).toBe(1);
    expect(summary.byCode.stale_tick).toBe(1);
    expect(summary.meanLatencyMs).toBe(412);
  });

  it("rejects a malformed toolResult failure body", () => {
    const game = new RestaurantGame(218220);
    const trace = captureArenaTrace(game, { runKind: "live" });
    const base = trace.events[0]!;

    const badOk = { ...trace, events: [{ ...base, toolResult: { ok: "no" as never } }] };
    expect(validateArenaTraceV3(badOk).valid).toBe(false);

    const badLatency = { ...trace, events: [{ ...base, toolResult: { ok: true, latencyMs: -5 } }] };
    expect(validateArenaTraceV3(badLatency).valid).toBe(false);

    const badError = { ...trace, events: [{ ...base, toolResult: { ok: false, error: { code: "x" } as never } }] };
    expect(validateArenaTraceV3(badError).valid).toBe(false);

    // `ok` and `error` state one fact twice, so they may not disagree.
    const failureWithoutError = { ...trace, events: [{ ...base, toolResult: { ok: false } }] };
    expect(validateArenaTraceV3(failureWithoutError).valid).toBe(false);

    const successWithError = {
      ...trace,
      events: [{ ...base, toolResult: { ok: true, error: { code: "boom", message: "it failed" } } }],
    };
    expect(validateArenaTraceV3(successWithError).valid).toBe(false);

    const errorWithoutOk = {
      ...trace,
      events: [{ ...base, toolResult: { error: { code: "boom", message: "it failed" } } }],
    };
    expect(validateArenaTraceV3(errorWithoutOk).valid).toBe(false);

    // Both consumers select the same events under the enforced invariant.
    const consistent = {
      ...trace,
      events: [{ ...base, toolResult: { ok: false, error: { code: "boom", message: "it failed" } } }],
    };
    expect(validateArenaTraceV3(consistent).valid).toBe(true);
    expect(selectFailedEvents(consistent).length).toBe(1);

    // Domain keys alongside the reserved ones stay legal.
    const domainKeys = {
      ...trace,
      events: [{ ...base, toolResult: { ok: true, status: "verified", correctionUptake: 0.5 } }],
    };
    expect(validateArenaTraceV3(domainKeys).valid).toBe(true);
  });

  it("exports a fixture that validates and carries the whole grading chain", () => {
    const trace = buildFixtureTrace();
    expect(validateArenaTraceV3(trace).valid).toBe(true);
    expect(trace.runKind).toBe("benchmark");
    expect(trace.seed).toBe(FIXTURE_SEED);
    expect(trace.initialState).toBeDefined();

    // The fixture is only useful to a grader if the correction, the decision
    // it changed, the probe it tests, and the outcome are all in it.
    const correction = trace.events.find((e) => e.kind === "player_correction");
    expect(correction?.changedDecisionEventId).toBe("evt-dec-allergy-218220");
    expect(correction?.probeEventId).toBe("evt-probe-shelf-218220");

    const probe = trace.events.find(
      (e) => (e.payload as { probe?: string } | null | undefined)?.probe === "warming_shelf_scope_control",
    );
    expect(probe).toBeDefined();
    expect(trace.events.some((e) => e.kind === "outcome")).toBe(true);
  });

  describe("identifying the session a trace came from (#281)", () => {
    function shift(seed = 218220): RestaurantGame {
      const game = new RestaurantGame(seed);
      game.step("sim_start");
      return game;
    }

    it("carries the session id the caller names", () => {
      const trace = captureArenaTrace(shift(), { runKind: "live", sessionId: "game_a1b2c3d4-0000-4000-8000-000000000001" });
      expect(trace.sessionId).toBe("game_a1b2c3d4-0000-4000-8000-000000000001");
      expect(validateArenaTraceV3(trace).valid).toBe(true);
    });

    it("distinguishes two runs of the same scenario", () => {
      // The gap this closes: `episodeId` is seed-derived, so two sessions on
      // the same seed were indistinguishable on receipt, and duplicate
      // receipts could not be told from separate contributions.
      const first = captureArenaTrace(shift(), { runKind: "live", sessionId: "game_aaaaaaaa-0000-4000-8000-000000000001" });
      const second = captureArenaTrace(shift(), { runKind: "live", sessionId: "game_bbbbbbbb-0000-4000-8000-000000000002" });
      expect(first.episodeId).toBe(second.episodeId);
      expect(first.sessionId).not.toBe(second.sessionId);
    });

    it("stays valid with no session id, so earlier exports still pass", () => {
      const trace = captureArenaTrace(shift(), { runKind: "live" });
      expect(trace.sessionId).toBeUndefined();
      expect("sessionId" in trace).toBe(false);
      expect(validateArenaTraceV3(trace).valid).toBe(true);
    });

    it("rejects a session id that cannot be matched", () => {
      // Worse than absent: it looks matchable and is not.
      const trace = { ...captureArenaTrace(shift(), { runKind: "live" }), sessionId: "not a valid id" };
      const result = validateArenaTraceV3(trace);
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes("sessionId"))).toBe(true);
    });
  });

  it("keeps the checked-in fixture in step with the exporter", () => {
    const onDisk = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RestaurantArenaTraceV3;
    expect(validateArenaTraceV3(onDisk).valid).toBe(true);
    expect(onDisk.episodeId).toBe(buildFixtureTrace().episodeId);
    expect(onDisk.events.length).toBe(buildFixtureTrace().events.length);
  });
});
