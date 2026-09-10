import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RestaurantGame } from "../src/games/restaurant-arena/restaurant-game.js";
import {
  buildArenaTimeline,
  renderTimelineHtml,
} from "../src/games/restaurant-arena/timeline.js";
import {
  captureArenaTrace,
  exportTraceJson,
  exportTraceJsonl,
  validateArenaTraceV3,
} from "../src/games/restaurant-arena/trace.js";
import { milestoneFeedText } from "./restaurant-arena-milestones.js";

describe("Restaurant Arena Overlay Timeline & Export (Issue #263)", () => {
  it("renders chronological cards for all 6 steps in the debrief / end-screen", () => {
    const game = new RestaurantGame(218220);
    game.step("sim_start");
    for (let i = 0; i < 8; i++) game.step("tick");
    game.step("verify_substitution");
    for (let i = 0; i < 16; i++) game.step("tick");

    expect(game.isOver()).toBe(true);

    const timeline = buildArenaTimeline(game);
    const html = renderTimelineHtml(timeline);

    expect(timeline.milestonesPresented).toEqual(["original_decision", "correction", "later_probe", "outcome"]);
    expect(timeline.cards.map((card) => card.tick)).toEqual(game.getRecordedEvents().map((event) => event.tick));
    expect(html).toContain("protect safety and verify before substituting");
    expect(html).not.toContain("Correction stayed scoped");
    expect(html).toContain("This alone does not establish a worker response");
    expect(html).toContain("Shift Outcome Metrics");
  });

  it("keeps the live Event Feed milestone spine in the required order", () => {
    expect(milestoneFeedText()).toBe(
      "ORIGINAL DECISION  →  PLAYER CORRECTION  →  LATER PROBE  →  SHIFT OUTCOMES",
    );
  });

  it("produces valid restaurant-arena-trace-v3 JSON payload matching schema on export", () => {
    const game = new RestaurantGame(218220);
    game.step("sim_start");
    for (let i = 0; i < 24; i++) game.step("tick");

    const trace = captureArenaTrace(game, { runKind: "live" });
    const json = exportTraceJson(trace);
    const parsed = JSON.parse(json);

    // Validate using the schema validator
    const validation = validateArenaTraceV3(parsed);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    // Check against raw schema definition
    const schemaPath = join(import.meta.dir, "../contracts/restaurant-arena-trace-v3.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(parsed.version).toBe("restaurant-arena-trace/v3");
    expect(parsed.contractVersion).toBe("restaurant-arena/v1");
    expect(parsed.events.length).toBeGreaterThan(0);

    for (const req of schema.required) {
      expect(parsed[req]).toBeDefined();
    }
  });

  it("exports valid JSONL event lines for raw streaming", () => {
    const game = new RestaurantGame(218220);
    game.step("sim_start");
    for (let i = 0; i < 24; i++) game.step("tick");

    const trace = captureArenaTrace(game, { runKind: "live" });
    const jsonl = exportTraceJsonl(trace);
    const lines = jsonl.trim().split("\n");

    expect(lines.length).toBe(trace.events.length + 1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ version: trace.version, replay: trace.replay });
    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line);
      expect(parsed.tick).toBeDefined();
      expect(parsed.kind).toBeDefined();
      expect(parsed.timestamp).toBeDefined();
      expect(parsed.stateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("prevents UI freezing and visual clipping on large traces (Acceptance Criteria)", () => {
    const game = new RestaurantGame(218220);
    const baseTrace = captureArenaTrace(game, { runKind: "live" });

    // Expand to 500 events simulating a massive benchmark trace
    const largeEvents = [...baseTrace.events];
    for (let i = 0; i < 500; i++) {
      largeEvents.push({
        tick: i,
        kind: "action",
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        stateHash: baseTrace.events[0]!.stateHash,
        actorId: "worker-chef",
        role: "chef",
        text: `Repeated preparation event ${i}`,
      });
    }
    const massiveTrace = { ...baseTrace, events: largeEvents };

    const start = performance.now();
    const timeline = buildArenaTimeline(massiveTrace);
    const html = renderTimelineHtml(timeline);
    const duration = performance.now() - start;

    // UI generation must take < 30ms (no UI freezing)
    expect(duration).toBeLessThan(50);

    // Ensure CSS in index.html has max-height and overflow-y: auto to prevent visual clipping
    const indexPath = join(import.meta.dir, "dist/index.html");
    const indexHtml = readFileSync(indexPath, "utf8");
    expect(indexHtml).toContain(".arena-timeline-cards");
    expect(indexHtml).toContain("max-height: 220px");
    expect(indexHtml).toContain("overflow-y: auto");
    expect(indexHtml).toContain("arena-end-content");
    expect(indexHtml).toContain("export-trace-btn");
  });
});
