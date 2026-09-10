/**
 * Legal-action masking.
 *
 * A policy emits one score per action in a fixed action space, but only some
 * of those actions are legal in any given state. Masking is the step that
 * turns engine rules into a boolean vector and forces the illegal entries to
 * zero probability *before* sampling — so an invalid action can never reach
 * `Game.step()`.
 *
 * The same masker is used by training rollouts, the evaluation harness, and
 * overlay inference. Splitting those paths would let a policy be scored under
 * different rules than it plays under.
 */

import type { Rng } from "../core/rng.js";

/**
 * Per-game legality rules, derived from the engine rather than from UI keys.
 *
 * `actions` is the *policy* action space and its order is the contract: index
 * `i` of a mask, a logit vector, and a probability vector all refer to
 * `actions[i]`. It is not always the same as the `Game.actions` the TUI shell
 * drives — games with an auto-advance cadence expose a "tick" action that the
 * runner owns, not the policy.
 */
export interface ActionMasker<State, Action extends string = string> {
  /** Registry id of the game these rules belong to. */
  readonly gameId: string;
  /** Stable, ordered policy action space. */
  readonly actions: readonly Action[];
  /** Boolean mask aligned to `actions`: true = legal in `state`. */
  legalMask(state: State): boolean[];
}

/**
 * Returned when no action is legal — a terminal state. Callers must handle
 * this instead of sampling: a softmax over an all-illegal mask is NaN, which
 * silently poisons everything downstream of it.
 */
export const NO_LEGAL_ACTION = null;

export class MaskShapeError extends Error {
  constructor(expected: number, received: number, what: string) {
    super(`${what} length ${received} does not match the action space (${expected})`);
    this.name = "MaskShapeError";
  }
}

function checkLength(expected: number, received: number, what: string): void {
  if (expected !== received) throw new MaskShapeError(expected, received, what);
}

/** True when the mask forbids every action, i.e. the state is terminal. */
export function isTerminalMask(mask: readonly boolean[]): boolean {
  return !mask.some(Boolean);
}

export function countLegal(mask: readonly boolean[]): number {
  return mask.reduce((total, legal) => total + (legal ? 1 : 0), 0);
}

/** The subset of `actions` the mask permits, in action-space order. */
export function maskedActions<Action extends string>(
  actions: readonly Action[],
  mask: readonly boolean[],
): Action[] {
  checkLength(actions.length, mask.length, "mask");
  return actions.filter((_, index) => mask[index]);
}

/** Convenience: legal actions for a state, straight from the masker. */
export function legalActions<State, Action extends string>(
  masker: ActionMasker<State, Action>,
  state: State,
): Action[] {
  return maskedActions(masker.actions, masker.legalMask(state));
}

/**
 * Set illegal logits to -Infinity so they survive into softmax as exactly
 * zero probability. Applied before the softmax, never after: renormalizing
 * afterwards leaks probability mass through the illegal entries first.
 */
export function applyMask(logits: readonly number[], mask: readonly boolean[]): number[] {
  checkLength(logits.length, mask.length, "mask");
  return logits.map((logit, index) => (mask[index] ? logit : Number.NEGATIVE_INFINITY));
}

/**
 * Numerically stable softmax over the legal entries only. Illegal entries come
 * back as exactly 0 and the legal entries sum to 1.
 *
 * Returns all zeros for a terminal mask rather than NaN; check
 * `isTerminalMask` first if you need to distinguish that case.
 */
export function maskedSoftmax(logits: readonly number[], mask: readonly boolean[]): number[] {
  const masked = applyMask(logits, mask);
  if (isTerminalMask(mask)) return masked.map(() => 0);

  // Subtract the max legal logit so exp() cannot overflow. -Infinity entries
  // stay -Infinity through the subtraction and exp() to exactly 0.
  const max = Math.max(...masked.filter((value) => Number.isFinite(value)));
  const exps = masked.map((value) => (Number.isFinite(value) ? Math.exp(value - max) : 0));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map((value) => value / total);
}

/** Highest-scoring legal action; `NO_LEGAL_ACTION` in a terminal state. */
export function argmaxMasked<Action extends string>(
  actions: readonly Action[],
  logits: readonly number[],
  mask: readonly boolean[],
): Action | null {
  checkLength(actions.length, logits.length, "logits");
  checkLength(actions.length, mask.length, "mask");

  let best = -1;
  for (let index = 0; index < actions.length; index++) {
    if (!mask[index]) continue;
    if (best === -1 || logits[index]! > logits[best]!) best = index;
  }
  return best === -1 ? NO_LEGAL_ACTION : actions[best]!;
}

/**
 * Sample a legal action from masked probabilities. Takes the seeded `Rng` so
 * rollouts stay reproducible from (seed, policy) alone.
 */
export function sampleMasked<Action extends string>(
  actions: readonly Action[],
  logits: readonly number[],
  mask: readonly boolean[],
  rng: Rng,
): Action | null {
  checkLength(actions.length, logits.length, "logits");
  if (isTerminalMask(mask)) return NO_LEGAL_ACTION;

  const probabilities = maskedSoftmax(logits, mask);
  let cumulative = 0;
  const target = rng.next();
  for (let index = 0; index < actions.length; index++) {
    cumulative += probabilities[index]!;
    if (target < cumulative) return actions[index]!;
  }
  // Floating-point shortfall: fall back to the last legal action.
  const legal = maskedActions(actions, mask);
  return legal[legal.length - 1] ?? NO_LEGAL_ACTION;
}

/**
 * Uniform random choice over legal actions — the random baseline #99 measures
 * trained policies against. Uniform over the *full* action space would stall
 * on no-ops and set a meaninglessly weak bar.
 */
export function randomLegalAction<Action extends string>(
  actions: readonly Action[],
  mask: readonly boolean[],
  rng: Rng,
): Action | null {
  const legal = maskedActions(actions, mask);
  if (legal.length === 0) return NO_LEGAL_ACTION;
  return legal[rng.int(legal.length)]!;
}
