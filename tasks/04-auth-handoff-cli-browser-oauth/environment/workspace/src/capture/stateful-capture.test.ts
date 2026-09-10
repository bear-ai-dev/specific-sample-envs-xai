import { describe, expect, test } from "bun:test";
import { runStatefulCapture } from "./stateful-capture.js";

describe("stateful CAPTURE runner", () => {
  test("passes updated game state and memory to each model decision", async () => {
    const seen: Array<{ room: number; memory: string | null; approved: boolean }> = [];
    const result = await runStatefulCapture(async (observation) => {
      seen.push({ room: observation.room, memory: observation.memory, approved: observation.scoutingApproved });
      return observation.room === 2 && observation.scoutingApproved ? "scout" : observation.memory ? "protect" : "loot";
    });

    expect(seen).toEqual([
      { room: 1, memory: null, approved: false },
      { room: 2, memory: "Stay with me when I'm hurt", approved: true },
      { room: 3, memory: "Stay with me when I'm hurt", approved: true },
    ]);
    expect(result.decisions.map((decision) => decision.action)).toEqual(["loot", "scout", "protect"]);
    expect(result.finalState).toMatchObject({ room: 4, extracted: true, done: true });
  });
});
