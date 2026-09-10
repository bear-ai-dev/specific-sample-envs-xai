export interface OutcomeToastState {
  shownOutcomeId?: string;
  outcomeToast?: {
    headline: string;
    tone: "safe" | "risky" | "neutral";
    startedAt: number;
  };
}

export const OUTCOME_TOAST_MS = 2600;

export interface DecisionOutcomeLike {
  id: string;
  headline: string;
  tone: "safe" | "risky" | "neutral";
}

/**
 * Initializes toast state upon scene construction.
 *
 * If `persisted` state is provided (e.g. across a window resize or size-verification
 * reboot), an active toast is preserved with its original `startedAt` timestamp so
 * that its remaining display time and fade-out animation continue uninterrupted.
 * If the toast has expired, its `shownOutcomeId` is still retained so the outcome
 * is not erroneously resurfaced.
 *
 * If no `persisted` state is provided but `lastOutcome` is present on the initial
 * state, a new toast is initialized for startup display.
 */
export function initOutcomeToastState(
  lastOutcome?: DecisionOutcomeLike,
  persisted?: OutcomeToastState,
  now: number = Date.now(),
  durationMs: number = OUTCOME_TOAST_MS,
): OutcomeToastState {
  if (persisted) {
    let outcomeToast: OutcomeToastState["outcomeToast"] | undefined;
    if (persisted.outcomeToast && now - persisted.outcomeToast.startedAt < durationMs) {
      outcomeToast = persisted.outcomeToast;
    }
    return {
      shownOutcomeId: persisted.shownOutcomeId,
      outcomeToast,
    };
  }
  if (lastOutcome) {
    return {
      shownOutcomeId: lastOutcome.id,
      outcomeToast: {
        headline: lastOutcome.headline,
        tone: lastOutcome.tone,
        startedAt: now,
      },
    };
  }
  return {};
}

/**
 * Updates toast state when a new state arrives (e.g. via `setState`).
 *
 * Only starts a new toast if `lastOutcome` has a new ID that has not yet been shown.
 */
export function updateOutcomeToastState(
  current: OutcomeToastState,
  lastOutcome?: DecisionOutcomeLike,
  now: number = Date.now(),
): OutcomeToastState {
  if (lastOutcome && lastOutcome.id !== current.shownOutcomeId) {
    return {
      shownOutcomeId: lastOutcome.id,
      outcomeToast: {
        headline: lastOutcome.headline,
        tone: lastOutcome.tone,
        startedAt: now,
      },
    };
  }
  return current;
}
