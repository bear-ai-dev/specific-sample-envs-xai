import { describe, expect, test } from "bun:test";
import {
  CLEAR,
  readWorkerBudgetSignal,
  shouldReportFallback,
  workerBudgetHoldMs,
  workerBudgetMessage,
  type WorkerBudgetState,
} from "./worker-budget.js";

const LABEL = "nvidia · kimi-k3";

describe("reading a transport report", () => {
  test("recognizes a queued request and its wait", () => {
    expect(readWorkerBudgetSignal({ state: "waiting", seconds: 15 })).toEqual({ kind: "waiting", seconds: 15 });
  });

  test("recognizes a provider throttle", () => {
    expect(readWorkerBudgetSignal({ state: "throttled", seconds: 60 })).toEqual({ kind: "throttled", seconds: 60 });
  });

  test("clears on admission", () => {
    expect(readWorkerBudgetSignal({ state: "ready", seconds: 0 })).toEqual(CLEAR);
  });

  test("floors a sub-second wait at 1s rather than showing a stuck 0s", () => {
    expect(readWorkerBudgetSignal({ state: "waiting", seconds: 0.4 })).toEqual({ kind: "waiting", seconds: 1 });
  });

  test("drops anything that is not one of our reports", () => {
    // Any script on the page can fire this event name; a banner claiming a
    // wait that is not happening is worse than no banner.
    for (const detail of [undefined, null, "waiting", 12, {}, { state: "broken" }, { state: 7 }]) {
      expect(readWorkerBudgetSignal(detail)).toBeUndefined();
    }
  });

  test("survives a report with no usable seconds", () => {
    expect(readWorkerBudgetSignal({ state: "waiting" })).toEqual({ kind: "waiting", seconds: 1 });
    expect(readWorkerBudgetSignal({ state: "throttled", seconds: Number.NaN })).toEqual({ kind: "throttled", seconds: 1 });
  });
});

describe("what the banner says", () => {
  test("names the account, not the crew, while queued", () => {
    expect(workerBudgetMessage({ kind: "waiting", seconds: 15 }, LABEL)).toBe(
      "Waiting for the shared model account — 15s · nvidia · kimi-k3",
    );
  });

  test("says a throttle is a retry, not a failure", () => {
    expect(workerBudgetMessage({ kind: "throttled", seconds: 60 }, LABEL)).toBe(
      "Shared model account is rate limited — retrying in 60s · nvidia · kimi-k3",
    );
  });

  test("says nothing when nothing is holding requests back", () => {
    expect(workerBudgetMessage(CLEAR, LABEL)).toBeUndefined();
  });
});

describe("whether an error means the crew broke", () => {
  test("a held-back shift is not reported as a fallback", () => {
    // #281 acceptance: waiting states have to be understandable. A queued
    // crew rendered as `Fallback` reads as a broken game and stops a tester.
    for (const state of [{ kind: "waiting", seconds: 15 }, { kind: "throttled", seconds: 60 }] as WorkerBudgetState[]) {
      expect(shouldReportFallback(state)).toBe(false);
    }
  });

  test("an error with nothing holding requests back is a real fallback", () => {
    expect(shouldReportFallback(CLEAR)).toBe(true);
  });
});

describe("how long the banner stands on its own", () => {
  test("holds for exactly the wait it describes", () => {
    expect(workerBudgetHoldMs({ kind: "throttled", seconds: 60 })).toBe(60_000);
    expect(workerBudgetHoldMs({ kind: "waiting", seconds: 15 })).toBe(15_000);
  });

  test("a cleared state arms no timer", () => {
    expect(workerBudgetHoldMs(CLEAR)).toBe(0);
  });
});
