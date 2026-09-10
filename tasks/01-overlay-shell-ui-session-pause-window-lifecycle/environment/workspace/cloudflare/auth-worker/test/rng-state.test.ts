import { describe, expect, test } from "vitest";
import { Rng } from "../../../src/core/rng.js";

describe("Rng state", () => {
  test("restores the exact subsequent value sequence", () => {
    const original = new Rng(42);
    original.next();
    original.next();

    const restored = Rng.fromState(original.exportState());

    expect(Array.from({ length: 4 }, () => restored.next())).toEqual(
      Array.from({ length: 4 }, () => original.next()),
    );
  });

  test.each([-1, 0x1_0000_0000, 1.5, NaN])(
    "rejects invalid state %s",
    (state) => {
      expect(() => Rng.fromState(state)).toThrow(RangeError);
    },
  );

  test("exports an unsigned 32-bit integer state", () => {
    const state = new Rng(42).exportState();

    expect(Number.isInteger(state)).toBe(true);
    expect(state).toBeGreaterThanOrEqual(0);
    expect(state).toBeLessThanOrEqual(0xffffffff);
  });
});
