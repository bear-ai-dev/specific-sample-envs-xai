import fs from "fs";

const path = "/app/overlay/restaurant-arena-scene.ts";
let s = fs.readFileSync(path, "utf8");

function replaceOnce(from, to, label) {
  const count = s.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`Expected exactly 1 occurrence for [${label}], found ${count}`);
  }
  s = s.replace(from, to);
}

// T1: imports
replaceOnce(
`import Phaser from "phaser";
import { restaurantArenaLayout, type ArenaRect, type RestaurantArenaLayout } from "./restaurant-arena-layout.js";
import { StaffWalker } from "./staff-walk.js";
import { RepaintGate } from "./restaurant-arena-repaint-gate.js";
import { milestoneFeedText } from "./restaurant-arena-milestones.js";`,
`import Phaser from "phaser";
import { milestoneFeedText } from "./restaurant-arena-milestones.js";`,
"imports"
);

// T2: insert local geometry types + layout builder before COLORS const
const colorsMarker = "const COLORS = {\n";
if (s.split(colorsMarker).length - 1 !== 1) throw new Error("COLORS marker not unique");
const layoutBlock = `type ArenaRect = { x: number; y: number; width: number; height: number };

interface RestaurantArenaLayout {
  compact: boolean;
  feedBeside: boolean;
  topBar: ArenaRect;
  brief: ArenaRect;
  kitchen: ArenaRect;
  pass: ArenaRect;
  dining: ArenaRect;
  door: ArenaRect;
  doorStand: ArenaRect;
  waypoints: Record<Location, { x: number; y: number }>;
  tickets: ArenaRect;
  feed: ArenaRect;
}

function restaurantArenaLayout(width: number, height: number): RestaurantArenaLayout {
  const w = Math.max(320, width);
  const h = Math.max(240, height);
  const compact = false;
  const gap = 6;
  const margin = 8;

  const topBarHeight = 38;
  const briefHeight = 32;
  const ticketsHeight = 72;
  const feedBeside = false;
  const feedHeight = Math.max(110, Math.round(h * 0.2));

  const bodyX = margin;
  const briefY = margin + topBarHeight + gap;
  const bodyY = briefY + briefHeight + gap;
  const bodyWidth = w - margin * 2;
  const bodyBottom = h - margin - (feedHeight + gap);
  const bodyHeight = Math.max(120, bodyBottom - bodyY);

  const floorHeight = Math.max(90, bodyHeight - ticketsHeight - gap);

  const kitchenWidth = Math.round(bodyWidth * 0.25);
  const passWidth = Math.max(24, Math.round(bodyWidth * 0.07));
  const diningX = bodyX + kitchenWidth + gap + passWidth + gap;
  const diningWidth = Math.max(80, bodyX + bodyWidth - diningX);
  const doorHeight = Math.max(56, Math.round(floorHeight * 0.32));
  const diningHeight = floorHeight - doorHeight - gap;

  const kitchen = { x: bodyX, y: bodyY, width: kitchenWidth, height: floorHeight };
  const pass = { x: bodyX + kitchenWidth + gap, y: bodyY, width: passWidth, height: floorHeight };
  const dining = { x: diningX, y: bodyY, width: diningWidth, height: diningHeight };
  const door = { x: diningX, y: bodyY + diningHeight + gap, width: diningWidth, height: doorHeight };
  const labelH = 14;
  const hostGutter = 40;
  const standWidth = Math.min(90, Math.max(56, Math.round(door.width * 0.36)));
  const standHeight = Math.min(36, Math.max(22, door.height - labelH - 4));
  const doorStand = {
    x: door.x + hostGutter,
    y: door.y + labelH,
    width: standWidth,
    height: standHeight,
  };
  const waypoints: Record<Location, { x: number; y: number }> = {
    kitchen: { x: kitchen.x + kitchen.width / 2, y: kitchen.y + kitchen.height / 2 },
    pass: { x: pass.x + pass.width / 2, y: pass.y + pass.height / 2 },
    floor: { x: dining.x + dining.width / 2, y: dining.y + dining.height / 2 },
    queue: { x: door.x + door.width / 2, y: door.y + door.height / 2 },
  };

  return {
    compact,
    feedBeside,
    topBar: { x: margin, y: margin, width: w - margin * 2, height: topBarHeight },
    brief: { x: margin, y: briefY, width: w - margin * 2, height: briefHeight },
    kitchen,
    pass,
    dining,
    door,
    doorStand,
    waypoints,
    tickets: { x: bodyX, y: bodyY + floorHeight + gap, width: bodyWidth, height: ticketsHeight },
    feed: { x: margin, y: bodyBottom + gap, width: w - margin * 2, height: feedHeight },
  };
}

`;
s = s.replace(colorsMarker, layoutBlock + colorsMarker);

// T4a: remove gate/layout/dropHints fields
replaceOnce(
`  /** A repaint mid-drag would delete the token under the pointer. */
  private readonly gate = new RepaintGate();
  private layout?: RestaurantArenaLayout;
  private dropHints: Phaser.GameObjects.Rectangle[] = [];
  /** Which \`state.lastOutcome.id\` has already been shown, so a re-render mid-fade doesn't restart it. */
  private shownOutcomeId?: string;`,
`  /** Which \`state.lastOutcome.id\` has already been shown, so a re-render mid-fade doesn't restart it. */
  private shownOutcomeId?: string;`,
"gate/layout/dropHints fields"
);

// T4b: remove walkers/walkClock fields
replaceOnce(
`  private workerStatuses = new Map<Role, RestaurantArenaWorkerStatus>();
  /** Pixel walkers survive paints; the sim still only stores a zone name. */
  private readonly walkers = new Map<Role, StaffWalker>();
  private readonly staffTokens = new Map<Role, Phaser.GameObjects.Container>();
  private walkClock = 0;`,
`  private workerStatuses = new Map<Role, RestaurantArenaWorkerStatus>();
  private readonly staffTokens = new Map<Role, Phaser.GameObjects.Container>();`,
"walkers/walkClock fields"
);

// T5: fs()
replaceOnce(
`  /**
   * Every text size in this scene was tuned against the 520x740 design
   * width, in two fixed tiers (compact/normal). Without this, a bigger
   * window just spreads those same tiny fixed sizes over more canvas — the
   * text gets no easier to read, only further apart. \`layout.scale\` carries
   * how far the window has grown past that baseline; this rounds a design
   * size into the actual pixel string Phaser wants.
   */
  private fs(px: number): string {
    return \`\${Math.round(px * (this.layout?.scale ?? 1))}px\`;
  }`,
`  /** Rounds a design size into the pixel string Phaser wants. */
  private fs(px: number): string {
    return \`\${px}px\`;
  }`,
"fs()"
);

// T6: hotspot pointer handlers
replaceOnce(
`    zone.on("pointerover", () => {
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
    });`,
`    zone.on("pointerover", () => {
      halo.setVisible(true);
    });
    zone.on("pointerout", () => {
      halo.setVisible(false);
    });
    zone.on("pointerdown", () => {
      (dispatch ?? this.onAction)(action);
    });`,
"hotspot handlers"
);

// T7: remove tip field + showTip/hideTip methods
replaceOnce(
`  private tip?: Phaser.GameObjects.Container;

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

`,
``,
"tip field/methods"
);

// T9: setState
replaceOnce(
`    if (!this.sys.isActive()) return;
    if (this.gate.requestPaint()) this.paint();
  }`,
`    if (!this.sys.isActive()) return;
    this.paint();
  }`,
"setState gate"
);

// T10: remove update() method entirely
replaceOnce(
`  /**
   * Walks live between sim ticks. \`paint()\` still rebuilds the floor chrome,
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

`,
``,
"update() method"
);

// T11: paint() header
replaceOnce(
`  private paint(): void {
    this.tweens.killAll();
    this.hideTip();
    this.children.removeAll(true);
    this.staffTokens.clear();
    const width = Math.max(320, this.cssWidth);
    const height = Math.max(240, this.cssHeight);
    const layout = restaurantArenaLayout(width, height);
    this.layout = layout;
    this.dropHints = [];
    const g = this.add.graphics();`,
`  private paint(): void {
    this.tweens.killAll();
    this.children.removeAll(true);
    this.staffTokens.clear();
    const width = Math.max(320, this.cssWidth);
    const height = Math.max(240, this.cssHeight);
    const layout = restaurantArenaLayout(width, height);
    const g = this.add.graphics();`,
"paint() header"
);

// T11b: paint() drawOutcomeToast call
replaceOnce(
`    this.drawOutcomeToast(width, height);`,
`    this.drawOutcomeToast(layout.compact, width, height);`,
"drawOutcomeToast call"
);

// T12: drawOutcomeToast signature/body
replaceOnce(
`  private drawOutcomeToast(width: number, height: number): void {
    const toast = this.outcomeToast;
    if (!toast) return;
    const elapsed = Date.now() - toast.startedAt;
    if (elapsed >= this.outcomeToastMs) {
      this.outcomeToast = undefined;
      return;
    }
    const compact = this.layout?.compact ?? false;
    const tone = toast.tone === "safe" ? 0x2f5c46 : toast.tone === "risky" ? 0x6b2f2b : 0x40342a;`,
`  private drawOutcomeToast(compact: boolean, width: number, height: number): void {
    const toast = this.outcomeToast;
    if (!toast) return;
    const elapsed = Date.now() - toast.startedAt;
    if (elapsed >= this.outcomeToastMs) {
      this.outcomeToast = undefined;
      return;
    }
    const tone = toast.tone === "safe" ? 0x2f5c46 : toast.tone === "risky" ? 0x6b2f2b : 0x40342a;`,
"drawOutcomeToast body"
);

// T13: drawWorkers
replaceOnce(
`  private drawWorkers(layout: RestaurantArenaLayout): void {
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
  }`,
`  private drawWorkers(layout: RestaurantArenaLayout): void {
    const compact = layout.compact;
    const offsets = new Map<Location, number>();
    this.staffTokens.clear();

    for (const worker of this.state.workers) {
      const location = this.visualLocation(worker);
      const offset = offsets.get(location) ?? 0;
      offsets.set(location, offset + 1);
      const slot = this.stackedSlot(location, offset, layout);

      const token = this.buildAvatar(slot.x, slot.y, worker.role, worker.load, compact);
      this.staffTokens.set(worker.role, token);
      const heldHost = worker.role === "host" && Boolean(this.state.seatingHeld) && location === "queue";
      const status = heldHost ? "acting" : (this.workerStatuses.get(worker.role) ?? this.workerStatus(worker));
      this.drawWorkerBadge(token, status, compact, heldHost);
      this.drawSpeechBubble(token, worker.role, compact);
    }
  }`,
"drawWorkers"
);

// T14: buildAvatar signature
replaceOnce(
`  private buildAvatar(
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
    const parts: Phaser.GameObjects.GameObject[] = [figure];`,
`  private buildAvatar(
    x: number,
    y: number,
    role: Role,
    load: number,
    compact: boolean,
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
    const parts: Phaser.GameObjects.GameObject[] = [figure];`,
"buildAvatar signature"
);

// T14b: buildAvatar idle bob
replaceOnce(
`    if (clamped > 0.8) this.tweens.add({ targets: fill, alpha: 0.3, duration: 380, yoyo: true, repeat: -1 });
    if (this.running && !walker.walking) this.startIdleBob(token, y, role);
    return token;
  }`,
`    if (clamped > 0.8) this.tweens.add({ targets: fill, alpha: 0.3, duration: 380, yoyo: true, repeat: -1 });
    if (this.running) this.startIdleBob(token, y, role);
    return token;
  }`,
"buildAvatar idle bob"
);

// T15: setWorkerStatus + remove makeWorkerDraggable/zoneAt/showDropHints
replaceOnce(
`  setWorkerStatus(role: Role, status: RestaurantArenaWorkerStatus): void {
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
          \`\${staff.name} — drag to move\`,
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
        this.onAction(\`assign_\${role}_\${target}\`);
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

`,
`  setWorkerStatus(role: Role, status: RestaurantArenaWorkerStatus): void {
    this.workerStatuses.set(role, status);
    if (this.sys.isActive()) this.paint();
  }

`,
"setWorkerStatus + drag methods"
);

fs.writeFileSync(path, s);
console.log("OK, new line count:", s.split("\n").length);

