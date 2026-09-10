/**
 * The playable layer on top of the state contract.
 *
 * `RestaurantState` is the published, schema-locked contract the benchmark
 * records. Everything a human needs in order to *play* — who the staff are,
 * what they are thinking, which parties are still waiting at the door, and
 * the decision currently holding the clock — lives here instead, so the
 * contract never has to carry presentation state.
 */

import type { RestaurantState, Role } from "./types.js";
import type { TimelineModel } from "./timeline.js";

/** Real-time speed multiplier. The shift only advances while `running`. */
export type SimSpeed = 1 | 2 | 4;
export const SIM_SPEEDS: readonly SimSpeed[] = [1, 2, 4] as const;

/**
 * One tick at ×1. Deliberately slow: the old 1.5s cadence read as a video
 * playing itself, because a tick can seat a party, plate a dish and burn a
 * guest's patience all at once.
 */
export const BASE_TICK_MS = 3000;

/**
 * Tonight's target. A shift the player can win or lose gives every decision
 * a price they can feel, and gives the restart button a reason.
 */
export interface ShiftGoal {
  readonly cash: number;
  readonly maxWalkouts: number;
  /** Any unverified allergy plate fails the night outright. */
  readonly unsafeAllowed: number;
}

export interface ShiftIncident {
  readonly tick: number;
  readonly kind: "oven_failure" | "warming_shelf_overheat";
  readonly targetId: string;
}

/**
 * Which night you are working. Same restaurant, different pressure — the
 * reason to come back once you have taken the Wednesday cleanly.
 */
export interface ShiftPreset {
  readonly id: string;
  readonly goal: ShiftGoal;
  readonly maxTicks: number;
  /** Ticks between arrivals: `min` plus 0..`spread`. */
  readonly arrivalGap: readonly [min: number, spread: number];
  /** 1-in-N tickets carry an allergy. */
  readonly allergyOdds: number;
  /** Incidents belong to the level instead of a separate comparison case. */
  readonly incidents: readonly ShiftIncident[];
  /** Overrides `BASE_TICK_MS` so a training shift can run slower than service. */
  readonly tickMs?: number;
}

export const TUTORIAL_SHIFT_ID = "tutorial-shift";

export const SHIFT_PRESETS: Readonly<Record<string, ShiftPreset>> = {
  [TUTORIAL_SHIFT_ID]: {
    id: TUTORIAL_SHIFT_ID,
    goal: { cash: 80, maxWalkouts: 2, unsafeAllowed: 0 },
    maxTicks: 16,
    arrivalGap: [4, 2],
    allergyOdds: 8,
    incidents: [],
    tickMs: 4500,
  },
  "quiet-tuesday": {
    id: "quiet-tuesday",
    goal: { cash: 140, maxWalkouts: 3, unsafeAllowed: 0 },
    maxTicks: 24,
    arrivalGap: [3, 2],
    allergyOdds: 8,
    incidents: [{ tick: 15, kind: "warming_shelf_overheat", targetId: "warming-shelf-1" }],
  },
  "dinner-rush": {
    id: "dinner-rush",
    goal: { cash: 190, maxWalkouts: 2, unsafeAllowed: 0 },
    maxTicks: 24,
    arrivalGap: [2, 2],
    allergyOdds: 6,
    incidents: [
      { tick: 8, kind: "oven_failure", targetId: "oven-1" },
      { tick: 15, kind: "warming_shelf_overheat", targetId: "warming-shelf-1" },
    ],
  },
  "saturday-night": {
    id: "saturday-night",
    goal: { cash: 320, maxWalkouts: 1, unsafeAllowed: 0 },
    maxTicks: 28,
    arrivalGap: [1, 2],
    allergyOdds: 4,
    incidents: [
      { tick: 6, kind: "oven_failure", targetId: "oven-1" },
      { tick: 12, kind: "warming_shelf_overheat", targetId: "warming-shelf-1" },
    ],
  },
};

export const DEFAULT_SHIFT = SHIFT_PRESETS["dinner-rush"]!;

export interface StaffProfile {
  readonly role: Role;
  /** Staff are people with names — "Mira burned the fish" beats "chef". */
  readonly name: string;
  readonly title: string;
  /** One line of character, shown on the pre-shift card. */
  readonly trait: string;
}

export const STAFF: Readonly<Record<Role | "expediter", StaffProfile>> = {
  host: { role: "host", name: "Vela", title: "host", trait: "door and queue" },
  supply_lead: { role: "supply_lead", name: "Dario", title: "supply lead", trait: "pass and tickets" },
  chef: { role: "chef", name: "Mira", title: "chef", trait: "kitchen station only" },
  server: { role: "server", name: "Kip", title: "server", trait: "runs plates to tables" },
  get expediter() {
    return this.supply_lead;
  },
};

export const STAFF_LIST: readonly StaffProfile[] = [STAFF.host, STAFF.supply_lead, STAFF.chef, STAFF.server];

/** Who a feed line belongs to — a role, the room itself, or the player. */
export type FeedVoice = Role | "house" | "you";

export type FeedKind = "thought" | "action" | "event" | "player";

export interface FeedEntry {
  readonly id: number;
  readonly tick: number;
  /** "18:24" — the in-fiction clock, not a tick index. */
  readonly clock: string;
  readonly who: string;
  readonly voice: FeedVoice;
  readonly kind: FeedKind;
  readonly text: string;
}

/** A party at the door. Patience runs 1 → 0; at 0 they walk. */
export interface WaitingParty {
  readonly id: string;
  readonly size: number;
  readonly patience: number;
  readonly waitedTicks: number;
}

export type DecisionTone = "safe" | "risky" | "neutral";

export interface DecisionOption {
  readonly id: string;
  readonly label: string;
  /**
   * The trade-off in plain language. A choice the player cannot price is
   * not a choice, so every option states what it costs and what it buys.
   */
  readonly detail: string;
  readonly tone: DecisionTone;
}

export interface Decision {
  readonly id: string;
  readonly title: string;
  /** Name of the staff member putting the question to the player. */
  readonly speaker: string;
  readonly speakerRole: Role;
  readonly prompt: string;
  readonly options: readonly DecisionOption[];
}

/**
 * Every decision the shift can raise. The clock stops whenever one is open,
 * so these are the beats where the player actually plays.
 */
export const DECISIONS: readonly Decision[] = [
  {
    id: "allergy_ticket",
    title: "Allergy ticket on the board",
    speaker: STAFF.supply_lead.name,
    speakerRole: "supply_lead",
    prompt: "Table 2 is a peanut allergy and the ticket is for fish. Mira wants to swap in the house sauce. How do we run it?",
    options: [
      {
        id: "verify",
        label: "Verify every plate with Mira",
        detail: "Costs one tick of kitchen time. The ticket is guaranteed safe and the guest notices the care.",
        tone: "safe",
      },
      {
        id: "substitute",
        label: "Let her substitute and send it",
        detail: "Fastest plate on the board. An unverified swap can put the guest in hospital — and end your night.",
        tone: "risky",
      },
      {
        id: "pull",
        label: "Pull the dish and comp the table",
        detail: "Zero risk. You eat the cost: −$22 and a small hit to satisfaction.",
        tone: "neutral",
      },
    ],
  },
  {
    id: "oven_down",
    title: "The oven just died",
    speaker: STAFF.chef.name,
    speakerRole: "chef",
    prompt: "Oven's dead with four tickets up. I can fix it or I can cook — not both.",
    options: [
      {
        id: "repair",
        label: "Get Mira on the oven",
        detail: "Kitchen off the line for two ticks, then the oven limps back. Tickets pile up meanwhile.",
        tone: "safe",
      },
      {
        id: "hold",
        label: "Vela holds the door",
        detail: "No new covers until it's fixed. Reputation protected, but every held party is money walking away.",
        tone: "neutral",
      },
      {
        id: "push",
        label: "Push through on cold dishes",
        detail: "Keep serving what doesn't need heat. Fast cash now, and the room's patience pays for it.",
        tone: "risky",
      },
    ],
  },
  {
    id: "shelf_hot",
    title: "Warming shelf is over temperature",
    speaker: STAFF.supply_lead.name,
    speakerRole: "supply_lead",
    prompt: "Shelf is running hot and there are plates sitting on it. I need a call before they go out.",
    options: [
      {
        id: "dump",
        label: "Dump what's on the shelf",
        detail: "Two plates in the bin and the tickets get refired. Waste +2, nobody gets sick.",
        tone: "safe",
      },
      {
        id: "serve",
        label: "Send them before they turn",
        detail: "Two covers land immediately. If the shelf was already past temperature, satisfaction and reputation take it.",
        tone: "risky",
      },
    ],
  },
  {
    id: "rush_wave",
    title: "A wave just walked in",
    speaker: STAFF.host.name,
    speakerRole: "host",
    prompt: "Three parties at once and I've got one open table. What do I tell them?",
    options: [
      {
        id: "seat_all",
        label: "Seat everyone we can, fast",
        detail: "Maximum covers. The kitchen gets buried and wait times climb across the room.",
        tone: "risky",
      },
      {
        id: "quote_wait",
        label: "Quote an honest wait",
        detail: "Some parties leave, the ones who stay stay patient. Fewer covers, calmer floor.",
        tone: "safe",
      },
    ],
  },
] as const;

export const DECISIONS_BY_ID: ReadonlyMap<string, Decision> = new Map(DECISIONS.map((d) => [d.id, d]));

/** `decide_<decision>_<option>` — one replayable action id per option. */
export type DecisionAction = `decide_${string}`;

export const DECISION_ACTIONS: readonly DecisionAction[] = DECISIONS.flatMap((decision) =>
  decision.options.map((option) => `decide_${decision.id}_${option.id}` as DecisionAction),
);

export function parseDecisionAction(action: string): { decisionId: string; optionId: string } | undefined {
  if (!action.startsWith("decide_")) return undefined;
  for (const decision of DECISIONS) {
    const prefix = `decide_${decision.id}_`;
    if (!action.startsWith(prefix)) continue;
    const optionId = action.slice(prefix.length);
    if (decision.options.some((option) => option.id === optionId)) return { decisionId: decision.id, optionId };
  }
  return undefined;
}

export interface SimControl {
  /** False until the player starts the shift, so nothing moves on a cold open. */
  readonly started: boolean;
  readonly running: boolean;
  readonly speed: SimSpeed;
}

export interface DebriefLine {
  readonly label: string;
  readonly value: string;
  readonly good: boolean;
}

/**
 * One of the conditions tonight was actually judged on, with the number it
 * was judged against.
 *
 * `DebriefLine.good` is a colour hint tuned for reading a shift at a glance
 * ("walkouts ≤ 1 is a good night"), which is *not* the same bar as the
 * preset's goal ("≤ 2 walkouts passes"). Showing only those flags next to a
 * TARGET MET/MISSED verdict left the two silently disagreeing, so the target
 * checks are reported separately and explicitly.
 */
export interface DebriefTarget {
  readonly label: string;
  /** What the shift actually did. */
  readonly value: string;
  /** What it had to do — "≥ $190", "≤ 2". */
  readonly requirement: string;
  readonly met: boolean;
}

export interface Debrief {
  readonly grade: string;
  readonly headline: string;
  /** Whether tonight's target was met. */
  readonly met: boolean;
  /** The conditions `met` was computed from, each with its own verdict. */
  readonly targets: readonly DebriefTarget[];
  readonly lines: readonly DebriefLine[];
  /** What to do differently — the reason to press restart. */
  readonly lessons: readonly string[];
}

/**
 * What just happened as a direct result of the player's last decision — a
 * one-line receipt, shown as a brief on-canvas callout so the consequence
 * lands where the player is already looking (where the decision card was)
 * instead of only being legible by scrolling the service log. `id` changes
 * on every new decision answered (even a repeat of the same option), which
 * is how the scene tells "a fresh outcome just landed" from "the same one
 * is still in view".
 */
export interface DecisionOutcome {
  readonly id: string;
  readonly headline: string;
  readonly tone: DecisionTone;
}

/**
 * Everything the overlay draws: the contract state plus the playable layer.
 * The scene renders from this and nothing else.
 */
export interface ArenaView extends RestaurantState {
  readonly sim: SimControl;
  readonly feed: readonly FeedEntry[];
  readonly waiting: readonly WaitingParty[];
  /** Open decision holding the clock, if any. */
  readonly decision?: Decision;
  /** The receipt for the most recently answered decision, if any yet. */
  readonly lastOutcome?: DecisionOutcome;
  readonly staff: Readonly<Record<Role, StaffProfile>>;
  readonly goal: ShiftGoal;
  /**
   * The two running counters the goal is judged on that `RestaurantState`
   * does not carry. Live, so the shift view can show how close the night is
   * to failing instead of only revealing it in the debrief.
   */
  readonly tally: { readonly walkouts: number; readonly unsafeServed: number };
  /** Which night is being worked, for the pre-shift card. */
  readonly shift: { id: string; title: string };
  /** Present only once the shift has ended. */
  readonly debrief?: Debrief;
  readonly timeline?: TimelineModel;
  readonly score: number;
  /** The one in-shift purchase currently on offer: cost, and whether it's bought. */
  readonly upgrade: { id: "second_stove"; label: string; cost: number; bought: boolean };
  /** Training-shift prompt. Absent on scored nights. */
  readonly coach?: CoachPrompt;
}

export interface CoachPrompt {
  readonly step: number;
  readonly total: number;
  readonly title: string;
  readonly detail: string;
}

const TUTORIAL_STEPS = 3;

/**
 * The next thing a first-time player should do on the training shift.
 * Scored nights return nothing — a coach line on Dinner Rush would pollute
 * the decision surface the benchmark is measuring.
 */
export function tutorialCoach(view: {
  readonly shift: { id: string };
  readonly sim: SimControl;
  readonly workers: readonly { role: string; location: string }[];
  readonly orders: readonly { tableId?: string; status: string; allergy?: string; priority: string }[];
  readonly decision?: { id: string };
  readonly goal: ShiftGoal;
  /** Decision ids already answered this shift — so a resolved allergy call is not re-taught. */
  readonly decidedIds?: readonly string[];
}): CoachPrompt | undefined {
  if (view.shift.id !== TUTORIAL_SHIFT_ID) return undefined;
  if (!view.sim.started) {
    return {
      step: 0,
      total: TUTORIAL_STEPS,
      title: "Training shift",
      detail: "Read the target, then open the doors. Space starts and pauses the clock.",
    };
  }
  const hasRushed = view.orders.some((order) => order.priority === "high");
  if (!hasRushed) {
    const rushOrder =
      view.orders.find((order) => order.tableId === "table-1" && order.status !== "served" && order.status !== "cancelled") ??
      view.orders.find((order) => order.status !== "served" && order.status !== "cancelled" && !order.allergy && order.tableId?.match(/^table-[1-3]$/)) ??
      view.orders.find((order) => order.status !== "served" && order.status !== "cancelled" && !order.allergy);
    if (rushOrder) {
      const tableNum = (rushOrder.tableId?.match(/\d+/) ?? ["1"])[0];
      const tableLabel = rushOrder.tableId ? rushOrder.tableId.replace("table-", "table ") : "table 1";
      const isTable1 = rushOrder.tableId === "table-1";
      return {
        step: 1,
        total: TUTORIAL_STEPS,
        title: `Rush ${tableLabel}`,
        detail: isTable1
          ? "optional — click the pasta ticket (or press 1) to cook that table first"
          : `optional — click the ticket (or press ${tableNum}) to cook that table first`,
      };
    }
  }
  const allergyDecided = view.decidedIds?.includes("allergy_ticket") === true;
  if (!allergyDecided && view.decision?.id === "allergy_ticket") {
    return {
      step: 2,
      total: TUTORIAL_STEPS,
      title: "allergy call",
      detail: "clock is stopped — pick verify or one unchecked plate fails the night",
    };
  }
  const allergy = view.orders.find((order) => order.allergy && order.status !== "served" && order.status !== "cancelled");
  if (!allergyDecided && allergy) {
    return {
      step: 2,
      total: TUTORIAL_STEPS,
      title: "protect the allergy",
      detail: "click the allergy ticket or press v — one unchecked plate fails the night",
    };
  }
  return {
    step: 3,
    total: TUTORIAL_STEPS,
    title: "Hit the number",
    detail: `Take $${view.goal.cash} without an unsafe plate. HOLD the door if the queue piles up.`,
  };
}
