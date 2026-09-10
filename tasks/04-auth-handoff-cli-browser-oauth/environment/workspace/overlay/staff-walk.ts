import type { ArenaLocation, ArenaPoint } from "./restaurant-arena-layout.js";

export type WalkNode = ArenaLocation;
export type Point = ArenaPoint;

/**
 * Four station nodes, one hallway. The sim still only knows which room a
 * person is in; this graph is how the overlay walks them there.
 */
export const WALK_GRAPH: Record<WalkNode, readonly WalkNode[]> = {
  kitchen: ["pass"],
  pass: ["kitchen", "floor"],
  floor: ["pass", "queue"],
  queue: ["floor"],
};

const NODES: readonly WalkNode[] = ["kitchen", "pass", "floor", "queue"];

/** Pixels per second at 1×. One kitchen→pass hop reads as a walk, not a blink. */
export const WALK_SPEED_PX_PER_SEC = 200;

export function bfsPath(from: WalkNode, to: WalkNode): WalkNode[] {
  if (from === to) return [from];
  const queue: WalkNode[] = [from];
  const cameFrom = new Map<WalkNode, WalkNode | undefined>([[from, undefined]]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of WALK_GRAPH[current]) {
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, current);
      if (next === to) {
        const path: WalkNode[] = [];
        let step: WalkNode | undefined = to;
        while (step !== undefined) {
          path.push(step);
          step = cameFrom.get(step);
        }
        path.reverse();
        return path;
      }
      queue.push(next);
    }
  }
  return [from, to];
}

function nearly(a: Point, b: Point, px = 4): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < px;
}

function pushUnique(points: Point[], next: Point): void {
  const last = points[points.length - 1];
  if (last && nearly(last, next, 1.5)) return;
  points.push(next);
}

/**
 * Pixel path from wherever the person currently is, through the station
 * graph, using the pass as a hallway instead of cutting across tables.
 */
export function corridorPoints(
  start: Point,
  nodes: readonly WalkNode[],
  waypoints: Record<WalkNode, Point>,
  spineY: number,
): Point[] {
  const remaining =
    nodes[0] && nearly(start, waypoints[nodes[0]], 6) ? nodes.slice(1) : [...nodes];
  const points: Point[] = [{ x: start.x, y: start.y }];
  for (const node of remaining) {
    const dest = waypoints[node];
    const prev = points[points.length - 1]!;
    if (Math.abs(prev.x - dest.x) > 10) {
      if (Math.abs(prev.y - spineY) > 6) pushUnique(points, { x: prev.x, y: spineY });
      if (Math.abs(dest.x - prev.x) > 6) pushUnique(points, { x: dest.x, y: spineY });
    }
    pushUnique(points, { x: dest.x, y: dest.y });
  }
  return points;
}

export function hopDurationMs(from: Point, to: Point): number {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.max(80, (dist / WALK_SPEED_PX_PER_SEC) * 1000);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (Math.pow(-2 * t + 2, 2) / 2);
}

export class StaffWalker {
  x: number;
  y: number;
  facing: 1 | -1 = 1;
  walking = false;
  dragging = false;
  node: WalkNode;
  private target?: WalkNode;
  private points: Point[] = [];
  private hop = 0;
  private elapsed = 0;
  private duration = 1;

  constructor(node: WalkNode, slot: Point) {
    this.node = node;
    this.x = slot.x;
    this.y = slot.y;
    this.target = node;
  }

  snap(slot: Point, node: WalkNode): void {
    this.x = slot.x;
    this.y = slot.y;
    this.node = node;
    this.target = node;
    this.walking = false;
    this.points = [];
    this.hop = 0;
    this.elapsed = 0;
  }

  nearestNode(waypoints: Record<WalkNode, Point>): WalkNode {
    let best: WalkNode = this.node;
    let bestDist = Infinity;
    for (const node of NODES) {
      const dist = Math.hypot(this.x - waypoints[node].x, this.y - waypoints[node].y);
      if (dist < bestDist) {
        bestDist = dist;
        best = node;
      }
    }
    return best;
  }

  /**
   * Walk to `target` from the current pixel. Re-paths if the destination
   * changed mid-stride; no-ops if already idle on that slot.
   */
  setTarget(target: WalkNode, waypoints: Record<WalkNode, Point>, spineY: number): void {
    if (this.dragging) return;
    const dest = waypoints[target];
    if (!this.walking && this.node === target && nearly({ x: this.x, y: this.y }, dest, 2)) {
      return;
    }
    if (this.walking && this.target === target) {
      const last = this.points[this.points.length - 1];
      if (last && (last.x !== dest.x || last.y !== dest.y)) {
        this.points[this.points.length - 1] = dest;
      }
      return;
    }
    const fromNode = this.walking ? this.nearestNode(waypoints) : this.node;
    const nodes = bfsPath(fromNode, target);
    const points = corridorPoints({ x: this.x, y: this.y }, nodes, waypoints, spineY);
    this.target = target;
    this.points = points;
    this.hop = 0;
    this.elapsed = 0;
    if (points.length < 2) {
      this.snap(dest, target);
      return;
    }
    this.walking = true;
    this.duration = hopDurationMs(points[0]!, points[1]!);
    this.faceToward(points[1]!);
  }

  /**
   * Advance along the current corridor. `speed` is the sim multiplier (1/2/4);
   * 0 freezes the person in place — pause has to feel like a pause.
   * Returns true if the pixel position changed.
   */
  step(dtMs: number, speed: number): boolean {
    if (this.dragging || !this.walking || this.points.length < 2) return false;
    if (speed <= 0) return false;
    const from = this.points[this.hop]!;
    const to = this.points[this.hop + 1]!;
    this.elapsed += dtMs * speed;
    const t = Math.min(1, this.elapsed / this.duration);
    const eased = easeInOut(t);
    this.x = from.x + (to.x - from.x) * eased;
    this.y = from.y + (to.y - from.y) * eased;
    this.faceToward(to);
    if (t < 1) return true;
    this.x = to.x;
    this.y = to.y;
    this.hop += 1;
    this.elapsed = 0;
    if (this.hop + 1 >= this.points.length) {
      this.walking = false;
      this.node = this.target ?? this.node;
      this.points = [];
      this.hop = 0;
      return true;
    }
    this.duration = hopDurationMs(this.points[this.hop]!, this.points[this.hop + 1]!);
    this.faceToward(this.points[this.hop + 1]!);
    return true;
  }

  private faceToward(dest: Point): void {
    const dx = dest.x - this.x;
    if (Math.abs(dx) > 1) this.facing = dx < 0 ? -1 : 1;
  }
}
