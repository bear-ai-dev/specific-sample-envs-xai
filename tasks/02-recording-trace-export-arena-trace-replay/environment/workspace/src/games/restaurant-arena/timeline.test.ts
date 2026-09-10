import { expect, test } from "bun:test";
import { RestaurantGame } from "./restaurant-game.js";
import { TRACE_V3_VERSION } from "./trace.js";
import { buildArenaTimeline, renderTimelineHtml } from "./timeline.js";

test("live and exported timelines show the same actual events, roles and ticks", () => {
  const game = new RestaurantGame();
  game.step("sim_start");
  game.step("tick");
  game.submitPlayerIntervention({ kind: "priority", targetRole: "supply_lead", orderId: "order-1", priority: "high" });
  game.step("decide_allergy_ticket_verify");
  while (!game.isOver()) game.step("tick");
  const trace = { version: TRACE_V3_VERSION, episodeId: game.state().episode.id, events: game.getRecordedEvents(), terminal: game.getTerminalStatus() } as const;
  const timeline = buildArenaTimeline(game);
  expect(buildArenaTimeline(trace)).toEqual(timeline);
  expect(timeline.cards.map((card) => card.tick)).toEqual(trace.events.map((event) => event.tick));
  expect(timeline.cards.map((card) => card.headline)).toEqual(trace.events.map((event) => event.text!));
  expect(timeline.isComplete).toBe(true);
  expect(renderTimelineHtml(timeline)).not.toContain("Correction stayed scoped");
});

test("fresh and partial runs do not invent incidents, decisions, outcomes or passes", () => {
  const game = new RestaurantGame();
  const fresh = buildArenaTimeline(game);
  expect(fresh.cards).toHaveLength(1);
  expect(fresh.milestonesPresented).toEqual(["original_decision"]);
  expect(fresh.isComplete).toBe(false);
  for (let i = 0; i < 15; i++) game.step("tick");
  const partial = buildArenaTimeline(game);
  expect(partial.milestonesPresented).not.toContain("correction");
  expect(partial.milestonesPresented).not.toContain("outcome");
  expect(partial.cards.find((card) => card.title === "Warming Shelf Event")?.detail).toContain("does not establish a worker response");
});

test("player choices remain distinct without inferring subsequent worker behavior", () => {
  for (const option of ["verify", "pull", "substitute"]) {
    const game = new RestaurantGame();
    game.step("sim_start");
    game.step("tick");
    game.step(`decide_allergy_ticket_${option}`);
    const trace = { version: TRACE_V3_VERSION, episodeId: game.state().episode.id, events: game.getRecordedEvents(), terminal: game.getTerminalStatus() } as const;
    const timeline = buildArenaTimeline(trace);
    expect(timeline).toEqual(buildArenaTimeline(game));
    expect(timeline.cards.filter((card) => card.role === "player")).toHaveLength(1);
    expect(timeline.cards.filter((card) => card.milestone === "correction")).toHaveLength(option === "verify" ? 1 : 0);
    expect(timeline.cards).toHaveLength(trace.events.length);
  }
});

test("renders an accessible, escaped timeline for untrusted player text", () => {
  const game = new RestaurantGame();
  game.submitPlayerIntervention({ kind: "message", targetRole: "host", text: "<script>alert(1)</script>" });
  const viewTimeline = buildArenaTimeline(game.view());
  const html = renderTimelineHtml(viewTimeline);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain('role="feed"');
  expect(html).toContain('tabindex="0"');
});
