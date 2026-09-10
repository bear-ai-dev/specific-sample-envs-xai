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
