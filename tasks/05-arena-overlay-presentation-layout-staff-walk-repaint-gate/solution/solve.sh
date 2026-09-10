#!/usr/bin/env bash
# Restores the responsive floor layout, staff corridor walking, and
# drag-safe repaint gating for the Restaurant Arena overlay.
set -euo pipefail
cd /app

mkdir -p "$(dirname "overlay/restaurant-arena-layout.ts")"
cat > "overlay/restaurant-arena-layout.ts" <<'ARENA_EOF_MARKER'
export type ArenaRect = { x: number; y: number; width: number; height: number };
export type ArenaPoint = { x: number; y: number };
export type ArenaLocation = "floor" | "kitchen" | "pass" | "queue";

export interface RestaurantArenaLayout {
  compact: boolean;
  /**
   * Text-size multiplier, 1 at the original 520x740 design size, growing
   * with the window so a resized overlay reads at the same relative size
   * instead of the same fixed pixel count spread over more canvas. Derived
   * from whichever axis is tighter, since the scene's row heights are fixed.
   */
  scale: number;
  /** True when the service log sits beside the floor instead of under it. */
  feedBeside: boolean;
  /** Clock, transport controls and money, across the top. */
  topBar: ArenaRect;
  /**
   * Manager brief: tonight's target, the running fail-condition tally, and
   * the one action the shift is waiting on. Sits directly under the top bar
   * so the story reads top-down — goal, pressure, next move — before the
   * eye reaches the floor.
   */
  brief: ArenaRect;
  kitchen: ArenaRect;
  pass: ArenaRect;
  dining: ArenaRect;
  /** The door — waiting parties stand here. */
  door: ArenaRect;
  /**
   * Host stand inside the door: the HOLD/OPEN control. Staff walking to the
   * queue plant on this slab rather than floating in the waiting line.
   */
  doorStand: ArenaRect;
  /**
   * Resting slots for each staffing zone. Walking interpolates between these
   * along the hallway spine; the sim still only stores the zone name.
   */
  waypoints: Record<ArenaLocation, ArenaPoint>;
  /** Hallway Y through the pass — walks go node → spine → node, not diagonal. */
  spineY: number;
  /** Ticket rail: one card per live order. */
  tickets: ArenaRect;
  /** Rolling service log of what the staff are doing and thinking. */
  feed: ArenaRect;
}

/**
 * The whole game lives on the canvas — there is no button strip under it —
 * so the layout has to find room for the floor, the tickets and the log in
 * whatever box the overlay gives us.
 */
export function restaurantArenaLayout(width: number, height: number): RestaurantArenaLayout {
  const w = Math.max(320, width);
  const h = Math.max(240, height);
  const compact = w < 460 || h < 420;
  // 520x740 is the original design size every fontSize tier was tuned
  // against. Both dimensions count: row heights, container heights and
  // vertical offsets in the scene are still fixed, so scaling text on width
  // alone would let a wide-and-short window (988x700, say) inflate type to
  // 1.9x inside rows that never grew, and the top bar and feed would collide.
  // Taking the smaller ratio keeps text inside whatever the tighter axis
  // allows. Capped so a very large window doesn't blow text out past legible.
  const scale = compact ? 1 : Math.min(1.9, Math.max(1, Math.min(w / 520, h / 740)));
  const gap = compact ? 4 : 6;
  const margin = compact ? 5 : 8;

  const topBarHeight = compact ? 30 : 38;
  // Two thin rows: the tally and the last call's receipt, then the one
  // instruction under them.
  const briefHeight = compact ? 26 : 32;
  const ticketsHeight = compact ? 60 : 72;

  // Wide windows get the rat-warren treatment: floor left, log down the
  // right. Narrow ones stack, because a 150px rail beside a 520px window
  // leaves no room for a dining room.
  const feedBeside = w >= 620;
  const feedWidth = feedBeside ? Math.round(Math.min(240, w * 0.3)) : 0;
  const feedHeight = feedBeside ? 0 : Math.max(compact ? 84 : 110, Math.round(h * 0.2));

  const bodyX = margin;
  const briefY = margin + topBarHeight + gap;
  const bodyY = briefY + briefHeight + gap;
  const bodyWidth = w - margin * 2 - (feedBeside ? feedWidth + gap : 0);
  const bodyBottom = h - margin - (feedBeside ? 0 : feedHeight + gap);
  const bodyHeight = Math.max(120, bodyBottom - bodyY);

  const floorHeight = Math.max(90, bodyHeight - ticketsHeight - gap);

  const kitchenWidth = Math.round(bodyWidth * (compact ? 0.27 : 0.25));
  const passWidth = Math.max(24, Math.round(bodyWidth * 0.07));
  const diningX = bodyX + kitchenWidth + gap + passWidth + gap;
  const diningWidth = Math.max(80, bodyX + bodyWidth - diningX);
  const doorHeight = Math.max(compact ? 40 : 56, Math.round(floorHeight * (compact ? 0.28 : 0.32)));
  const diningHeight = floorHeight - doorHeight - gap;

  const kitchen = { x: bodyX, y: bodyY, width: kitchenWidth, height: floorHeight };
  const pass = { x: bodyX + kitchenWidth + gap, y: bodyY, width: passWidth, height: floorHeight };
  const dining = { x: diningX, y: bodyY, width: diningWidth, height: diningHeight };
  const door = { x: diningX, y: bodyY + diningHeight + gap, width: diningWidth, height: doorHeight };
  const labelH = compact ? 12 : 14;
  const hostGutter = compact ? 30 : 40;
  const standWidth = Math.min(compact ? 72 : 90, Math.max(56, Math.round(door.width * 0.36)));
  const standHeight = Math.min(compact ? 26 : 36, Math.max(22, door.height - labelH - 4));
  const doorStand = {
    x: door.x + hostGutter,
    y: door.y + labelH,
    width: standWidth,
    height: standHeight,
  };
  const waypoints: Record<ArenaLocation, ArenaPoint> = {
    kitchen: { x: kitchen.x + kitchen.width - (compact ? 16 : 22), y: kitchen.y + (compact ? 24 : 30) },
    pass: { x: pass.x + pass.width / 2, y: pass.y + pass.height * 0.25 },
    floor: { x: dining.x + (compact ? 14 : 18), y: dining.y + dining.height - (compact ? 18 : 24) },
    queue: { x: door.x + hostGutter / 2, y: doorStand.y + doorStand.height * 0.62 },
  };

  return {
    compact,
    scale,
    feedBeside,
    topBar: { x: margin, y: margin, width: w - margin * 2, height: topBarHeight },
    brief: { x: margin, y: briefY, width: w - margin * 2, height: briefHeight },
    kitchen,
    pass,
    dining,
    door,
    doorStand,
    waypoints,
    spineY: pass.y + pass.height * 0.55,
    tickets: { x: bodyX, y: bodyY + floorHeight + gap, width: bodyWidth, height: ticketsHeight },
    feed: feedBeside
      ? { x: bodyX + bodyWidth + gap, y: bodyY, width: feedWidth, height: bodyHeight }
      : { x: margin, y: bodyBottom + gap, width: w - margin * 2, height: feedHeight },
  };
}
ARENA_EOF_MARKER

mkdir -p "$(dirname "overlay/staff-walk.ts")"
cat > "overlay/staff-walk.ts" <<'ARENA_EOF_MARKER'
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
ARENA_EOF_MARKER

mkdir -p "$(dirname "overlay/restaurant-arena-repaint-gate.ts")"
cat > "overlay/restaurant-arena-repaint-gate.ts" <<'ARENA_EOF_MARKER'
/**
 * Decides when the arena scene may repaint.
 *
 * A repaint rebuilds the whole display list, so one that lands mid-drag
 * destroys the token under the pointer and `dragend` never fires. The gate
 * holds repaints back while a drag is in flight and replays the one it owes
 * when the drag ends — and treats a resize as the one event that ends a drag
 * on the scene's behalf, since a resize has to repaint no matter what.
 */
export class RepaintGate {
  private dragging = false;
  private owed = false;

  get isDragging(): boolean {
    return this.dragging;
  }

  beginDrag(): void {
    this.dragging = true;
  }

  /** A state update arrived. Returns whether the scene should paint now. */
  requestPaint(): boolean {
    if (this.dragging) {
      this.owed = true;
      return false;
    }
    return true;
  }

  /** The drag finished. Returns whether a repaint was held back during it. */
  endDrag(): boolean {
    this.dragging = false;
    const owed = this.owed;
    this.owed = false;
    return owed;
  }

  /**
   * The canvas changed size, so the scene is about to repaint regardless.
   * That repaint destroys any token being dragged, so the drag is abandoned
   * here — leaving it open would park every later update in `owed` and freeze
   * the floor until the next resize.
   */
  resize(): void {
    this.dragging = false;
    this.owed = false;
  }
}
ARENA_EOF_MARKER

mkdir -p "$(dirname "overlay/restaurant-arena-scene.ts")"
cat > "overlay/restaurant-arena-scene.ts" <<'ARENA_EOF_MARKER'
import Phaser from "phaser";
import { restaurantArenaLayout, type ArenaRect, type RestaurantArenaLayout } from "./restaurant-arena-layout.js";
import { StaffWalker } from "./staff-walk.js";
import { RepaintGate } from "./restaurant-arena-repaint-gate.js";
import { milestoneFeedText } from "./restaurant-arena-milestones.js";
import { arenaBrief } from "./restaurant-arena-brief.js";
import {
  initOutcomeToastState,
  updateOutcomeToastState,
  type OutcomeToastState,
} from "./restaurant-arena-toast.js";

export type { OutcomeToastState } from "./restaurant-arena-toast.js";

/**
 * Supersampling factor for the canvas backing store. `mountRestaurantArenaScene`
 * boots the Phaser game at `cssSize * DPR` and `RestaurantArenaScene` zooms its
 * camera by the same factor, so world content authored in CSS-pixel units (see
 * `RestaurantArenaScene.cssWidth`/`cssHeight`) fills the larger backing store
 * instead of rendering small in a corner of it. Both sides have to move
 * together — see the comment on `RestaurantArenaScene.dpr` for the failure
 * mode when they don't. Capped at 2 so a 3x phone screen doesn't triple the
 * fill-rate cost for no visible gain.
 */
 const DPR = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);

export type Role = "host" | "supply_lead" | "chef" | "server" | "expediter";
type Location = "floor" | "kitchen" | "pass" | "queue";
type OrderStatus = "queued" | "seated" | "preparing" | "ready" | "served" | "cancelled";
export type RestaurantArenaWorkerStatus = "idle" | "thinking" | "acting" | "error";

export interface RestaurantArenaState {
  episode: { tick: number; maxTicks: number };
  clock: { minute: number };
  tables: { id: string; seats: number; status: "empty" | "occupied"; orderId?: string }[];
  orders: { id: string; tableId?: string; items: string[]; status: OrderStatus; allergy?: string; priority: "normal" | "high" }[];
  inventory: Record<string, number>;
  equipment: { id: string; kind: "oven" | "warming_shelf"; status: "working" | "failed" | "degraded" }[];
  workers: { id: string; role: Role; location: Location; load: number }[];
  emergency?: { kind: string; active: boolean; startedAt: number };
  seatingHeld?: boolean;
  reputation?: number;
  outcomes: { cash: number; satisfaction: number; waste: number; completed: number };
  /** Present once the game exposes its playable layer; absent in raw fixtures. */
  sim?: { started: boolean; running: boolean; speed: number };
  feed?: { id: number; clock: string; who: string; voice: string; kind: string; text: string }[];
  waiting?: { id: string; size: number; patience: number; waitedTicks: number }[];
  decision?: {
    id: string;
    title: string;
    speaker: string;
    speakerRole: Role;
    prompt: string;
    options: { id: string; label: string; detail: string; tone: "safe" | "risky" | "neutral" }[];
  };
  staff?: Record<Role, { name: string; title: string; trait: string }>;
  goal?: { cash: number; maxWalkouts: number; unsafeAllowed: number };
  shift?: { id: string; title: string };
  upgrade?: { id: string; label: string; cost: number; bought: boolean };
  /** The receipt for the most recently answered decision, if any yet. */
  lastOutcome?: { id: string; headline: string; tone: "safe" | "risky" | "neutral" };
  coach?: { step: number; total: number; title: string; detail: string };
  /** Running fail-condition counters, for the manager brief. */
  tally?: { walkouts: number; unsafeServed: number };
}

const COLORS = {
  ink: 0x241b14,
  panel: 0x2f241a,
  cream: 0xfff3d6,
  kitchen: 0xc9dbd2,
  kitchenDark: 0x4f796f,
  dining: 0xecc9a8,
  wood: 0xb9814f,
  pass: 0xf2cc5c,
  door: 0xa8c6da,
  empty: 0xc7ab86,
  occupied: 0xe8825f,
  working: 0x3d9b6d,
  failed: 0xc73535,
  ticket: 0xfff8e7,
  loadOk: 0x3d9b6d,
  loadWarn: 0xe08b2c,
  loadHot: 0xc73535,
  alert: 0xc73535,
  muted: 0x8d8378,
} as const;

const ROLE_COLORS: Record<Role, number> = {
  host: 0x9763bd,
  supply_lead: 0xe69b2e,
  chef: 0xe44f3f,
  server: 0x3d73bf,
  expediter: 0xe69b2e,
};

const STATUS_COLORS: Record<OrderStatus, number> = {
  queued: 0x8d8378,
  seated: 0x6f8fb5,
  preparing: 0xe08b2c,
  ready: 0x3d9b6d,
  served: 0x4f796f,
  cancelled: 0xc73535,
};

const VOICE_COLORS: Record<string, string> = {
  host: "#c79bea",
  supply_lead: "#f4bf6a",
  chef: "#ff8f80",
  server: "#8ab6ef",
  expediter: "#f4bf6a",
  house: "#c9bdae",
  you: "#7ddc9f",
};

const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
/** Spoken lines — a person talking, not a log. */
const DISPLAY = '"Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif';
/** Buttons, names, UI copy. */
const SANS = '"Avenir Next", "Segoe UI", "Helvetica Neue", system-ui, sans-serif';

const DEFAULT_STAFF: Record<Role, { name: string; title: string; trait: string }> = {
  host: { name: "Host", title: "Host", trait: "" },
  supply_lead: { name: "Supply Lead", title: "Supply Lead", trait: "" },
  chef: { name: "Chef", title: "Chef", trait: "" },
  server: { name: "Server", title: "Server", trait: "" },
  get expediter() {
    return this.supply_lead;
  },
};

function clockLabel(minute: number): string {
  const total = 17 * 60 + 30 + Math.max(0, Math.round(minute));
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function loadColor(load: number): number {
  if (load > 0.8) return COLORS.loadHot;
  if (load >= 0.5) return COLORS.loadWarn;
  return COLORS.loadOk;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export class RestaurantArenaScene extends Phaser.Scene {
  private state: RestaurantArenaState;
  private onAction: (action: string) => void;
  /** Host-shell navigation — leaving to the menu, restarting the run — isn't a game action. */
  private onUi: (action: "menu" | "restart" | "help") => void;
  /** A repaint mid-drag would delete the token under the pointer. */
  private readonly gate = new RepaintGate();
  private layout?: RestaurantArenaLayout;
  private dropHints: Phaser.GameObjects.Rectangle[] = [];
  /** Which `state.lastOutcome.id` has already been shown, so a re-render mid-fade doesn't restart it. */
  private shownOutcomeId?: string;
  private outcomeToast?: { headline: string; tone: "safe" | "risky" | "neutral"; startedAt: number };
  private readonly outcomeToastMs = 2600;
  /**
   * Every text size in this scene was tuned against the 520x740 design
   * width, in two fixed tiers (compact/normal). Without this, a bigger
   * window just spreads those same tiny fixed sizes over more canvas — the
   * text gets no easier to read, only further apart. `layout.scale` carries
   * how far the window has grown past that baseline; this rounds a design
   * size into the actual pixel string Phaser wants.
   */
  private fs(px: number): string {
    return `${Math.round(px * (this.layout?.scale ?? 1))}px`;
  }

  /**
   * Phaser's canvas backing store matches CSS pixels, not device pixels, so
   * on any HiDPI screen the whole scene — vector shapes and text alike — is
   * drawn small and stretched up by the browser, which is what reads as
   * "blurry". The fix is a backing store `dpr`× the CSS size with the camera
   * zoomed to match: `mountRestaurantArenaScene` boots the game at
   * `cssSize * DPR`, and `cssWidth`/`cssHeight` below convert
   * `this.scale.width/height` (the backing store's pixel dimensions under
   * that scheme) back to the CSS-pixel units every layout call in this file
   * is authored in.
   *
   * An earlier attempt at this reliably painted the floor into a small
   * corner of the canvas instead of filling it once the backing store grew
   * past roughly one screen's worth of pixels, across every combination of
   * mutating a live game vs. booting fresh at the final size, and
   * `Scale.RESIZE` vs `Scale.NONE`. The actual cause: the game was booted at
   * the backing-store size, but `boot()` never multiplied its `width`/
   * `height` args by `dpr` before constructing `Phaser.Game` — so the
   * backing store stayed at 1× while the camera zoomed to `dpr`, which is
   * exactly the "zoomed into a corner" symptom (a `dpr`-zoomed camera
   * showing only `1/dpr` of a same-size backing store). Fixed by giving
   * `boot()` and this class the same `DPR` module constant instead of two
   * independent values that could disagree.
   */
  private readonly dpr = DPR;

  /** `this.scale.width/height` in CSS-pixel units — see `dpr` above. */
  private get cssWidth(): number {
    return Math.round((this.scale.width || 520 * this.dpr) / this.dpr);
  }
  private get cssHeight(): number {
    return Math.round((this.scale.height || 300 * this.dpr) / this.dpr);
  }
  private workerStatuses = new Map<Role, RestaurantArenaWorkerStatus>();
  /** Pixel walkers survive paints; the sim still only stores a zone name. */
  private readonly walkers = new Map<Role, StaffWalker>();
  private readonly staffTokens = new Map<Role, Phaser.GameObjects.Container>();
  private walkClock = 0;

  constructor(
    state: RestaurantArenaState,
    onAction: (action: string) => void = () => {},
    onUi: (action: "menu" | "restart" | "help") => void = () => {},
    initialToastState?: OutcomeToastState,
  ) {
    super("restaurant-arena");
    this.state = state;
    this.onAction = onAction;
    this.onUi = onUi;
    const toastState = initOutcomeToastState(state.lastOutcome, initialToastState);
    this.shownOutcomeId = toastState.shownOutcomeId;
    this.outcomeToast = toastState.outcomeToast;
  }

  getOutcomeToastState(): OutcomeToastState {
    return {
      shownOutcomeId: this.shownOutcomeId,
      outcomeToast: this.outcomeToast,
    };
  }

  private staff(role: Role): { name: string; title: string; trait: string } {
    return this.state.staff?.[role] ?? DEFAULT_STAFF[role];
  }

  private get running(): boolean {
    return Boolean(this.state.sim?.running);
  }

  // ── Interaction primitives ───────────────────────────────────────────

  /**
   * Turn a region into a control. Everything the player can do is a thing
   * on the floor — there is no key strip under the canvas — so each one has
   * to announce itself on hover and say what it does.
   */
  private hotspot(rect: ArenaRect, action: string, tip?: string, depth = 5, dispatch?: (action: string) => void): Phaser.GameObjects.Rectangle {
    const zone = this.add.rectangle(rect.x, rect.y, rect.width, rect.height, 0xffffff, 0.001).setOrigin(0, 0);
    zone.setInteractive({ useHandCursor: true });
    zone.setDepth(depth);
    const halo = this.add.rectangle(rect.x, rect.y, rect.width, rect.height).setOrigin(0, 0);
    halo.setStrokeStyle(2, COLORS.pass, 0.95);
    halo.setDepth(depth);
    halo.setVisible(false);
    zone.on("pointerover", () => {
      halo.setVisible(true);
      if (tip) this.showTip(rect, tip);
    });
    zone.on("pointerout", () => {
      halo.setVisible(false);
      this.hideTip();
    });
    zone.on("pointerdown", () => {
      this.hideTip();
      (dispatch ?? this.onAction)(action);
    });
    return zone;
  }

  private tip?: Phaser.GameObjects.Container;

  /** Hover label so a first-time player can read the floor instead of guessing. */
  private showTip(rect: ArenaRect, text: string): void {
    this.hideTip();
    const compact = this.layout?.compact ?? false;
    const label = this.add.text(0, 0, text, {
      color: "#2b2118",
      fontFamily: MONO,
      fontSize: compact ? this.fs(7) : this.fs(9),
      fontStyle: "bold",
      padding: { x: 4, y: 3 },
    });
    const width = label.width + 8;
    const height = label.height + 6;
    const maxX = this.cssWidth - width - 4;
    const x = Math.max(4, Math.min(maxX, rect.x + rect.width / 2 - width / 2));
    // Above the target by default, below it when the target is near the top
    // edge — a tip that covers the transport controls is worse than none.
    const above = rect.y - height - 3;
    const y = above >= 2 ? above : rect.y + rect.height + 3;
    const bg = this.add.rectangle(0, 0, width, height, COLORS.pass).setOrigin(0, 0);
    bg.setStrokeStyle(1, COLORS.ink, 0.9);
    label.setPosition(4, 3);
    this.tip = this.add.container(x, y, [bg, label]).setDepth(90);
  }

  private hideTip(): void {
    this.tip?.destroy();
    this.tip = undefined;
  }

  /** A pill button drawn on the canvas: the only kind of button this game has. */
  private button(
    rect: ArenaRect,
    label: string,
    action: string,
    opts: { fill?: number; text?: string; size?: number; tip?: string; depth?: number; dispatch?: (action: string) => void } = {},
  ): void {
    const depth = opts.depth ?? 6;
    const bg = this.add.rectangle(rect.x, rect.y, rect.width, rect.height, opts.fill ?? 0x4a3a2c).setOrigin(0, 0);
    bg.setStrokeStyle(1, COLORS.cream, 0.35);
    bg.setDepth(depth);
    const text = this.add
      .text(rect.x + rect.width / 2, rect.y + rect.height / 2, label, {
        color: opts.text ?? "#fff3d6",
        fontFamily: MONO,
        fontSize: this.fs(opts.size ?? 9),
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setDepth(depth + 1);
    const zone = this.hotspot(rect, action, opts.tip, depth + 2, opts.dispatch);
    zone.on("pointerover", () => bg.setFillStyle(Phaser.Display.Color.ValueToColor(opts.fill ?? 0x4a3a2c).lighten(18).color));
    zone.on("pointerout", () => bg.setFillStyle(opts.fill ?? 0x4a3a2c));
    void text;
  }

  create(): void {
    // Every state change repaints from scratch, which destroys the zone the
    // cursor is sitting on and builds a new one in its place. Phaser only
    // re-tests what is under a *stationary* pointer when the pointer moves,
    // so without polling the second of two clicks on the same button — speed
    // 1x→2x→4x, most obviously — lands on nothing and is silently dropped.
    this.input.setPollAlways();
    this.patchTextResolution();
    this.applyHiDpi();
    this.paint();
    // The stage can still be settling when Phaser boots, and a paint sized off
    // a half-laid-out parent leaves a blank canvas until something resizes it.
    // There's no further "resize" event to catch that later, on purpose —
    // see `mountRestaurantArenaScene`, which tears down and boots a fresh
    // scene for any genuine later resize rather than mutating a live one.
    this.time.delayedCall(0, () => {
      this.applyHiDpi();
      this.paint();
    });
  }

  /**
   * `Text` game objects rasterize to their own offscreen canvas at
   * `style.resolution`, which Phaser hardcodes to 1 unless a caller sets it
   * — independent of the backing-store fix below. Left alone, every label
   * would still upscale-blur once the camera zooms in to fill the bigger
   * backing store. Patching the factory here means every existing
   * `this.add.text(...)` call site downstream stays untouched.
   */
  private patchTextResolution(): void {
    const dpr = this.dpr;
    const originalText = this.add.text.bind(this.add);
    this.add.text = ((x: number, y: number, content: string | string[], style?: Phaser.Types.GameObjects.Text.TextStyle) =>
      originalText(x, y, content, { resolution: dpr, ...style })) as typeof this.add.text;
  }

  /**
   * The canvas is already booted at `dpr` × the CSS size (see `dpr` above
   * and `mountRestaurantArenaScene`), so the backing store, renderer and
   * camera dimensions are already right — Phaser set them up that way at
   * construction and none of them are touched again here. What's left is
   * purely cosmetic: shrink the canvas' *displayed* CSS box back down to
   * its intended footprint (a style change, not a resize), and zoom the
   * camera so world content — authored in CSS-pixel units via `cssWidth`/
   * `cssHeight` — fills the larger backing store instead of rendering
   * small in its top-left corner.
   */
  private applyHiDpi(): void {
    const canvas = this.game.canvas;
    canvas.style.width = `${this.cssWidth}px`;
    canvas.style.height = `${this.cssHeight}px`;
    // A Phaser camera zooms around its own center, not the world origin —
    // at zoom 1 that's invisible (center and origin coincide when the
    // viewport already matches the content), but zooming in without
    // recentering shows the viewport's *center* region of world space, not
    // its top-left. Content here is authored from (0,0), so without this the
    // camera looks at world space centered on (cssWidth/2, cssHeight/2)
    // scaled by zoom — mostly *outside* our (0,0)-(cssWidth,cssHeight)
    // content — instead of that content filling the frame. This is the
    // actual cause of the "painted into a corner" symptom from the earlier
    // investigation (see the `dpr` field's comment): every combination tried
    // there still zoomed around the center, so all of them would have shown
    // the same wrong region regardless of scale mode or boot timing.
    this.cameras.main.setZoom(this.dpr).centerOn(this.cssWidth / 2, this.cssHeight / 2);
  }

  setState(state: RestaurantArenaState): void {
    this.state = state;
    const toastState = updateOutcomeToastState(
      { shownOutcomeId: this.shownOutcomeId, outcomeToast: this.outcomeToast },
      state.lastOutcome,
    );
    this.shownOutcomeId = toastState.shownOutcomeId;
    this.outcomeToast = toastState.outcomeToast;
    if (!this.sys.isActive()) return;
    if (this.gate.requestPaint()) this.paint();
  }

  /**
   * Walks live between sim ticks. `paint()` still rebuilds the floor chrome,
   * but the walker keeps the current pixel so a person can cross the pass
   * without teleporting when the next state arrives.
   */
  update(_time: number, delta: number): void {
    if (!this.sys.isActive()) return;
    const speed = this.running ? (this.state.sim?.speed ?? 1) : 0;
    this.walkClock += delta;
    for (const [role, walker] of this.walkers) {
      const moved = walker.step(delta, speed);
      const token = this.staffTokens.get(role);
      if (!token || walker.dragging) continue;
      const figure = token.getByName("figure") as Phaser.GameObjects.Container | undefined;
      if (walker.walking) {
        this.tweens.killTweensOf(token);
        token.setPosition(walker.x, walker.y);
        const squash = 1 + Math.sin(this.walkClock / 70) * 0.04;
        figure?.setScale(walker.facing, squash);
      } else if (moved) {
        token.setPosition(walker.x, walker.y);
        figure?.setScale(walker.facing, 1);
        this.startIdleBob(token, walker.y, role);
      }
    }
  }

  private startIdleBob(token: Phaser.GameObjects.Container, restY: number, role: Role): void {
    if (!this.running) return;
    this.tweens.killTweensOf(token);
    token.setY(restY);
    this.tweens.add({
      targets: token,
      y: restY - 1.5,
      duration: 900 + (role.length % 3) * 140,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private paint(): void {
    this.tweens.killAll();
    this.hideTip();
    this.children.removeAll(true);
    this.staffTokens.clear();
    const width = Math.max(320, this.cssWidth);
    const height = Math.max(240, this.cssHeight);
    const layout = restaurantArenaLayout(width, height);
    this.layout = layout;
    this.dropHints = [];
    const g = this.add.graphics();

    g.fillStyle(COLORS.ink);
    g.fillRect(0, 0, width, height);

    this.drawTopBar(g, layout);
    this.drawBrief(g, layout);
    this.drawKitchen(g, layout);
    this.drawPass(g, layout);
    this.drawDining(g, layout);
    this.drawDoor(g, layout);
    this.drawTickets(g, layout);
    this.drawFeed(g, layout);
    this.drawWorkers(layout);
    this.drawIncidentBanner(layout);
    this.drawOutcomeToast(width, height);
    if (!this.state.sim?.started) this.drawPreShift(layout, width, height);
    else if (this.state.decision) this.drawDecision(layout, width, height);
  }

  // ── Top bar: the transport controls live in the game, not under it ──

  private drawTopBar(g: Phaser.GameObjects.Graphics, layout: RestaurantArenaLayout): void {
    const bar = layout.topBar;
    const compact = layout.compact;
    const sim = this.state.sim;
    g.fillStyle(COLORS.panel);
    g.fillRoundedRect(bar.x, bar.y, bar.width, bar.height, 4);

    const size = bar.height - (compact ? 8 : 10);
    const pad = compact ? 4 : 6;
    let x = bar.x + pad;

    // Host-shell navigation lives on the floor too, not in chrome above it —
    // same reasoning as every other control here.
    const navWidth = size + 6;
    this.button(
      { x, y: bar.y + (bar.height - size) / 2, width: navWidth, height: size },
      "‹",
      "menu",
      { size: compact ? 10 : 12, tip: "Back to the menu", dispatch: () => this.onUi("menu") },
    );
    x += navWidth + pad;

    if (sim) {
      const paused = !sim.running;
      this.button(
        { x, y: bar.y + (bar.height - size) / 2, width: size + 6, height: size },
        paused ? ">" : "||",
        "sim_toggle",
        {
          fill: paused ? 0x3d9b6d : 0x4a3a2c,
          size: compact ? 10 : 12,
          tip: paused ? "Resume (space)" : "Pause (space)",
        },
      );
      x += size + 6 + pad;

      this.button(
        { x, y: bar.y + (bar.height - size) / 2, width: size + 10, height: size },
        `×${sim.speed}`,
        "sim_speed",
        { size: compact ? 8 : 10, tip: "Speed (f)" },
      );
      x += size + 10 + pad;
    }

    // Clock + a bar that fills as the shift burns down. A stopped clock has
    // to be unmistakable, so it greys out and says so.
    const paused = Boolean(sim?.started) && !sim?.running;
    const clock = this.add
      .text(x, bar.y + bar.height / 2, clockLabel(this.state.clock.minute), {
        color: paused ? "#8d8378" : "#fff3d6",
        fontFamily: MONO,
        fontSize: compact ? this.fs(11) : this.fs(14),
        fontStyle: "bold",
      })
      .setOrigin(0, 0.5);
    x += clock.width + pad;

    if (paused) {
      const label = this.state.decision ? "NEEDS A CALL" : "PAUSED";
      const chip = this.add
        .text(x, bar.y + bar.height / 2, label, {
          color: "#2b2118",
          backgroundColor: this.state.decision ? "#f2cc5c" : "#8d8378",
          fontFamily: MONO,
          fontSize: compact ? this.fs(6) : this.fs(7),
          fontStyle: "bold",
          padding: { x: 3, y: 1 },
        })
        .setOrigin(0, 0.5);
      if (this.state.decision) {
        this.tweens.add({ targets: chip, alpha: 0.45, duration: 620, yoyo: true, repeat: -1 });
      }
      x += chip.width + pad;
    }

    const { tick, maxTicks } = this.state.episode;
    const progress = maxTicks > 0 ? Math.min(1, Math.max(0, tick / maxTicks)) : 0;

    // Restart sits at the hard-right edge; money and reputation sit just
    // inside it, and the progress bar takes whatever slack is left.
    const restartX = bar.x + bar.width - pad - navWidth;
    this.button(
      { x: restartX, y: bar.y + (bar.height - size) / 2, width: navWidth, height: size },
      "↻",
      "restart",
      { size: compact ? 10 : 12, tip: "Restart the shift", dispatch: () => this.onUi("restart") },
    );
    const helpX = restartX - pad - navWidth;
    this.button(
      { x: helpX, y: bar.y + (bar.height - size) / 2, width: navWidth, height: size },
      "?",
      "help",
      { size: compact ? 10 : 12, tip: "How to Play", dispatch: () => this.onUi("help") },
    );
    const rightEdge = helpX - pad;

    // Takings read against tonight's target, so the number always means
    // something — "$96" alone tells the player nothing.
    const goalCash = this.state.goal?.cash;
    const amount = Math.round(this.state.outcomes.cash);
    const formattedCash = amount < 0 ? `-$${Math.abs(amount)}` : `$${amount}`;
    const cash = goalCash ? `${formattedCash}/$${goalCash}` : formattedCash;
    // A 1-5 rating reads at a glance the way a percentage never does —
    // "3/5" is a milestone a player recognizes instantly, not a figure they
    // have to interpret.
    const stars = Math.max(1, Math.min(5, Math.round((this.state.reputation ?? 50) / 20)));
    const rating = `${stars}/5`;
    const onTarget = !goalCash || this.state.outcomes.cash >= goalCash;
    const cashText = this.add
      .text(rightEdge, bar.y + bar.height / 2 - (compact ? 5 : 6), cash, {
        color: onTarget ? "#7ddc9f" : "#e8ddcc",
        fontFamily: MONO,
        fontSize: compact ? this.fs(10) : this.fs(12),
        fontStyle: "bold",
      })
      .setOrigin(1, 0.5);
    const repText = this.add
      .text(rightEdge, bar.y + bar.height / 2 + (compact ? 6 : 7), `${rating}   ${this.state.outcomes.completed} served`, {
        color: "#f2cc5c",
        fontFamily: MONO,
        fontSize: compact ? this.fs(7) : this.fs(9),
      })
      .setOrigin(1, 0.5);

    const trackX = x + pad;
    const trackWidth = Math.max(16, rightEdge - Math.max(cashText.width, repText.width) - pad - trackX);
    const trackHeight = compact ? 4 : 6;
    const trackY = bar.y + (bar.height - trackHeight) / 2;
    g.fillStyle(0x4a3a2c);
    g.fillRoundedRect(trackX, trackY, trackWidth, trackHeight, trackHeight / 2);
    if (progress > 0) {
      g.fillStyle(COLORS.pass);
      g.fillRoundedRect(trackX, trackY, Math.max(trackHeight, trackWidth * progress), trackHeight, trackHeight / 2);
    }
  }

  private zonePanel(
    g: Phaser.GameObjects.Graphics,
    zone: ArenaRect,
    color: number,
    label: string,
    compact: boolean,
    vertical = false,
  ): void {
    g.fillStyle(color);
    g.fillRoundedRect(zone.x, zone.y, zone.width, zone.height, compact ? 3 : 5);
    g.lineStyle(2, COLORS.ink, 0.5);
    g.strokeRoundedRect(zone.x, zone.y, zone.width, zone.height, compact ? 3 : 5);
    const text = this.add.text(zone.x + 5, zone.y + 4, label, {
      color: "#3b2b20",
      fontFamily: "Arial Narrow, sans-serif",
      fontSize: compact ? this.fs(7) : this.fs(9),
      fontStyle: "bold",
    });
    if (vertical) text.setOrigin(0.5, 0).setAngle(90).setPosition(zone.x + zone.width / 2, zone.y + zone.height / 2);
  }

  private drawKitchen(g: Phaser.GameObjects.Graphics, layout: RestaurantArenaLayout): void {
    const zone = layout.kitchen;
    const compact = layout.compact;
    this.zonePanel(g, zone, COLORS.kitchen, "KITCHEN", compact);

    const pad = compact ? 5 : 8;
    const top = zone.y + (compact ? 15 : 20);
    const oven = this.state.equipment.find((item) => item.kind === "oven");
    const stock = Object.values(this.state.inventory).reduce((sum, count) => sum + count, 0);
    const stations: Array<{ label: string; sub: string; color: number; action?: string; tip?: string; dim?: boolean }> = [
      { label: "PREP", sub: "", color: 0xf1e6c8 },
      { label: "PANTRY", sub: `${stock} left`, color: 0xd4b483 },
      {
        label: "OVEN",
        sub: oven?.status === "failed" ? "DEAD — CLICK" : oven?.status === "degraded" ? "limping" : "ready",
        color: oven?.status === "failed" ? COLORS.failed : oven?.status === "degraded" ? 0xd6892f : COLORS.working,
        action: oven?.status === "failed" ? "inspect_oven" : undefined,
        tip: oven?.status === "failed" ? "Fix the oven" : undefined,
      },
    ];
    // The one in-shift purchase on offer — a permanent second pair of hands
    // at the stations, paid for out of tonight's own takings. Affordable
    // once cash clears the cost; a one-time click, not a recurring cost.
    const upgrade = this.state.upgrade;
    if (upgrade) {
      const affordable = this.state.outcomes.cash >= upgrade.cost;
      stations.push(
        upgrade.bought
          ? { label: upgrade.label.toUpperCase(), sub: "installed", color: 0x8fbfa0 }
          : {
              label: `+${upgrade.label.toUpperCase()}`,
              sub: `$${upgrade.cost} — click`,
              color: affordable ? COLORS.pass : 0x5c4a3a,
              action: affordable ? "buy_second_stove" : undefined,
              tip: affordable ? "Second pair of hands, all shift" : `Need $${upgrade.cost} to install`,
              dim: !affordable,
            },
      );
    }

    // On a real desktop window this zone can run far taller than these
    // cards need — capped height plus vertical centering keeps them a
    // sensible size instead of stretching into empty slabs.
    const rawStationHeight = (zone.height - (top - zone.y) - pad * (stations.length + 1)) / stations.length;
    const stationHeight = Math.min(compact ? 40 : 76, Math.max(14, rawStationHeight));
    const groupHeight = stationHeight * stations.length + pad * (stations.length - 1);
    const groupTop = top + Math.max(0, (zone.height - (top - zone.y) - groupHeight) / 2);

    stations.forEach((station, index) => {
      const y = groupTop + index * (stationHeight + pad);
      const rect = { x: zone.x + pad, y, width: zone.width - pad * 2, height: stationHeight };
      g.fillStyle(station.color, station.dim ? 0.6 : 1);
      g.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, 3);
      g.lineStyle(1, COLORS.kitchenDark, 0.8);
      g.strokeRoundedRect(rect.x, rect.y, rect.width, rect.height, 3);
      const broken = station.label === "OVEN" && oven?.status === "failed";
      this.add
        .text(zone.x + zone.width / 2, y + stationHeight / 2 - (station.sub ? 4 : 0), station.label, {
          color: broken ? "#ffffff" : "#2b2118",
          fontFamily: MONO,
          fontSize: compact ? this.fs(6) : this.fs(8),
          fontStyle: "bold",
        })
        .setOrigin(0.5);
      if (station.sub) {
        this.add
          .text(zone.x + zone.width / 2, y + stationHeight / 2 + 5, station.sub, {
            color: broken ? "#ffe2e2" : "#5c4a3a",
            fontFamily: MONO,
            fontSize: compact ? this.fs(5) : this.fs(6),
            fontStyle: "bold",
          })
          .setOrigin(0.5);
      }
      if (station.action) this.hotspot(rect, station.action, station.tip);
    });
  }

  private drawPass(g: Phaser.GameObjects.Graphics, layout: RestaurantArenaLayout): void {
    const zone = layout.pass;
    this.zonePanel(g, zone, COLORS.pass, "PASS", layout.compact, true);
    this.hotspot(zone, "verify_substitution", "Verify the ticket");
    const y = zone.y + zone.height * 0.6;
    g.fillStyle(0x7b4c2e);
    g.fillRoundedRect(zone.x + 3, y, zone.width - 6, layout.compact ? 12 : 18, 3);
    // Plates waiting on the pass = orders cooked but not yet run to a table.
    const ready = this.state.orders.filter((order) => order.status === "ready").length;
    for (let i = 0; i < Math.min(3, ready); i++) {
      g.fillStyle(0xfff3d6);
      g.fillCircle(zone.x + zone.width / 2, y + 4 + i * (layout.compact ? 5 : 7), layout.compact ? 2.5 : 3.5);
    }
    if (ready > 0) {
      this.add
        .text(zone.x + zone.width / 2, zone.y + zone.height - 4, `${ready}`, {
          color: "#2b2118",
          fontFamily: MONO,
          fontSize: layout.compact ? this.fs(7) : this.fs(9),
          fontStyle: "bold",
        })
        .setOrigin(0.5, 1);
    }
  }

  private drawDining(g: Phaser.GameObjects.Graphics, layout: RestaurantArenaLayout): void {
    const zone = layout.dining;
    const compact = layout.compact;
    this.zonePanel(g, zone, COLORS.dining, "DINING", compact);

    const tables = this.state.tables.slice(0, 4);
    const top = zone.y + (compact ? 15 : 19);
    const available = Math.max(24, zone.height - (top - zone.y) - 4);
    const cols = tables.length > 2 ? 2 : tables.length || 1;
    const rows = Math.ceil(tables.length / cols) || 1;

    tables.forEach((table, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const cx = zone.x + (zone.width * (col + 0.5)) / cols;
      const cy = top + (available * (row + 0.5)) / rows;
      // Capped at a fixed 18px, tables read as a sparse handful of dots on a
      // real desktop window where this zone is much bigger than a 520px
      // canvas — let them grow with the room, not just with the cell they
      // have to fit in.
      const fitsCell = Math.min(zone.width / cols, available / rows) * 0.3;
      const styleCap = compact ? 13 : Math.min(32, 18 + Math.max(0, zone.width - 360) * 0.03);
      const radius = Math.max(8, Math.min(styleCap, fitsCell));

      // Chairs first so the table top sits over them.
      const seats = Math.min(table.seats, 4);
      for (let seat = 0; seat < seats; seat++) {
        const angle = (Math.PI * 2 * seat) / seats - Math.PI / 2;
        g.fillStyle(0x8a5a34);
        g.fillCircle(cx + Math.cos(angle) * (radius + 5), cy + Math.sin(angle) * (radius + 5), compact ? 2.5 : 3.5);
      }
      g.fillStyle(table.status === "occupied" ? COLORS.occupied : COLORS.empty);
      g.fillCircle(cx, cy, radius);
      g.lineStyle(2, COLORS.cream, 0.85);
      g.strokeCircle(cx, cy, radius);

      const order = this.state.orders.find((o) => o.tableId === table.id && o.status !== "served" && o.status !== "cancelled");
      this.add
        .text(cx, cy, table.id.replace("table-", "T"), {
          color: "#ffffff",
          fontFamily: MONO,
          fontSize: compact ? this.fs(7) : this.fs(9),
          fontStyle: "bold",
        })
        .setOrigin(0.5);

      if (order) {
        // A plate icon on the table once the food is up, so the floor shows
        // what the ticket rail says.
        if (order.status === "ready") {
          g.fillStyle(0xfff8e7);
          g.fillCircle(cx + radius * 0.7, cy - radius * 0.7, compact ? 3 : 4);
        }
        if (order.allergy) {
          this.add
            .text(cx, cy - radius - (compact ? 6 : 8), "!", {
              color: "#ffffff",
              backgroundColor: "#c73535",
              fontFamily: MONO,
              fontSize: compact ? this.fs(6) : this.fs(8),
              fontStyle: "bold",
              padding: { x: 3, y: 0 },
            })
            .setOrigin(0.5);
        }
        const index3 = Number((table.id.match(/\d+/) ?? ["0"])[0]);
        if (index3 >= 1 && index3 <= 3 && order.priority !== "high") {
          this.hotspot(
            { x: cx - radius - 4, y: cy - radius - 4, width: radius * 2 + 8, height: radius * 2 + 8 },
            `rush_table_${index3}`,
            `Rush ${table.id.replace("table-", "table ")}`,
          );
        }
      }
    });
  }

  /** The door: who is waiting, and a host stand you can actually see. */
  private drawDoor(g: Phaser.GameObjects.Graphics, layout: RestaurantArenaLayout): void {
    const zone = layout.door;
    const compact = layout.compact;
    const held = Boolean(this.state.seatingHeld);
    const waiting = this.state.waiting ?? [];
    const crowded = waiting.length >= 3 && !held;
    this.zonePanel(g, zone, held ? 0xc9a4a0 : COLORS.door, "DOOR", compact);
    if (held) {
      g.lineStyle(3, COLORS.failed, 0.95);
      g.strokeRoundedRect(zone.x, zone.y, zone.width, zone.height, compact ? 3 : 5);
      this.add.rectangle(zone.x + 2, zone.y + 1, zone.width - 4, 3, COLORS.failed).setOrigin(0, 0).setDepth(5);
    }

    const stand = layout.doorStand;
    const fill = held ? COLORS.failed : crowded ? 0x4a3a2c : 0x5a4636;
    const bg = this.add.rectangle(stand.x, stand.y, stand.width, stand.height, fill).setOrigin(0, 0);
    bg.setStrokeStyle(2, held || crowded ? COLORS.cream : COLORS.ink, held ? 0.95 : 0.55);
    bg.setDepth(6);
    const titleX = stand.x + stand.width / 2 + (held ? 6 : 0);
    if (held) {
      const lockX = stand.x + 10;
      const lockY = stand.y + stand.height / 2;
      const shackle = this.add.circle(lockX, lockY - 5, 3.5, fill, 0).setDepth(7);
      shackle.setStrokeStyle(2, COLORS.cream, 0.95);
      this.add.rectangle(lockX, lockY + 1, 8, 7, COLORS.cream).setOrigin(0.5).setDepth(7);
    }
    const title = held ? "DOOR HELD" : "HOLD DOOR";
    this.add
      .text(titleX, stand.y + (compact ? 6 : 8), title, {
        color: "#fff3d6",
        fontFamily: MONO,
        fontSize: compact ? this.fs(6) : this.fs(8),
        fontStyle: "bold",
      })
      .setOrigin(0.5, 0)
      .setDepth(7);
    this.add
      .text(stand.x + stand.width / 2, stand.y + stand.height - (compact ? 4 : 5), held ? "H to open" : "press H", {
        color: "#f2cc5c",
        fontFamily: MONO,
        fontSize: compact ? this.fs(5) : this.fs(6),
        fontStyle: "bold",
      })
      .setOrigin(0.5, 1)
      .setDepth(7);
    this.hotspot(stand, "hold_seating", held ? "H — open the door and start seating" : "H — stop seating new tables", 8);
    if (crowded) this.tweens.add({ targets: bg, alpha: 0.55, duration: 420, yoyo: true, repeat: -1 });

    const textLeft = stand.x + stand.width + 6;
    if (waiting.length === 0) {
      this.add
        .text(textLeft, zone.y + zone.height / 2 + 2, held ? "Held — nobody waiting" : "Nobody waiting", {
          color: "#3b2b20",
          fontFamily: MONO,
          fontSize: compact ? this.fs(6) : this.fs(8),
        })
        .setOrigin(0, 0.5);
      return;
    }

    const y = zone.y + zone.height * 0.62;
    const cardWidth = compact ? 26 : 34;
    waiting.slice(0, 5).forEach((party, index) => {
      const x = textLeft + index * (cardWidth + 4);
      g.fillStyle(held ? 0xe8d4c4 : 0xfff3d6);
      g.fillRoundedRect(x, y - (compact ? 9 : 11), cardWidth, compact ? 15 : 19, 3);
      this.add
        .text(x + cardWidth / 2, y - (compact ? 3 : 4), `×${party.size}`, {
          color: "#2b2118",
          fontFamily: MONO,
          fontSize: compact ? this.fs(7) : this.fs(9),
          fontStyle: "bold",
        })
        .setOrigin(0.5);
      const barWidth = cardWidth - 6;
      const patience = Math.max(0, Math.min(1, party.patience));
      this.add.rectangle(x + 3, y + (compact ? 3 : 4), barWidth, 3, 0x4a3a2c, 0.7).setOrigin(0, 0.5);
      const barFill = this.add
        .rectangle(x + 3, y + (compact ? 3 : 4), Math.max(1, barWidth * patience), 3, loadColor(1 - patience))
        .setOrigin(0, 0.5);
      if (patience < 0.3) this.tweens.add({ targets: barFill, alpha: 0.3, duration: 380, yoyo: true, repeat: -1 });
    });
  }

  /** Ticket rail: every live order as a card you can click to rush. */
  private drawTickets(g: Phaser.GameObjects.Graphics, layout: RestaurantArenaLayout): void {
    const zone = layout.tickets;
    const compact = layout.compact;
    g.fillStyle(COLORS.panel);
    g.fillRoundedRect(zone.x, zone.y, zone.width, zone.height, 4);
    this.add.text(zone.x + 6, zone.y + 4, "TICKETS", {
      color: "#f2cc5c",
      fontFamily: "Arial Narrow, sans-serif",
      fontSize: compact ? this.fs(7) : this.fs(9),
      fontStyle: "bold",
    });

    const live = this.state.orders.filter((order) => order.status !== "served" && order.status !== "cancelled");
    const top = zone.y + (compact ? 14 : 17);
    const cardHeight = zone.height - (top - zone.y) - 4;

    if (live.length === 0) {
      this.add
        .text(zone.x + zone.width / 2, top + cardHeight / 2, "No tickets", {
          color: "#8d8378",
          fontFamily: MONO,
          fontSize: compact ? this.fs(7) : this.fs(9),
        })
        .setOrigin(0.5);
      return;
    }

    const gap = 4;
    const maxCards = Math.max(1, Math.min(live.length, Math.floor((zone.width - 8) / (compact ? 74 : 92))));
    const cardWidth = (zone.width - 8 - gap * (maxCards - 1)) / maxCards;

    live.slice(0, maxCards).forEach((order, index) => {
      const x = zone.x + 4 + index * (cardWidth + gap);
      const rect = { x, y: top, width: cardWidth, height: cardHeight };
      g.fillStyle(COLORS.ticket);
      g.fillRoundedRect(x, top, cardWidth, cardHeight, 3);
      if (order.priority === "high") {
        g.lineStyle(2, COLORS.alert, 0.9);
        g.strokeRoundedRect(x, top, cardWidth, cardHeight, 3);
      }

      const table = (order.tableId ?? order.id).replace("table-", "T").replace(/order-x?/, "#");
      this.add.text(x + 4, top + 3, table, {
        color: "#2b2118",
        fontFamily: MONO,
        fontSize: compact ? this.fs(8) : this.fs(10),
        fontStyle: "bold",
      });
      this.add
        .text(x + cardWidth - 4, top + 3, order.status.toUpperCase(), {
          color: "#ffffff",
          backgroundColor: hex(STATUS_COLORS[order.status]),
          fontFamily: MONO,
          fontSize: compact ? this.fs(5) : this.fs(6),
          fontStyle: "bold",
          padding: { x: 2, y: 1 },
        })
        .setOrigin(1, 0);
      this.add.text(x + 4, top + (compact ? 15 : 19), order.items.join(" + ") || "—", {
        color: "#4f4136",
        fontFamily: MONO,
        fontSize: compact ? this.fs(6) : this.fs(8),
      });

      if (order.allergy) {
        this.add
          .text(x + 4, top + cardHeight - 3, `${order.allergy.toUpperCase()} ALLERGY`, {
            color: "#ffffff",
            backgroundColor: "#c73535",
            fontFamily: MONO,
            fontSize: compact ? this.fs(5) : this.fs(6),
            fontStyle: "bold",
            padding: { x: 2, y: 1 },
          })
          .setOrigin(0, 1);
      } else if (order.priority === "high") {
        this.add
          .text(x + 4, top + cardHeight - 3, "RUSHED", {
            color: "#ffffff",
            backgroundColor: "#e08b2c",
            fontFamily: MONO,
            fontSize: compact ? this.fs(5) : this.fs(6),
            fontStyle: "bold",
            padding: { x: 2, y: 1 },
          })
          .setOrigin(0, 1);
      }

      const tableIndex = Number((order.tableId?.match(/\d+/) ?? ["0"])[0]);
      if (order.priority !== "high" && tableIndex >= 1 && tableIndex <= 3) {
        this.hotspot(rect, `rush_table_${tableIndex}`, "Rush this ticket");
      } else if (order.allergy) {
        this.hotspot(rect, "prioritize_allergy", "Prioritize allergy ticket");
      }
    });

    if (live.length > maxCards) {
      this.add
        .text(zone.x + zone.width - 5, zone.y + 5, `+${live.length - maxCards}`, {
          color: "#f2cc5c",
          fontFamily: MONO,
          fontSize: compact ? this.fs(6) : this.fs(8),
          fontStyle: "bold",
        })
        .setOrigin(1, 0);
    }
  }

  /**
   * The service log. Watching the staff think is what makes their behaviour
   * legible — and a legible floor is what makes the player's calls informed.
   */
  private drawFeed(g: Phaser.GameObjects.Graphics, layout: RestaurantArenaLayout): void {
    const zone = layout.feed;
    const compact = layout.compact;
    g.fillStyle(COLORS.panel);
    g.fillRoundedRect(zone.x, zone.y, zone.width, zone.height, 4);
    this.add.text(zone.x + 6, zone.y + 4, "EVENT FEED", {
      color: "#f2cc5c",
      fontFamily: "Arial Narrow, sans-serif",
      fontSize: compact ? this.fs(7) : this.fs(9),
      fontStyle: "bold",
    });

    // Keep the narrative spine visible while the activity log scrolls past it.
    // This is deliberately fixed-order UI, not inferred from whichever feed
    // entries happen to be in the tail of a long shift.
    const milestoneTop = zone.y + (compact ? 14 : 18);
    const milestone = this.add.text(zone.x + 6, milestoneTop, milestoneFeedText(), {
      color: "#c9bdae",
      fontFamily: MONO,
      fontSize: compact ? this.fs(5) : this.fs(6),
      fontStyle: "bold",
      wordWrap: { width: zone.width - 12 },
      maxLines: layout.feedBeside ? 2 : 1,
      lineSpacing: compact ? 1 : 2,
    });
    void milestone;

    const entries = this.state.feed ?? [];
    const top = milestoneTop + milestone.height + (compact ? 2 : 4);
    // The side rail is narrow but tall, so entries there get a second line
    // rather than being cut off mid-sentence.
    const bodyLines = layout.feedBeside ? 2 : 1;
    const lineHeight = (compact ? 15 : 18) + (bodyLines - 1) * (compact ? 7 : 9);
    const rows = Math.max(1, Math.floor((zone.height - (top - zone.y) - 2) / lineHeight));
    const shown = entries.slice(-rows);

    if (shown.length === 0) {
      this.add.text(zone.x + 6, top + 2, "Press Play to open.", {
        color: "#8d8378",
        fontFamily: MONO,
        fontSize: compact ? this.fs(7) : this.fs(9),
      });
      return;
    }

    shown.forEach((entry, index) => {
      const y = top + index * lineHeight;
      const color = VOICE_COLORS[entry.voice] ?? "#c9bdae";
      // The player's own calls get a left accent rule and full-strength body
      // text, so "what I decided" separates from "what the staff said" at a
      // glance rather than only by reading the name (#304). The feed is the
      // record of the shift; a manager scanning it back should be able to
      // find their own decisions without parsing every line.
      const mine = entry.voice === "you";
      const textX = zone.x + 6 + (mine ? 4 : 0);
      if (mine) {
        g.fillStyle(0x7ddc9f);
        g.fillRoundedRect(zone.x + 3, y, 2, lineHeight - (compact ? 3 : 4), 1);
      }
      const head = this.add.text(textX, y, `${entry.clock} ${entry.who}`, {
        color,
        fontFamily: MONO,
        fontSize: compact ? this.fs(6) : this.fs(7),
        fontStyle: "bold",
      });
      this.add.text(textX, y + (compact ? 7 : 8), entry.text, {
        color: entry.kind === "thought" ? "#9a8f82" : mine ? "#fff3d6" : "#e8ddcc",
        fontFamily: MONO,
        fontSize: compact ? this.fs(6) : this.fs(8),
        fontStyle: entry.kind === "thought" ? "italic" : "normal",
        wordWrap: { width: zone.width - 12 - (mine ? 4 : 0) },
        maxLines: bodyLines,
      });
      void head;
    });
  }

  // ── Staff avatars ────────────────────────────────────────────────────

  private visualLocation(worker: RestaurantArenaState["workers"][number]): Location {
    // Holding the door plants the host on the stand so the lock is a person,
    // not a chip. A host already dragged into the kitchen stays there.
    if (
      worker.role === "host" &&
      this.state.seatingHeld &&
      (worker.location === "queue" || worker.location === "floor")
    ) {
      return "queue";
    }
    return worker.location;
  }

  private stackedSlot(location: Location, offset: number, layout: RestaurantArenaLayout): { x: number; y: number } {
    const compact = layout.compact;
    const slot = layout.waypoints[location];
    return { x: slot.x + offset * (compact ? 17 : 22), y: slot.y };
  }

  private drawWorkers(layout: RestaurantArenaLayout): void {
    const compact = layout.compact;
    const offsets = new Map<Location, number>();
    const speedReady = Boolean(this.state.sim?.started);
    this.staffTokens.clear();

    for (const worker of this.state.workers) {
      const location = this.visualLocation(worker);
      const offset = offsets.get(location) ?? 0;
      offsets.set(location, offset + 1);
      const slot = this.stackedSlot(location, offset, layout);
      const waypoints = { ...layout.waypoints, [location]: slot };
      let walker = this.walkers.get(worker.role);
      if (!walker) {
        walker = new StaffWalker(location, slot);
        this.walkers.set(worker.role, walker);
      }
      if (!speedReady) walker.snap(slot, location);
      else if (!walker.dragging) walker.setTarget(location, waypoints, layout.spineY);

      const token = this.buildAvatar(walker.x, walker.y, worker.role, worker.load, compact, walker);
      this.staffTokens.set(worker.role, token);
      this.makeWorkerDraggable(token, worker.role, compact ? 8 : 10);
      const heldHost = worker.role === "host" && Boolean(this.state.seatingHeld) && location === "queue";
      const status = heldHost ? "acting" : (this.workerStatuses.get(worker.role) ?? this.workerStatus(worker));
      this.drawWorkerBadge(token, status, compact, heldHost);
      this.drawSpeechBubble(token, worker.role, compact);
    }
  }

  /**
   * The service log tells the same story in a rail nobody has to be
   * looking at — a bubble over the actual person doing the thinking is
   * what makes the floor read as staffed by someone, not just occupied.
   */
  private latestLineFor(role: Role): string | undefined {
    const feed = this.state.feed;
    if (!feed || feed.length === 0) return undefined;
    for (let i = feed.length - 1; i >= Math.max(0, feed.length - 6); i--) {
      const entry = feed[i]!;
      if (entry.voice === role && (entry.kind === "thought" || entry.kind === "action")) return entry.text;
    }
    return undefined;
  }

  private drawSpeechBubble(token: Phaser.GameObjects.Container, role: Role, compact: boolean): void {
    const line = this.latestLineFor(role);
    if (!line) return;
    const trimmed = line.length > 46 ? `${line.slice(0, 44)}…` : line;
    const fontSize = compact ? "6px" : "7px";
    const label = this.add.text(0, 0, trimmed, {
      color: "#2b2118",
      fontFamily: MONO,
      fontSize,
      wordWrap: { width: compact ? 100 : 130 },
      maxLines: 2,
      align: "center",
    });
    const padX = 5;
    const padY = 4;
    const w = label.width + padX * 2;
    const h = label.height + padY * 2;
    const localX = Math.min(Math.max(-w / 2, 4 - token.x), this.cssWidth - w - 4 - token.x);
    const bubbleY = -(compact ? 20 : 26) - h;
    const bg = this.add.rectangle(0, 0, w, h, 0xfff3d6, 0.96).setOrigin(0, 0);
    bg.setStrokeStyle(1, ROLE_COLORS[role], 0.9);
    label.setPosition(padX, padY);
    const tail = this.add.triangle(w / 2 - localX, h + 4, -4, 0, 4, 0, 0, 5, 0xfff3d6).setOrigin(0.5, 0);
    const bubble = this.add.container(localX, bubbleY, [bg, label, tail]);
    bubble.setAlpha(0.97);
    token.add(bubble);
  }

  /**
   * Pixel staff figure shared by floor tokens and the pre-shift roster.
   */
  private avatarFigure(role: Role, unit: number): Phaser.GameObjects.GameObject[] {
    const color = ROLE_COLORS[role];
    const parts: Phaser.GameObjects.GameObject[] = [];

    const shoulderY = unit * 2;
    const shoulderX = unit * 2.9;
    const shoulderR = unit * 1.15;
    for (const side of [-1, 1]) {
      const shoulder = this.add.circle(shoulderX * side, shoulderY, shoulderR, color);
      shoulder.setStrokeStyle(1, 0x2b2118, 0.6);
      parts.push(shoulder);
    }

    const bodyW = unit * 5;
    const bodyH = unit * 5;
    const body = this.add.graphics();
    body.fillStyle(color, 1);
    body.fillRoundedRect(-bodyW / 2, unit * 1.5 - bodyH / 2, bodyW, bodyH, unit * 1.5);
    body.lineStyle(1, 0x2b2118, 0.75);
    body.strokeRoundedRect(-bodyW / 2, unit * 1.5 - bodyH / 2, bodyW, bodyH, unit * 1.5);
    parts.push(body);
    if (role === "chef" || role === "supply_lead" || role === "expediter") {
      parts.push(this.add.rectangle(0, unit * 2.6, unit * 3, unit * 2.6, 0xfff3d6, 0.92).setOrigin(0.5));
    }
    if (role === "host") {
      // Bun behind the crown so the face is not painted over.
      const bun = this.add.circle(0, -unit * 4.5, unit * 1.55, 0x4a3040);
      bun.setStrokeStyle(1, 0x2b2118, 0.6);
      parts.push(bun);
    }
    const head = this.add.circle(0, -unit * 2.2, unit * 2.3, 0xf6d5b0);
    head.setStrokeStyle(1, 0x2b2118, 0.6);
    parts.push(head);
    if (role === "chef") {
      parts.push(this.add.rectangle(0, -unit * 3.9, unit * 4, unit * 1.1, 0xfffdf6).setOrigin(0.5));
      parts.push(this.add.circle(0, -unit * 5, unit * 2, 0xfffdf6));
    } else if (role === "host") {
      parts.push(this.add.rectangle(0, -unit * 3.7, unit * 4.2, unit * 1.2, 0x4a3040).setOrigin(0.5));
      parts.push(this.add.rectangle(0, unit * 0.4, unit * 1.1, unit * 1.1, 0xf2cc5c).setOrigin(0.5).setAngle(45));
    } else if (role === "server") {
      parts.push(this.add.rectangle(0, unit * 0.4, unit * 1.6, unit * 1.1, color).setOrigin(0.5));
    } else {
      parts.push(this.add.rectangle(0, -unit * 4, unit * 4.4, unit * 1.3, color).setOrigin(0.5));
    }
    parts.push(this.add.rectangle(-unit * 0.8, -unit * 2.2, unit * 0.6, unit * 0.8, 0x2b2118).setOrigin(0.5));
    parts.push(this.add.rectangle(unit * 0.8, -unit * 2.2, unit * 0.6, unit * 0.8, 0x2b2118).setOrigin(0.5));
    return parts;
  }

  private buildRosterAvatar(x: number, y: number, role: Role, compact: boolean): Phaser.GameObjects.Container {
    const unit = compact ? 1.8 : 2.15;
    const token = this.add.container(x, y, this.avatarFigure(role, unit));
    token.setDepth(62);
    return token;
  }

  /**
   * A little pixel-ish cook rather than a coloured dot: the floor has to
   * read as a room with people in it.
   */
  private buildAvatar(
    x: number,
    y: number,
    role: Role,
    load: number,
    compact: boolean,
    walker: StaffWalker,
  ): Phaser.GameObjects.Container {
    const unit = compact ? 2 : 2.6;
    const figureParts = this.avatarFigure(role, unit);
    const clamped = Math.min(1, Math.max(0, load));
    if (clamped > 0.5) {
      const plate = this.add.ellipse(unit * 3.2, unit * 2.4, unit * 2.4, unit * 1.1, 0xfff8e7);
      plate.setStrokeStyle(1, 0x2b2118, 0.7);
      plate.setName("carry");
      figureParts.push(plate);
    }
    const figure = this.add.container(0, 0, figureParts);
    figure.setName("figure");
    figure.setScale(walker.facing, walker.walking ? 1.02 : 1);
    const parts: Phaser.GameObjects.GameObject[] = [figure];
    const staff = this.staff(role);
    const nameTag = this.add
      .text(0, unit * 4.6, staff.name, {
        color: "#2b2118",
        backgroundColor: "#fff3d6",
        fontFamily: MONO,
        fontSize: compact ? this.fs(5) : this.fs(7),
        fontStyle: "bold",
        padding: { x: 2, y: 1 },
      })
      .setOrigin(0.5, 0);
    parts.push(nameTag);

    const barWidth = unit * 6;
    parts.push(this.add.rectangle(-barWidth / 2, -unit * 6.4, barWidth, 2.5, 0x241b14, 0.9).setOrigin(0, 0.5));
    const fill = this.add
      .rectangle(-barWidth / 2, -unit * 6.4, Math.max(1, barWidth * clamped), 2.5, loadColor(clamped))
      .setOrigin(0, 0.5);
    parts.push(fill);

    const token = this.add.container(x, y, parts);
    token.setDepth(20);
    if (clamped > 0.8) this.tweens.add({ targets: fill, alpha: 0.3, duration: 380, yoyo: true, repeat: -1 });
    if (this.running && !walker.walking) this.startIdleBob(token, y, role);
    return token;
  }

  private workerStatus(worker: RestaurantArenaState["workers"][number]): RestaurantArenaWorkerStatus {
    if (this.state.emergency?.active) return "error";
    return worker.load > 0.8 ? "acting" : worker.load > 0.5 ? "thinking" : "idle";
  }

  private drawWorkerBadge(
    token: Phaser.GameObjects.Container,
    status: RestaurantArenaWorkerStatus,
    compact: boolean,
    holdingDoor = false,
  ): void {
    const labels: Record<RestaurantArenaWorkerStatus, string> = {
      idle: "READY",
      thinking: "THINKING…",
      acting: holdingDoor ? "HOLDING" : "ON IT",
      error: "HELP!",
    };
    const colors: Record<RestaurantArenaWorkerStatus, number> = {
      idle: COLORS.working,
      thinking: COLORS.pass,
      acting: holdingDoor ? COLORS.failed : COLORS.door,
      error: COLORS.alert,
    };
    const badgeY = compact ? -17 : -23;
    const badge = this.add.text(0, badgeY, labels[status], {
      color: status === "thinking" ? "#2b2118" : "#ffffff",
      backgroundColor: `#${colors[status].toString(16).padStart(6, "0")}`,
      fontFamily: MONO,
      fontSize: compact ? this.fs(5) : this.fs(6),
      fontStyle: "bold",
      padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1);
    token.add(badge);
    if (status === "thinking" || status === "acting" || status === "error") {
      this.tweens.add({
        targets: badge,
        y: badgeY - 2,
        alpha: 0.55,
        duration: status === "error" ? 260 : 500,
        yoyo: true,
        repeat: -1,
      });
    }
  }

  setWorkerStatus(role: Role, status: RestaurantArenaWorkerStatus): void {
    this.workerStatuses.set(role, status);
    if (this.sys.isActive() && !this.gate.isDragging) this.paint();
  }

  /** Pick a worker up and drop them in another zone to change what they do. */
  private makeWorkerDraggable(token: Phaser.GameObjects.Container, role: Role, radius: number): void {
    let home = { x: token.x, y: token.y };
    token.setSize(radius * 2 + 8, radius * 3);
    token.setInteractive({ useHandCursor: true, draggable: true });
    this.input.setDraggable(token);

    const staff = this.staff(role);
    token.on("pointerover", () => {
      if (!this.gate.isDragging) {
        this.showTip(
          { x: token.x - 40, y: token.y - radius * 2, width: 80, height: 10 },
          `${staff.name} — drag to move`,
        );
      }
    });
    token.on("pointerout", () => this.hideTip());

    token.on("dragstart", () => {
      home = { x: token.x, y: token.y };
      this.gate.beginDrag();
      const walker = this.walkers.get(role);
      if (walker) walker.dragging = true;
      this.hideTip();
      this.tweens.killTweensOf(token);
      token.setDepth(50);
      token.setScale(1.15);
      this.showDropHints(true);
    });
    token.on("drag", (_pointer: Phaser.Input.Pointer, dragX: number, dragY: number) => {
      token.setPosition(dragX, dragY);
      const walker = this.walkers.get(role);
      if (walker) {
        walker.x = dragX;
        walker.y = dragY;
      }
    });
    token.on("dragend", (pointer: Phaser.Input.Pointer) => {
      const owed = this.gate.endDrag();
      const walker = this.walkers.get(role);
      if (walker) walker.dragging = false;
      token.setScale(1);
      this.showDropHints(false);
      const target = this.zoneAt(pointer.x, pointer.y);
      if (target) {
        if (walker) walker.node = target;
        this.onAction(`assign_${role}_${target}`);
      } else if (walker) {
        token.setPosition(home.x, home.y);
        walker.snap({ x: home.x, y: home.y }, walker.node);
      } else {
        token.setPosition(home.x, home.y);
      }
      if (owed || target) this.paint();
    });
  }

  /** Which staffing zone a point falls in, if any. */
  private zoneAt(x: number, y: number): Location | undefined {
    const layout = this.layout;
    if (!layout) return undefined;
    const zones: Array<[Location, ArenaRect]> = [
      ["kitchen", layout.kitchen],
      ["pass", layout.pass],
      ["floor", layout.dining],
      ["queue", layout.door],
    ];
    for (const [location, rect] of zones) {
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return location;
    }
    return undefined;
  }

  private showDropHints(visible: boolean): void {
    const layout = this.layout;
    if (!layout) return;
    if (visible && this.dropHints.length === 0) {
      for (const rect of [layout.kitchen, layout.pass, layout.dining, layout.door]) {
        const hint = this.add.rectangle(rect.x, rect.y, rect.width, rect.height).setOrigin(0, 0);
        hint.setStrokeStyle(2, COLORS.pass, 0.95);
        hint.setDepth(40);
        this.dropHints.push(hint);
      }
      return;
    }
    if (!visible) {
      for (const hint of this.dropHints) hint.destroy();
      this.dropHints = [];
    }
  }

  /** Full-width alert while an incident is live. */
  private drawIncidentBanner(layout: RestaurantArenaLayout): void {
    if (!this.state.emergency?.active || this.state.decision) return;
    const compact = layout.compact;
    const width = layout.dining.x + layout.dining.width - layout.kitchen.x;
    const height = compact ? 15 : 19;
    const x = layout.kitchen.x;
    const y = layout.kitchen.y + layout.kitchen.height * 0.5;

    const banner = this.add.rectangle(x, y, width, height, COLORS.alert).setOrigin(0, 0.5).setDepth(30);
    banner.setStrokeStyle(1, 0xffffff, 0.8);
    const label = this.add
      .text(x + width / 2, y, `${this.state.emergency.kind.replace(/_/g, " ").toUpperCase()} — CLICK THE OVEN`, {
        color: "#ffffff",
        fontFamily: MONO,
        fontSize: compact ? this.fs(7) : this.fs(9),
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setDepth(31);
    this.tweens.add({ targets: [banner, label], alpha: 0.45, duration: 520, yoyo: true, repeat: -1 });
  }

  /**
   * A brief callout for what a decision just changed — dead centre, right
   * where the decision card itself was, since that's where the player's
   * eyes already are the instant they click an option. The service log
   * still gets the flavour line; this is the one-line receipt so the
   * consequence doesn't require scrolling to find.
   *
   * Every `paint()` redraws this from scratch like everything else, so the
   * fade can't be a single tween that outlives one repaint — instead this
   * recomputes the correct in-flight alpha from elapsed wall-clock time on
   * every call (right even if a tick landed mid-fade) and hands off to one
   * tween per paint for the remaining motion.
   */
  private drawOutcomeToast(width: number, height: number): void {
    const toast = this.outcomeToast;
    if (!toast) return;
    const elapsed = Date.now() - toast.startedAt;
    if (elapsed >= this.outcomeToastMs) {
      this.outcomeToast = undefined;
      return;
    }
    const compact = this.layout?.compact ?? false;
    const tone = toast.tone === "safe" ? 0x2f5c46 : toast.tone === "risky" ? 0x6b2f2b : 0x40342a;

    const label = this.add.text(0, 0, toast.headline, {
      color: "#fff3d6",
      fontFamily: MONO,
      fontSize: compact ? this.fs(8) : this.fs(10),
      fontStyle: "bold",
    });
    const padX = compact ? 10 : 14;
    const padY = compact ? 6 : 8;
    const boxWidth = label.width + padX * 2;
    const boxHeight = label.height + padY * 2;
    const x = (width - boxWidth) / 2;
    const y = height * 0.34 - boxHeight / 2;

    const bg = this.add.rectangle(0, 0, boxWidth, boxHeight, tone).setOrigin(0, 0);
    bg.setStrokeStyle(2, COLORS.pass, 0.9);
    label.setPosition(padX, padY);
    const toastBox = this.add.container(x, y, [bg, label]).setDepth(45);

    const fadeInMs = 180;
    if (elapsed < fadeInMs) {
      toastBox.setAlpha(elapsed / fadeInMs);
      this.tweens.add({ targets: toastBox, alpha: 1, duration: fadeInMs - elapsed });
    }
    const remaining = this.outcomeToastMs - elapsed;
    const fadeOutMs = Math.min(400, remaining);
    this.tweens.add({ targets: toastBox, alpha: 0, delay: Math.max(0, remaining - fadeOutMs), duration: fadeOutMs });
  }

  // ── Modal cards ──────────────────────────────────────────────────────

  private scrim(width: number, height: number): void {
    this.add.rectangle(0, 0, width, height, 0x120d09, 0.82).setOrigin(0, 0).setDepth(60).setInteractive();
  }

  /**
   * Pre-shift card: the only screen a first-time player gets before the
   * clock starts running for real. Sized to its content so the crew rows
   * stay tight instead of stretching to fill the window.
   */
  private drawPreShift(layout: RestaurantArenaLayout, width: number, height: number): void {
    const compact = layout.compact;
    this.scrim(width, height);

    const roles: Role[] = ["host", "supply_lead", "chef", "server"];
    const cardWidth = Math.min(width - 24, 420);
    const pad = compact ? 14 : 18;
    const innerWidth = cardWidth - pad * 2;
    const titleSize = compact ? 18 : 22;
    const labelSize = compact ? 8 : 10;
    const bodySize = compact ? 9 : 11;
    const nameSize = compact ? 10 : 12;
    const titleH = compact ? 24 : 28;
    const labelH = compact ? 14 : 16;
    const goalH = compact ? 26 : 30;
    const rowH = compact ? 30 : 34;
    const buttonH = compact ? 30 : 34;
    const sectionGap = compact ? 10 : 12;
    const cardHeight =
      pad +
      titleH +
      sectionGap +
      labelH +
      goalH +
      sectionGap +
      labelH +
      rowH * roles.length +
      sectionGap +
      buttonH +
      pad;
    const x = (width - cardWidth) / 2;
    const y = (height - cardHeight) / 2;
    const left = x + pad;

    const card = this.add.rectangle(x, y, cardWidth, cardHeight, 0x2f241a).setOrigin(0, 0).setDepth(61);
    card.setStrokeStyle(2, COLORS.pass, 0.9);

    let cursor = y + pad;

    this.add
      .text(left, cursor, "THE LITTLE PLATE", {
        color: "#fff3d6",
        fontFamily: DISPLAY,
        fontSize: this.fs(titleSize),
        fontStyle: "bold",
      })
      .setOrigin(0, 0)
      .setDepth(62);
    cursor += titleH + sectionGap;

    this.add
      .text(left, cursor, "OBJECTIVES", {
        color: "#a99b8a",
        fontFamily: MONO,
        fontSize: this.fs(labelSize),
        fontStyle: "bold",
      })
      .setOrigin(0, 0)
      .setDepth(62);
    cursor += labelH;

    const goal = this.state.goal;
    const goalText = goal
      ? `$${goal.cash}  ·  verify every plate  ·  ${goal.maxWalkouts} walkouts max`
      : "dinner service  ·  24 min  ·  4 staff";
    this.add.rectangle(left, cursor, innerWidth, goalH, COLORS.pass).setOrigin(0, 0).setDepth(62);
    this.add
      .text(left + 10, cursor + goalH / 2, goalText, {
        color: "#2b2118",
        fontFamily: MONO,
        fontSize: this.fs(bodySize),
        fontStyle: "bold",
      })
      .setOrigin(0, 0.5)
      .setDepth(63);
    cursor += goalH + sectionGap;

    this.add
      .text(left, cursor, "CREW", {
        color: "#a99b8a",
        fontFamily: MONO,
        fontSize: this.fs(labelSize),
        fontStyle: "bold",
      })
      .setOrigin(0, 0)
      .setDepth(62);
    cursor += labelH;

    const avatarX = left + (compact ? 10 : 12);
    const textX = left + (compact ? 24 : 26);
    roles.forEach((role, index) => {
      const rowY = cursor + index * rowH;
      const staff = this.staff(role);
      this.buildRosterAvatar(avatarX, rowY + rowH / 2, role, compact);
      this.add
        .text(textX, rowY + (compact ? 4 : 5), `${staff.name} · ${staff.title}`, {
          color: "#fff3d6",
          fontFamily: MONO,
          fontSize: this.fs(nameSize),
          fontStyle: "bold",
        })
        .setDepth(62);
      if (staff.trait) {
        this.add
          .text(textX, rowY + (compact ? 16 : 18), staff.trait, {
            color: "#8d8378",
            fontFamily: MONO,
            fontSize: this.fs(bodySize),
          })
          .setDepth(62);
      }
    });
    cursor += rowH * roles.length + sectionGap;

    this.button(
      { x: left, y: cursor, width: innerWidth, height: buttonH },
      "OPEN THE DOORS",
      "sim_start",
      { fill: 0x3d9b6d, size: compact ? 10 : 12, depth: 62 },
    );
  }

  /**
   * The decision card. This is the game: the clock is stopped, someone is
   * asking, and every option states its price.
   */
  private drawDecision(layout: RestaurantArenaLayout, width: number, height: number): void {
    const decision = this.state.decision;
    if (!decision) return;
    const compact = layout.compact;
    this.scrim(width, height);

    const cardWidth = Math.min(width - 24, 400);
    const optionHeight = compact ? 48 : 56;
    const headerHeight = compact ? 92 : 108;
    const cardHeight = Math.min(height - 24, headerHeight + decision.options.length * (optionHeight + 6) + 12);
    const x = (width - cardWidth) / 2;
    const y = (height - cardHeight) / 2;

    const card = this.add.rectangle(x, y, cardWidth, cardHeight, 0x2f241a).setOrigin(0, 0).setDepth(61);
    card.setStrokeStyle(2, COLORS.pass, 0.95);

    const dot = this.add.circle(x + 18, y + 20, compact ? 8 : 10, ROLE_COLORS[decision.speakerRole]).setDepth(62);
    dot.setStrokeStyle(2, 0xffffff, 0.9);
    this.add
      .text(x + 34, y + 10, decision.title, {
        color: "#f2cc5c",
        fontFamily: SANS,
        fontSize: compact ? this.fs(12) : this.fs(15),
        fontStyle: "bold",
        wordWrap: { width: cardWidth - 52 },
        maxLines: 2,
      })
      .setDepth(62);
    this.add
      .text(x + 34, y + (compact ? 28 : 32), `${decision.speaker} needs a call`, {
        color: "#cbbca9",
        fontFamily: SANS,
        fontSize: compact ? this.fs(9) : this.fs(11),
      })
      .setDepth(62);
    this.add
      .text(x + 14, y + (compact ? 46 : 52), `“${decision.prompt}”`, {
        color: "#fff8e7",
        fontFamily: DISPLAY,
        fontSize: compact ? this.fs(11) : this.fs(13),
        fontStyle: "italic",
        wordWrap: { width: cardWidth - 28 },
        lineSpacing: 4,
        maxLines: 3,
      })
      .setDepth(62);

    decision.options.forEach((option, index) => {
      const oy = y + headerHeight + index * (optionHeight + 6);
      const rect = { x: x + 10, y: oy, width: cardWidth - 20, height: optionHeight };
      const tone =
        option.tone === "safe" ? 0x2f5c46 : option.tone === "risky" ? 0x6b2f2b : 0x40342a;
      const bg = this.add.rectangle(rect.x, rect.y, rect.width, rect.height, tone).setOrigin(0, 0).setDepth(62);
      bg.setStrokeStyle(1, COLORS.cream, 0.35);
      this.add
        .text(rect.x + 10, rect.y + 7, option.label, {
          color: "#fff8e7",
          fontFamily: SANS,
          fontSize: compact ? this.fs(11) : this.fs(13),
          fontStyle: "bold",
        })
        .setDepth(63);
      this.add
        .text(rect.x + 10, rect.y + (compact ? 24 : 28), option.detail, {
          color: "#e2d4c0",
          fontFamily: SANS,
          fontSize: compact ? this.fs(9) : this.fs(10),
          wordWrap: { width: rect.width - 20 },
          lineSpacing: 2,
          maxLines: 2,
        })
        .setDepth(63);

      const zone = this.hotspot(rect, `decide_${decision.id}_${option.id}`, undefined, 64);
      zone.on("pointerover", () => bg.setFillStyle(Phaser.Display.Color.ValueToColor(tone).lighten(22).color));
      zone.on("pointerout", () => bg.setFillStyle(tone));
    });
  }

  /**
   * The manager brief. Everything above the floor used to be transport
   * controls and a money figure; a first-time player had to infer tonight's
   * target from a "/190" suffix and infer the next move from nothing at all.
   * This band tracks the three conditions that can lose the night, names the
   * one thing to do now, and keeps the last decision's receipt on screen
   * after its toast has faded (#304).
   *
   * Kept quiet on purpose. Only a condition in trouble gets colour — a band
   * of green chips reads as urgent when nothing is wrong, and then has no
   * louder register left for when something is. Same reason the tag does not
   * pulse for an open decision: the card is already modal and the top bar
   * already flashes NEEDS A CALL, so a third alarm only adds noise.
   *
   * The content is computed by `arenaBrief`, which is pure and tested; this
   * only lays it out. The training coach feeds the same "now" line rather
   * than getting a banner of its own, so there is exactly one place on
   * screen that answers "what do I do".
   */
  private drawBrief(g: Phaser.GameObjects.Graphics, layout: RestaurantArenaLayout): void {
    const zone = layout.brief;
    const compact = layout.compact;
    const brief = arenaBrief(this.state);

    g.fillStyle(COLORS.panel);
    g.fillRoundedRect(zone.x, zone.y, zone.width, zone.height, 4);

    const pad = compact ? 5 : 7;
    const rowOne = zone.y + (compact ? 3 : 4);

    // Row one: the tally, right-aligned, with the receipt for the last call
    // sitting quietly on the left of it.
    const chipColors: Record<"ok" | "warn" | "bad", { bg: string; fg: string }> = {
      ok: { bg: "#3a2e24", fg: "#a99b8a" },
      warn: { bg: "#6b5124", fg: "#f7e2b4" },
      bad: { bg: "#7a2b26", fg: "#ffdcd6" },
    };
    let chipRight = zone.x + zone.width - pad;
    for (const chip of [...brief.chips].reverse()) {
      const colors = chipColors[chip.tone];
      const text = this.add
        .text(chipRight, rowOne, `${chip.label} ${chip.value}`, {
          color: colors.fg,
          backgroundColor: colors.bg,
          fontFamily: MONO,
          fontSize: compact ? this.fs(6) : this.fs(7),
          fontStyle: "bold",
          padding: { x: 3, y: 1 },
        })
        .setOrigin(1, 0);
      chipRight -= text.width + 4;
      if (chipRight < zone.x + pad) text.destroy();
    }

    if (brief.last) {
      const room = chipRight - (zone.x + pad) - 6;
      if (room > 60) {
        this.add.text(zone.x + pad, rowOne + 1, `Last: ${brief.last}`, {
          color: "#7f8f83",
          fontFamily: MONO,
          fontSize: compact ? this.fs(6) : this.fs(7),
          wordWrap: { width: room },
          maxLines: 1,
        });
      }
    }

    // Row two: the single next move, across the full width, tagged so the
    // kind of problem reads before the sentence does.
    const rowTwo = zone.y + (compact ? 13 : 17);
    const tag = this.add
      .text(zone.x + pad, rowTwo, brief.nowLabel, {
        color: "#2b2118",
        backgroundColor: "#f2cc5c",
        fontFamily: MONO,
        fontSize: compact ? this.fs(6) : this.fs(7),
        fontStyle: "bold",
        padding: { x: 3, y: 1 },
      })
      .setOrigin(0, 0);

    const nowX = zone.x + pad + tag.width + 5;
    this.add.text(nowX, rowTwo + 1, brief.now, {
      color: "#fff3d6",
      fontFamily: MONO,
      fontSize: compact ? this.fs(6) : this.fs(8),
      wordWrap: { width: Math.max(40, zone.x + zone.width - pad - nowX) },
      maxLines: compact ? 2 : 1,
    });
  }

}

export interface RestaurantArenaSceneHandle {
  render(state: RestaurantArenaState): void;
  setWorkerStatus(role: Role, status: RestaurantArenaWorkerStatus): void;
  destroy(): void;
}

export function mountRestaurantArenaScene(
  parent: HTMLElement,
  state: RestaurantArenaState,
  onAction: (action: string) => void = () => {},
  onUi: (action: "menu" | "restart" | "help") => void = () => {},
): RestaurantArenaSceneHandle {
  // Calling `game.scale.resize()` on a live game — at any point after
  // construction, however long after, `Core.Events.READY` or not — reliably
  // corrupts a framebuffer ("Framebuffer status: Incomplete Attachment") and
  // leaves the canvas permanently blank in this renderer. So a genuine
  // resize never calls `.resize()` on an existing game: it tears the game
  // down and boots a fresh one at the new size instead — cheap, since this
  // scene already repaints itself from scratch on every state change.
  //
  // `width`/`height` passed to `boot()` below are CSS pixels; `bootedWidth`/
  // `bootedHeight` (compared against `parent`'s real box everywhere else in
  // this function) track those CSS-pixel values. The `Phaser.Game` config
  // gets them multiplied by `DPR` instead, so the backing store is the
  // supersampled size `RestaurantArenaScene.dpr`'s camera zoom expects — see
  // that field's comment for what goes wrong when this multiplier and the
  // scene's own `dpr` disagree.
  let game: Phaser.Game | undefined;
  let scene: RestaurantArenaScene | undefined;
  let destroyed = false;
  let currentState = state;
  let bootedWidth = 0;
  let bootedHeight = 0;
  let persistedToastState: OutcomeToastState | undefined;

  const teardown = () => {
    if (scene) {
      persistedToastState = scene.getOutcomeToastState();
    }
    game?.destroy(true);
    game = undefined;
    scene = undefined;
  };

  const boot = (width: number, height: number) => {
    if (destroyed) return;
    if (game) return;
    bootedWidth = width;
    bootedHeight = height;
    scene = new RestaurantArenaScene(currentState, onAction, onUi, persistedToastState);
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      width: Math.round(width * DPR),
      height: Math.round(height * DPR),
      backgroundColor: COLORS.ink,
      scene,
      // NONE, not RESIZE: this game is never resized in place (see the
      // teardown-and-reboot comment above) — Phaser doesn't need to watch
      // for size changes of its own.
      scale: { mode: Phaser.Scale.NONE },
    });
    scheduleVerification();
  };

  const reboot = (width: number, height: number) => {
    if (destroyed || !parent.isConnected) return;
    if (width <= 0 || height <= 0) return;
    if (game && width === bootedWidth && height === bootedHeight) return;
    teardown();
    boot(width, height);
  };

  /**
   * A cold start (a just-restarted dev server, a slow initial layout pass
   * on a big window) can settle to its *true* box later than either the
   * boot-time measurement below or this module's own `ResizeObserver`
   * happened to catch — both can agree on the same too-small intermediate
   * reading and never see a further "resize" to correct it from, since
   * nothing about `parent` actually changes again afterward from the
   * browser's point of view. A few delayed re-checks against the real box,
   * independent of any resize *event*, catch that without needing one.
   */
  const scheduleVerification = () => {
    for (const delay of [300, 1000, 3000]) {
      setTimeout(() => {
        if (destroyed || !parent.isConnected) return;
        const rect = parent.getBoundingClientRect();
        reboot(Math.round(rect.width), Math.round(rect.height));
      }, delay);
    }
  };

  // `getBoundingClientRect()` called the instant we're handed `parent` can
  // still read stale/zero — the caller may have just set `innerHTML` and
  // not yet given the browser a layout pass. ResizeObserver is the primary
  // boot path; rAF polling is a backup for browsers where the first RO
  // callback still arrives before layout settles.
  let attempts = 0;
  const tryBoot = () => {
    if (destroyed || game) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width > 64 && rect.height > 64) {
      boot(Math.round(rect.width), Math.round(rect.height));
      return;
    }
    attempts += 1;
    if (attempts < 30) {
      requestAnimationFrame(tryBoot);
    }
  };

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const observer =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver((entries) => {
          const rect = entries[0]?.contentRect;
          if (!rect || rect.width <= 0 || rect.height <= 0) return;
          const width = Math.round(rect.width);
          const height = Math.round(rect.height);
          if (!game) {
            boot(width, height);
            return;
          }
          if (width === bootedWidth && height === bootedHeight) return;
          if (resizeTimer !== undefined) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = undefined;
            reboot(width, height);
          }, 150);
        })
      : undefined;
  observer?.observe(parent);
  requestAnimationFrame(tryBoot);

  return {
    render: (next) => {
      currentState = next;
      scene?.setState(next);
      if (scene) {
        persistedToastState = scene.getOutcomeToastState();
      }
    },
    setWorkerStatus: (role, status) => scene?.setWorkerStatus(role, status),
    destroy: () => {
      destroyed = true;
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      observer?.disconnect();
      teardown();
    },
  };
}
ARENA_EOF_MARKER

