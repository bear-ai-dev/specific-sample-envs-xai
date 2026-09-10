import { describe, expect, test } from "bun:test";
import { restaurantArenaLayout } from "./restaurant-arena-layout.js";
import { bfsPath, corridorPoints, hopDurationMs, StaffWalker } from "./staff-walk.js";

const layout = restaurantArenaLayout(520, 560);
const waypoints = layout.waypoints;
const spineY = layout.spineY;

describe("staff corridor", () => {
  test("kitchen to the door goes through the pass and dining, never a shortcut", () => {
    expect(bfsPath("kitchen", "queue")).toEqual(["kitchen", "pass", "floor", "queue"]);
    expect(bfsPath("queue", "kitchen")).toEqual(["queue", "floor", "pass", "kitchen"]);
    expect(bfsPath("kitchen", "kitchen")).toEqual(["kitchen"]);
  });

  test("a kitchen-to-door walk rides the hallway spine instead of cutting the room", () => {
    const start = waypoints.kitchen;
    const path = corridorPoints(start, bfsPath("kitchen", "queue"), waypoints, spineY);
    expect(path.length).toBeGreaterThan(3);
    const onSpine = path.filter((point) => Math.abs(point.y - spineY) < 1);
    expect(onSpine.length).toBeGreaterThan(0);
    expect(path[path.length - 1]).toEqual(waypoints.queue);
  });

  test("more hops take longer than a single station slide", () => {
    const kitchenToPass = hopDurationMs(waypoints.kitchen, waypoints.pass);
    const path = corridorPoints(waypoints.kitchen, bfsPath("kitchen", "queue"), waypoints, spineY);
    let kitchenToDoor = 0;
    for (let i = 1; i < path.length; i++) kitchenToDoor += hopDurationMs(path[i - 1]!, path[i]!);
    expect(kitchenToDoor).toBeGreaterThan(kitchenToPass);
  });

  test("retargeting mid-walk starts from the current pixel, not the old station", () => {
    const walker = new StaffWalker("kitchen", waypoints.kitchen);
    walker.setTarget("queue", waypoints, spineY);
    expect(walker.walking).toBe(true);
    walker.step(400, 1);
    const mid = { x: walker.x, y: walker.y };
    expect(mid).not.toEqual(waypoints.kitchen);
    walker.setTarget("kitchen", waypoints, spineY);
    walker.step(16, 1);
    expect(Math.hypot(walker.x - mid.x, walker.y - mid.y)).toBeLessThan(40);
  });

  test("pause does not advance the walk", () => {
    const walker = new StaffWalker("kitchen", waypoints.kitchen);
    walker.setTarget("pass", waypoints, spineY);
    walker.step(800, 0);
    expect(walker.x).toBe(waypoints.kitchen.x);
    expect(walker.y).toBe(waypoints.kitchen.y);
    expect(walker.walking).toBe(true);
  });
});
