import { describe, expect, test } from "bun:test";
import {
  initOutcomeToastState,
  updateOutcomeToastState,
  OUTCOME_TOAST_MS,
  type OutcomeToastState,
} from "./restaurant-arena-toast.js";

describe("Restaurant Arena Outcome Toast", () => {
  const sampleOutcome = {
    id: "allergy:verify:0",
    headline: "ALLERGY CHECK PASSED",
    tone: "safe" as const,
  };

  test("initializes empty when no outcome and no persisted state exist", () => {
    const state = initOutcomeToastState(undefined, undefined, 1000);
    expect(state.shownOutcomeId).toBeUndefined();
    expect(state.outcomeToast).toBeUndefined();
  });

  test("initializes toast at startup when state contains lastOutcome without persisted state", () => {
    const state = initOutcomeToastState(sampleOutcome, undefined, 1000);
    expect(state.shownOutcomeId).toBe("allergy:verify:0");
    expect(state.outcomeToast).toEqual({
      headline: "ALLERGY CHECK PASSED",
      tone: "safe",
      startedAt: 1000,
    });
  });

  test("preserves in-flight toast and original startedAt across scene reboot when within 2.6s", () => {
    const persisted: OutcomeToastState = {
      shownOutcomeId: "allergy:verify:0",
      outcomeToast: {
        headline: "ALLERGY CHECK PASSED",
        tone: "safe",
        startedAt: 1000,
      },
    };

    // Reboot occurs at t=2000 (1000ms elapsed, well within 2600ms)
    const state = initOutcomeToastState(sampleOutcome, persisted, 2000);
    expect(state.shownOutcomeId).toBe("allergy:verify:0");
    expect(state.outcomeToast).toBeDefined();
    expect(state.outcomeToast?.startedAt).toBe(1000);
    expect(state.outcomeToast?.headline).toBe("ALLERGY CHECK PASSED");
  });

  test("drops expired toast on reboot but retains shownOutcomeId to prevent resurfacing", () => {
    const persisted: OutcomeToastState = {
      shownOutcomeId: "allergy:verify:0",
      outcomeToast: {
        headline: "ALLERGY CHECK PASSED",
        tone: "safe",
        startedAt: 1000,
      },
    };

    // Reboot occurs at t=3700 (2700ms elapsed, exceeding 2600ms duration)
    const state = initOutcomeToastState(sampleOutcome, persisted, 3700);
    expect(state.shownOutcomeId).toBe("allergy:verify:0");
    expect(state.outcomeToast).toBeUndefined();
  });

  test("updateOutcomeToastState creates a new toast when a new outcome ID arrives", () => {
    const initial: OutcomeToastState = {};
    const updated = updateOutcomeToastState(initial, sampleOutcome, 1000);

    expect(updated.shownOutcomeId).toBe("allergy:verify:0");
    expect(updated.outcomeToast).toEqual({
      headline: "ALLERGY CHECK PASSED",
      tone: "safe",
      startedAt: 1000,
    });
  });

  test("updateOutcomeToastState ignores duplicate outcome ID to avoid resetting toast timer", () => {
    const active: OutcomeToastState = {
      shownOutcomeId: "allergy:verify:0",
      outcomeToast: {
        headline: "ALLERGY CHECK PASSED",
        tone: "safe",
        startedAt: 1000,
      },
    };

    // Next tick at t=1500 with same outcome ID
    const next = updateOutcomeToastState(active, sampleOutcome, 1500);
    expect(next).toBe(active);
    expect(next.outcomeToast?.startedAt).toBe(1000);
  });

  test("updateOutcomeToastState does not resurrect an expired toast if ID is identical", () => {
    const expired: OutcomeToastState = {
      shownOutcomeId: "allergy:verify:0",
      outcomeToast: undefined,
    };

    const next = updateOutcomeToastState(expired, sampleOutcome, 5000);
    expect(next).toBe(expired);
    expect(next.outcomeToast).toBeUndefined();
  });

  test("updateOutcomeToastState transitions to a new outcome once a different decision is made", () => {
    const prev: OutcomeToastState = {
      shownOutcomeId: "allergy:verify:0",
      outcomeToast: undefined,
    };

    const nextOutcome = {
      id: "emergency:fixed:1",
      headline: "OVEN REPAIRED",
      tone: "safe" as const,
    };

    const updated = updateOutcomeToastState(prev, nextOutcome, 6000);
    expect(updated.shownOutcomeId).toBe("emergency:fixed:1");
    expect(updated.outcomeToast).toEqual({
      headline: "OVEN REPAIRED",
      tone: "safe",
      startedAt: 6000,
    });
  });
});
