import { describe, expect, test } from "bun:test";
import { restaurantArenaLayout } from "./restaurant-arena-layout.js";

describe("restaurantArenaLayout", () => {
  test("keeps every region visible at compact and expanded sizes", () => {
    for (const [width, height] of [[320, 240], [520, 560], [720, 700]] as const) {
      const layout = restaurantArenaLayout(width, height);
      for (const zone of [layout.topBar, layout.brief, layout.kitchen, layout.pass, layout.dining, layout.door, layout.tickets, layout.feed]) {
        expect(zone.x).toBeGreaterThanOrEqual(0);
        expect(zone.y).toBeGreaterThanOrEqual(0);
        expect(zone.width).toBeGreaterThan(0);
        expect(zone.height).toBeGreaterThan(0);
        expect(zone.x + zone.width).toBeLessThanOrEqual(width);
        expect(zone.y + zone.height).toBeLessThanOrEqual(height);
      }
      // Floor stacks door under dining, tickets under both.
      expect(layout.dining.y + layout.dining.height).toBeLessThanOrEqual(layout.door.y);
      expect(layout.door.y + layout.door.height).toBeLessThanOrEqual(layout.tickets.y);
      expect(layout.kitchen.x + layout.kitchen.width).toBeLessThanOrEqual(layout.pass.x);
      expect(layout.pass.x + layout.pass.width).toBeLessThanOrEqual(layout.dining.x);
      // Goal, then pressure, then floor: the brief sits between the two.
      expect(layout.topBar.y + layout.topBar.height).toBeLessThanOrEqual(layout.brief.y);
      expect(layout.brief.y + layout.brief.height).toBeLessThanOrEqual(layout.kitchen.y);
    }
  });

  test("text scale follows the tighter axis, not just width", () => {
    // The design size scores 1: nothing to grow yet.
    expect(restaurantArenaLayout(520, 740).scale).toBe(1);

    // Wide but short. Scaling on width alone would reach 1.9 here while the
    // scene's row heights stayed fixed, and the top bar would collide with
    // the feed. Height is the binding axis, so the scale stays modest.
    const wideShort = restaurantArenaLayout(988, 700);
    expect(wideShort.scale).toBe(1);
    expect(wideShort.scale).toBeLessThan(988 / 520);

    // Growing both axes does raise it.
    expect(restaurantArenaLayout(820, 1060).scale).toBeGreaterThan(1.4);

    // And it never runs past the cap, however large the window gets.
    expect(restaurantArenaLayout(4000, 4000).scale).toBe(1.9);

    // Compact windows opt out entirely — those tiers are already tuned tight.
    expect(restaurantArenaLayout(400, 400).scale).toBe(1);
  });

  test("plants staff waypoints inside their zones and runs the hallway through the pass", () => {
    for (const [width, height] of [[320, 240], [520, 560], [720, 700]] as const) {
      const layout = restaurantArenaLayout(width, height);
      const inside = (zone: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }) => {
        expect(point.x).toBeGreaterThanOrEqual(zone.x);
        expect(point.x).toBeLessThanOrEqual(zone.x + zone.width);
        expect(point.y).toBeGreaterThanOrEqual(zone.y);
        expect(point.y).toBeLessThanOrEqual(zone.y + zone.height);
      };
      inside(layout.kitchen, layout.waypoints.kitchen);
      inside(layout.pass, layout.waypoints.pass);
      inside(layout.dining, layout.waypoints.floor);
      inside(layout.door, layout.waypoints.queue);
      inside(layout.door, { x: layout.doorStand.x, y: layout.doorStand.y });
      inside(layout.door, {
        x: layout.doorStand.x + layout.doorStand.width,
        y: layout.doorStand.y + layout.doorStand.height,
      });
      expect(layout.spineY).toBeGreaterThan(layout.pass.y);
      expect(layout.spineY).toBeLessThan(layout.pass.y + layout.pass.height);
      expect(layout.doorStand.width).toBeGreaterThanOrEqual(56);
      expect(layout.doorStand.height).toBeGreaterThanOrEqual(22);
    }
  });

  test("puts the service log beside the floor only when there is width for it", () => {
    expect(restaurantArenaLayout(520, 620).feedBeside).toBe(false);
    const wide = restaurantArenaLayout(760, 620);
    expect(wide.feedBeside).toBe(true);
    // Beside means to the right of the tickets, not overlapping them.
    expect(wide.tickets.x + wide.tickets.width).toBeLessThanOrEqual(wide.feed.x);
  });
});
