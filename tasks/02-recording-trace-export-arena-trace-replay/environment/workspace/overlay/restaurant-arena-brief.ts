/**
 * The manager brief: the one band of the screen that answers, in order,
 * "what am I trying to do tonight", "how close am I", and "what is the one
 * thing I should do right now".
 *
 * The arena already carries every fact this needs — the shift goal, the
 * running tally, the open decision, the live incident, the queue at the
 * door. What it never did was say any of it in one place, so a first-time
 * player had to reconstruct the state of the night from a ticket rail, a
 * star row and a scrolling log. This is a pure projection of the state the
 * scene already has: it invents no numbers and reads no metric the engine
 * does not actually keep.
 *
 * Deliberately thin. An earlier pass put the target sentence, five chips
 * and a full-sentence directive in the same band, which restated the same
 * numbers twice and gave a calm shift as much ink as a failing one. What
 * survives is only what changes a decision: the three conditions that can
 * lose the night, and one short instruction.
 *
 * Deliberately absent: any table-wait figure. The only wait the engine can
 * currently produce is `tableWaitMinutes`, which returns the whole-shift
 * clock rather than a per-table arrival delta, so putting it on screen
 * would claim a metric the data does not support (#304).
 */

export type BriefTone = "ok" | "warn" | "bad";

export interface BriefChip {
  readonly label: string;
  readonly value: string;
  readonly tone: BriefTone;
}

export interface ArenaBrief {
  readonly chips: readonly BriefChip[];
  /** Short tag for the current directive — "DECIDE", "FIX", "STEP 2/4". */
  readonly nowLabel: string;
  /** The current issue and the action that answers it, in one sentence. */
  readonly now: string;
  /** What the last answered decision actually did, kept until the next one. */
  readonly last?: string;
}

/** Everything `arenaBrief` reads. A structural subset of the scene state. */
export interface BriefInput {
  readonly clock?: { minute: number };
  readonly orders: readonly {
    id: string;
    tableId?: string;
    status: string;
    allergy?: string;
    priority: string;
  }[];
  readonly workers: readonly { role: string; location: string }[];
  readonly outcomes: { cash: number; waste: number; completed: number };
  readonly emergency?: { kind: string; active: boolean };
  readonly seatingHeld?: boolean;
  readonly sim?: { started: boolean; running: boolean };
  readonly waiting?: readonly { id: string; size: number }[];
  readonly decision?: { id: string; title: string; speaker: string };
  readonly lastOutcome?: { headline: string };
  readonly goal?: { cash: number; maxWalkouts: number; unsafeAllowed: number };
  readonly staff?: Record<string, { name: string }>;
  /** Running fail-condition counters. Absent on raw contract fixtures. */
  readonly tally?: { walkouts: number; unsafeServed: number };
  readonly coach?: { step: number; total: number; title: string; detail: string };
}

const ACTIVE = new Set(["queued", "seated", "preparing", "ready"]);

function tableLabel(order: { tableId?: string; id: string }): string {
  return order.tableId ? order.tableId.replace("table-", "table ") : order.id;
}

function name(input: BriefInput, role: string, fallback: string): string {
  return input.staff?.[role]?.name ?? fallback;
}

/**
 * Only the conditions the night is judged on. Waste is a debrief number and
 * the queue is drawn at the door as parties with patience bars, so putting
 * either here spent attention on something already on screen.
 */
function chips(input: BriefInput): BriefChip[] {
  const goal = input.goal;
  const out: BriefChip[] = [
    {
      label: "TAKINGS",
      value: goal ? `$${Math.round(input.outcomes.cash)}/$${goal.cash}` : `$${Math.round(input.outcomes.cash)}`,
      // Never a warning. Takings are progress, not a condition you can
      // breach mid-shift, and colouring "$0/$190" at 17:30 raised an alarm
      // about the shift not having happened yet.
      tone: "ok",
    },
  ];
  const tally = input.tally;
  if (tally && goal) {
    out.push({
      label: "WALKOUTS",
      value: `${tally.walkouts}/${goal.maxWalkouts}`,
      tone: tally.walkouts > goal.maxWalkouts ? "bad" : tally.walkouts === goal.maxWalkouts ? "warn" : "ok",
    });
    out.push({
      label: "UNVERIFIED",
      value: `${tally.unsafeServed}/${goal.unsafeAllowed}`,
      tone: tally.unsafeServed > goal.unsafeAllowed ? "bad" : "ok",
    });
  }
  return out;
}

/**
 * The single next thing to do. Ordered by what actually blocks the shift:
 * a stopped clock first, then anything that can fail the night outright,
 * then throughput, then the idle case — so the line never competes with
 * itself for the player's attention.
 */
function directive(input: BriefInput): { label: string; text: string } {
  const coach = input.coach;
  // The coach's `detail` is already the instruction; its `title` only named
  // the step the tag now carries.
  if (coach) {
    return { label: coach.step > 0 ? `STEP ${coach.step}/${coach.total}` : "TRAINING", text: coach.detail };
  }
  if (input.sim && !input.sim.started) {
    return { label: "START", text: "Press Play to open the doors." };
  }
  if (input.decision) {
    return { label: "DECIDE", text: `${input.decision.speaker} needs a call — pick an option.` };
  }
  if (input.emergency?.active) {
    return { label: "FIX", text: `${input.emergency.kind.replace(/_/g, " ")} — click the oven.` };
  }
  const allergy = input.orders.find((order) => order.allergy && ACTIVE.has(order.status));
  if (allergy) {
    return { label: "SAFETY", text: `Allergy on ${tableLabel(allergy)} — press V to verify.` };
  }
  const queue = input.waiting?.length ?? 0;
  if (queue >= 3 && !input.seatingHeld) {
    return { label: "DOOR", text: `${queue} parties waiting — HOLD the door (H), or let ${name(input, "host", "the host")} seat them.` };
  }
  const ready = input.orders.filter((order) => order.status === "ready").length;
  if (ready > 0) {
    return { label: "PASS", text: `${ready} plate${ready === 1 ? "" : "s"} up — ${name(input, "server", "the server")} runs them from the floor.` };
  }
  const chef = input.workers.find((worker) => worker.role === "chef");
  if (chef && chef.location !== "kitchen") {
    return { label: "STAFF", text: `Drag ${name(input, "chef", "the chef")} onto the kitchen.` };
  }
  return { label: "STEADY", text: "Room is steady — click a ticket to rush it." };
}

export function arenaBrief(input: BriefInput): ArenaBrief {
  const now = directive(input);
  return {
    chips: chips(input),
    nowLabel: now.label,
    now: now.text,
    ...(input.lastOutcome ? { last: input.lastOutcome.headline } : {}),
  };
}
