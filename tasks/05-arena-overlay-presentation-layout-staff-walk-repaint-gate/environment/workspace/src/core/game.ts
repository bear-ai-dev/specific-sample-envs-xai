/**
 * Shared game contract. Every launch title implements this so the overlay shell
 * and trajectory logger stay game-agnostic. Modeled after a gym-style
 * env: reset → (step)* → done, with serializable state at every step.
 */
export interface StepResult {
  /** Reward gained by this action (e.g. merge score in 2048). */
  reward: number;
  /** Whether the action actually changed the state (illegal moves don't). */
  moved: boolean;
  /** Episode finished. */
  done: boolean;
  /** Goal reached (e.g. made the 2048 tile). Distinct from `done`. */
  success: boolean;
  /** Random outcome produced while applying the action, when one occurred. */
  randomEffects?: unknown;
}

export interface GameVariation {
  id: string;
  title: string;
  description: string;
  goal: string;
}

export interface Game<State, Action extends string> {
  readonly name: string;
  /** Actions the agent/user can take, as stable string ids. */
  readonly actions: readonly Action[];
  reset(seed: number): void;
  step(action: Action): StepResult;
  /** JSON-serializable snapshot of the full observable state. */
  state(): State;
  score(): number;
}
