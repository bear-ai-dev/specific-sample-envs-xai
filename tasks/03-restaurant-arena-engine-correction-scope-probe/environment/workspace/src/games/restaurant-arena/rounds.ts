/**
 * The decision-round contract, frozen for issue #262.
 *
 * Both controllers read their round budget from here — the overlay's human
 * manager and the model-driven `WorkerOrchestrator` alike — so neither path
 * can quietly grant itself authority the other does not have. A level's
 * round count is *derived*, not declared: the tick interval is the frozen
 * invariant and the count follows from how long the shift runs.
 *
 * That is why Saturday Night gets 14 rounds where the other two get 12. It
 * runs 28 ticks rather than 24, and trimming it to fit a uniform 12 was
 * measured to cost roughly two served orders — about 10% of a cash goal the
 * level already only just reaches.
 */

import { SHIFT_PRESETS, DEFAULT_SHIFT } from "./arena-view.js";

/** Simulation ticks advanced at the end of every decision round. Frozen. */
export const TICKS_PER_ROUND = 2;

/** One manager action or message per round, an explicit no-op included. */
export const MANAGER_ENVELOPES_PER_ROUND = 1;

export interface RoundContract {
  readonly variationId: string;
  /** Frozen ticks advanced per round. */
  readonly ticksPerRound: number;
  /** Decision rounds in the level, derived from `maxTicks / ticksPerRound`. */
  readonly rounds: number;
  readonly maxTicks: number;
  /** Manager envelopes budgeted per round. */
  readonly envelopesPerRound: number;
}

/** Where the shift stands: which round is open and what is left in it. */
export interface RoundStatus {
  /** 1-based. Never exceeds `totalRounds`. */
  readonly round: number;
  readonly totalRounds: number;
  /** Ticks already advanced inside the open round. */
  readonly ticksIntoRound: number;
  /** Manager envelopes already spent this round. */
  readonly envelopesSpent: number;
  readonly envelopesPerRound: number;
  /** False once the round's envelope is spent. */
  readonly canAct: boolean;
}

export function roundContractFor(variationId?: string): RoundContract {
  const preset = (variationId && SHIFT_PRESETS[variationId]) || DEFAULT_SHIFT;
  return {
    variationId: preset.id,
    ticksPerRound: TICKS_PER_ROUND,
    rounds: Math.ceil(preset.maxTicks / TICKS_PER_ROUND),
    maxTicks: preset.maxTicks,
    envelopesPerRound: MANAGER_ENVELOPES_PER_ROUND,
  };
}

/**
 * The round that *contains* `tick` — round *r* advances ticks 2r−1 and 2r, so
 * Dinner Rush's oven failure at tick 8 belongs to round 4. Tick 0 is the
 * opening manager envelope, before anything has advanced, and reads as
 * round 1.
 */
export function roundForTick(tick: number, ticksPerRound: number = TICKS_PER_ROUND): number {
  if (tick <= 0) return 1;
  return Math.ceil(tick / ticksPerRound);
}
