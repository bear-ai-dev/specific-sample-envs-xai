import { describe, expect, test } from "bun:test";
import { REGISTRY, isPlayable } from "../src/games/registry.js";
import { renderNativeGame } from "./renderers.js";

const CELL_COUNTS: Readonly<Record<string, number>> = {
  "restaurant-arena": 0,
};

/** Games steered by the arrow/WASD keys or a swipe, with no on-screen pad. */
const KEYBOARD_ONLY = new Set<string>();

/**
 * Games that draw their own controls on the canvas. Their HTML is a bare
 * stage on purpose — a button strip under the game read as a video remote.
 */
const CANVAS_DRIVEN = new Set<string>(["restaurant-arena"]);

describe("native HTML game renderers", () => {
  for (const entry of REGISTRY.filter(isPlayable)) {
    test(`${entry.title} renders its real board and browser controls`, () => {
      const game = entry.create!(entry.variations[0]!.id);
      game.reset(42);
      const html = renderNativeGame(game);

      expect(html).not.toContain("\x1b[");
      expect(html).not.toContain("<pre");
      expect(html).toContain(`data-game="${entry.id}"`);
      expect(html.match(/data-cell=/g)?.length ?? 0).toBe(CELL_COUNTS[entry.id]!);
      // The pure movement games are keyboard/swipe only — every other game
      // still ships the on-screen controls that aren't movement arrows.
      if (KEYBOARD_ONLY.has(entry.id) || CANVAS_DRIVEN.has(entry.id)) expect(html).not.toContain("data-action=");
      else expect(html).toMatch(/data-action=|data-column=/);
      // No game keeps an on-screen direction pad.
      expect(html).not.toContain("direction-pad");
    });
  }

  test("Restaurant Arena renders a bare floor stage — every control is on the canvas", () => {
    const entry = REGISTRY.find(({ id }) => id === "restaurant-arena")!;
    const game = entry.create!("dinner-rush");
    game.reset(218220);
    const html = renderNativeGame(game);
    expect(html).toContain("arena-stage");
    expect(html).toContain("data-phaser-mount");
    expect(html).toContain("Deterministic crew · live model unavailable");
    expect(html).toContain("data-arena-worker-activity");
    expect(html).toContain('aria-label="Live staff activity"');
    expect(html).not.toContain("arena-controls");
    expect(html).not.toContain("<kbd>");
  });
});
