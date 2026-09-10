import { describe, expect, test } from "bun:test";
import { RepaintGate } from "./restaurant-arena-repaint-gate.js";

describe("RepaintGate", () => {
  test("paints straight through when nothing is being dragged", () => {
    const gate = new RepaintGate();
    expect(gate.requestPaint()).toBe(true);
    expect(gate.requestPaint()).toBe(true);
  });

  test("holds repaints back during a drag and replays one at the end", () => {
    const gate = new RepaintGate();
    gate.beginDrag();
    expect(gate.requestPaint()).toBe(false);
    expect(gate.requestPaint()).toBe(false);
    // Several ticks were withheld, but only one repaint is owed.
    expect(gate.endDrag()).toBe(true);
    expect(gate.requestPaint()).toBe(true);
  });

  test("owes nothing when a drag ends without a state update", () => {
    const gate = new RepaintGate();
    gate.beginDrag();
    expect(gate.endDrag()).toBe(false);
  });

  test("a resize mid-drag abandons the drag so the floor keeps updating", () => {
    const gate = new RepaintGate();
    gate.beginDrag();
    gate.requestPaint();

    // The resize repaints from scratch, destroying the dragged token, so
    // `dragend` will never arrive. If the gate stayed in the drag state here,
    // every later update would be queued and the floor would freeze.
    gate.resize();

    expect(gate.isDragging).toBe(false);
    expect(gate.requestPaint()).toBe(true);
    expect(gate.requestPaint()).toBe(true);
  });

  test("a late dragend after a resize does not force a stale repaint", () => {
    const gate = new RepaintGate();
    gate.beginDrag();
    gate.requestPaint();
    gate.resize();
    expect(gate.endDrag()).toBe(false);
  });
});
