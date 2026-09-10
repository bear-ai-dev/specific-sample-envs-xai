# Restaurant Arena overlay modules: exact API

Solver-visible contract for the three overlay modules described in the task
instruction (`restaurant-arena-layout.ts`, `staff-walk.ts`,
`restaurant-arena-repaint-gate.ts`). The instruction describes the required
*behavior*; this file pins down the exact exported names, signatures, and
field names other code (and the grading tests) call by. Any implementation
satisfying both the instruction's behavior and the shapes below is correct —
internal helpers, private fields, and implementation strategy are yours to
choose.

## `overlay/restaurant-arena-layout.ts`

```ts
export type ArenaRect = { x: number; y: number; width: number; height: number };
export type ArenaPoint = { x: number; y: number };
export type ArenaLocation = "floor" | "kitchen" | "pass" | "queue";

export interface RestaurantArenaLayout {
  compact: boolean;
  scale: number;
  feedBeside: boolean;
  topBar: ArenaRect;
  brief: ArenaRect;
  kitchen: ArenaRect;
  pass: ArenaRect;
  dining: ArenaRect;
  door: ArenaRect;
  doorStand: ArenaRect;
  waypoints: Record<ArenaLocation, ArenaPoint>;
  /** Y coordinate of the hallway line that runs through the pass zone. */
  spineY: number;
  tickets: ArenaRect;
  feed: ArenaRect;
}

export function restaurantArenaLayout(width: number, height: number): RestaurantArenaLayout;
```

`waypoints.floor` is the dining-room resting slot (staff location `"floor"`
in the walk graph below), `waypoints.queue` sits on `doorStand`.

## `overlay/staff-walk.ts`

```ts
export type WalkNode = ArenaLocation; // "floor" | "kitchen" | "pass" | "queue"
export type Point = ArenaPoint;

export const WALK_GRAPH: Record<WalkNode, readonly WalkNode[]>;
export const WALK_SPEED_PX_PER_SEC = 200;

export function bfsPath(from: WalkNode, to: WalkNode): WalkNode[];

/** Pixel path from `start`, through `nodes` in order, riding the y=`spineY`
 *  hallway instead of cutting diagonally through a room. */
export function corridorPoints(
  start: Point,
  nodes: readonly WalkNode[],
  waypoints: Record<WalkNode, Point>,
  spineY: number,
): Point[];

/** Duration of a single straight hop between two points, at WALK_SPEED_PX_PER_SEC. */
export function hopDurationMs(from: Point, to: Point): number;

export class StaffWalker {
  x: number;
  y: number;
  facing: 1 | -1;
  walking: boolean;
  dragging: boolean;
  node: WalkNode;

  /** `slot` is the pixel position of `node`; the walker starts parked there. */
  constructor(node: WalkNode, slot: Point);

  /** Teleport onto `slot`/`node` with no walk in progress (e.g. after a drag drop). */
  snap(slot: Point, node: WalkNode): void;

  /** Walk toward `target` from the current pixel, along the hallway at `spineY`. */
  setTarget(target: WalkNode, waypoints: Record<WalkNode, Point>, spineY: number): void;

  /** Advance the walk by `dtMs` at simulation `speed` (0 pauses). Returns
   *  whether the pixel position changed. */
  step(dtMs: number, speed: number): boolean;
}
```

## `overlay/restaurant-arena-repaint-gate.ts`

```ts
export class RepaintGate {
  constructor();

  /** True while a drag is open (between beginDrag() and endDrag()/resize()). */
  get isDragging(): boolean;

  beginDrag(): void;

  /** Paints immediately (returns true) unless a drag is open, in which case
   *  the paint is held back (returns false) and one repaint becomes owed. */
  requestPaint(): boolean;

  /** Ends the drag. Returns whether a repaint was held back during it
   *  (and thus needs to be replayed by the caller now). */
  endDrag(): boolean;

  /** Drops any open drag and clears anything owed, since the resize itself
   *  repaints from scratch. */
  resize(): void;
}
```

