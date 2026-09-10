import { describe, expect, it } from "bun:test";
import { Rng } from "../core/rng.js";
import {
  MaskShapeError,
  NO_LEGAL_ACTION,
  applyMask,
  argmaxMasked,
  countLegal,
  isTerminalMask,
  maskedActions,
  maskedSoftmax,
  randomLegalAction,
  sampleMasked,
} from "./masking.js";

const ACTIONS = ["up", "down", "left", "right"] as const;

describe("applyMask", () => {
  it("drives illegal logits to -Infinity and leaves legal ones untouched", () => {
    expect(applyMask([1, 2, 3, 4], [true, false, true, false])).toEqual([
      1,
      Number.NEGATIVE_INFINITY,
      3,
      Number.NEGATIVE_INFINITY,
    ]);
  });

  it("rejects a mask that does not match the logits", () => {
    expect(() => applyMask([1, 2, 3], [true, false])).toThrow(MaskShapeError);
  });
});

describe("maskedSoftmax", () => {
  it("gives illegal actions exactly zero probability", () => {
    const probabilities = maskedSoftmax([10, 1, 1, 1], [false, true, true, true]);
    expect(probabilities[0]).toBe(0);
    // The remaining three had equal logits, so the mass splits evenly.
    expect(probabilities[1]).toBeCloseTo(1 / 3, 12);
    expect(probabilities[2]).toBeCloseTo(1 / 3, 12);
    expect(probabilities[3]).toBeCloseTo(1 / 3, 12);
  });

  it("sums to one over the legal actions", () => {
    const probabilities = maskedSoftmax([0.5, -2, 3, 1], [true, true, false, true]);
    const total = probabilities.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it("does not overflow on large logits", () => {
    const probabilities = maskedSoftmax([1000, 999, 1, 1], [true, true, false, false]);
    expect(probabilities.every(Number.isFinite)).toBe(true);
    expect(probabilities[0]).toBeGreaterThan(probabilities[1]!);
  });

  it("returns zeros rather than NaN when every action is illegal", () => {
    const probabilities = maskedSoftmax([1, 2, 3, 4], [false, false, false, false]);
    expect(probabilities).toEqual([0, 0, 0, 0]);
    expect(probabilities.some(Number.isNaN)).toBe(false);
  });
});

describe("argmaxMasked", () => {
  it("ignores a high-scoring illegal action", () => {
    expect(argmaxMasked(ACTIONS, [99, 1, 5, 2], [false, true, true, true])).toBe("left");
  });

  it("returns NO_LEGAL_ACTION in a terminal state", () => {
    expect(argmaxMasked(ACTIONS, [1, 2, 3, 4], [false, false, false, false])).toBe(NO_LEGAL_ACTION);
  });
});

describe("sampleMasked", () => {
  it("never samples an illegal action across many draws", () => {
    const rng = new Rng(7);
    const mask = [false, true, false, true];
    for (let draw = 0; draw < 5000; draw++) {
      const action = sampleMasked(ACTIONS, [50, 0, 50, 0], mask, rng);
      expect(action === "down" || action === "right").toBe(true);
    }
  });

  it("is reproducible from the seed", () => {
    const draw = (): string[] => {
      const rng = new Rng(42);
      return Array.from(
        { length: 20 },
        () => sampleMasked(ACTIONS, [1, 2, 3, 4], [true, true, true, false], rng) ?? "none",
      );
    };
    expect(draw()).toEqual(draw());
  });

  it("returns NO_LEGAL_ACTION in a terminal state", () => {
    expect(sampleMasked(ACTIONS, [1, 2, 3, 4], [false, false, false, false], new Rng(1))).toBe(
      NO_LEGAL_ACTION,
    );
  });
});

describe("randomLegalAction", () => {
  it("only ever returns legal actions", () => {
    const rng = new Rng(3);
    for (let draw = 0; draw < 2000; draw++) {
      expect(randomLegalAction(ACTIONS, [true, false, false, true], rng)).toMatch(/^(up|right)$/);
    }
  });

  it("covers every legal action given enough draws", () => {
    const rng = new Rng(11);
    const seen = new Set<string>();
    for (let draw = 0; draw < 500; draw++) {
      const action = randomLegalAction(ACTIONS, [true, true, false, true], rng);
      if (action) seen.add(action);
    }
    expect([...seen].sort()).toEqual(["down", "right", "up"]);
  });

  it("returns NO_LEGAL_ACTION in a terminal state", () => {
    expect(randomLegalAction(ACTIONS, [false, false, false, false], new Rng(1))).toBe(
      NO_LEGAL_ACTION,
    );
  });
});

describe("mask helpers", () => {
  it("reports terminal masks and legal counts", () => {
    expect(isTerminalMask([false, false])).toBe(true);
    expect(isTerminalMask([false, true])).toBe(false);
    expect(countLegal([true, false, true, true])).toBe(3);
  });

  it("filters actions in action-space order", () => {
    expect(maskedActions(ACTIONS, [false, true, true, false])).toEqual(["down", "left"]);
  });
});
