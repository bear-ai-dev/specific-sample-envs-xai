/**
 * What the shared model account is doing to this shift, kept out of `app.ts`
 * so it can be unit tested without a DOM.
 *
 * A live shift and the retro-backend harness draw on one rate-limited demo
 * account (#289), so a worker turn can go unanswered for two very different
 * reasons: the crew failed, or the account has not let the request start yet.
 * From the HUD's side both look the same -- no answer -- and the overlay used
 * to render either as `Fallback`, which reads as a broken crew. A tester who
 * sees that reasonably concludes the game is broken and stops (#281).
 *
 * The Rust transport is the only thing that knows which it is: it owns the
 * request budget and sees the provider's 429. So it reports, and this module
 * decides what the report means for the banner.
 */

export type WorkerBudgetState =
  /** Nothing is holding requests back; ordinary worker status applies. */
  | { kind: "clear" }
  /** Queued behind our own share of the account's per-minute window. */
  | { kind: "waiting"; seconds: number }
  /** The provider returned 429; every worker is held back, not just this one. */
  | { kind: "throttled"; seconds: number };

export const WORKER_BUDGET_EVENT = "gamepigeon:worker-budget";

export const CLEAR: WorkerBudgetState = { kind: "clear" };

/**
 * Read a `gamepigeon:worker-budget` detail, or `undefined` if it is not one.
 *
 * The event is dispatched by our own Rust transport, but it arrives through
 * `window`, where any script on the page could fire the same name. An
 * unrecognized shape is dropped rather than guessed at: a banner claiming a
 * wait that is not happening is worse than no banner.
 */
export function readWorkerBudgetSignal(detail: unknown): WorkerBudgetState | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const { state, seconds } = detail as { state?: unknown; seconds?: unknown };
  if (state === "ready") return CLEAR;
  if (state !== "waiting" && state !== "throttled") return undefined;
  // A wait the transport reports as under a second still deserves a banner;
  // rounding it to "0s" would read as a stuck shift rather than a brief one.
  const value = typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(1, Math.round(seconds)) : 1;
  return { kind: state, seconds: value };
}

/** The banner text for a held-back shift. `modelLabel` names the live crew. */
export function workerBudgetMessage(state: WorkerBudgetState, modelLabel: string): string | undefined {
  if (state.kind === "clear") return undefined;
  const reason =
    state.kind === "waiting"
      ? `Waiting for the shared model account — ${state.seconds}s`
      : `Shared model account is rate limited — retrying in ${state.seconds}s`;
  return `${reason} · ${modelLabel}`;
}

/**
 * Whether a failed worker turn should be reported as a fallback to the
 * deterministic crew.
 *
 * While the account is holding requests back, it should not: the crew is
 * waiting its turn, and #289's transport deliberately phrases the 429 so the
 * HUD can say so. Only once nothing is holding requests back does an error
 * mean what `Fallback` claims it means.
 */
export function shouldReportFallback(state: WorkerBudgetState): boolean {
  return state.kind === "clear";
}

/**
 * How long to keep the banner up with no further word from the transport.
 *
 * A `waiting` report is followed by `ready` the moment the request is
 * admitted, so its timer is only a safety net. A `throttled` report has no
 * such follow-up -- the next request simply happens later -- so the countdown
 * is what clears it, and it must not outlive the wait it describes.
 */
export function workerBudgetHoldMs(state: WorkerBudgetState): number {
  return state.kind === "clear" ? 0 : state.seconds * 1_000;
}
