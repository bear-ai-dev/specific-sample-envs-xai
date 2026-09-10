import { describe, expect, test } from "bun:test";
import {
  COMPACT_SIZE,
  EXPANDED_SIZE,
  MIN_SIZE,
  PILL_SIZE,
  PREVIEW_RESIZE_MESSAGE,
  isTauri,
} from "./tauri-bridge.js";

describe("tauri-bridge", () => {
  test("reports non-Tauri in the Bun test runtime", () => {
    expect(isTauri()).toBe(false);
  });

  test("exports production overlay frame sizes", () => {
    expect(COMPACT_SIZE).toEqual({ width: 600, height: 850 });
    expect(EXPANDED_SIZE).toEqual({ width: 830, height: 900 });
    expect(PILL_SIZE).toEqual({ width: 144, height: 48 });
  });

  test("the pill fits under the arcade's own minimum size", () => {
    // Collapsing only works if the min size drops below the pill first.
    expect(PILL_SIZE.width).toBeLessThan(MIN_SIZE.width);
    expect(PILL_SIZE.height).toBeLessThan(MIN_SIZE.height);
  });

  test("restoring from the pill lands back inside the arcade's floor", () => {
    expect(COMPACT_SIZE.width).toBeGreaterThanOrEqual(MIN_SIZE.width);
    expect(COMPACT_SIZE.height).toBeGreaterThanOrEqual(MIN_SIZE.height);
  });

  test("preview resize message type is stable for the shell", () => {
    expect(PREVIEW_RESIZE_MESSAGE).toBe("gamepigeon:preview-resize");
  });
});
