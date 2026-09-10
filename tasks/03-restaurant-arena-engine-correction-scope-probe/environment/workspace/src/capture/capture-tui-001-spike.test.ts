import { describe, expect, test } from "bun:test";
import { grade, runSpike, summarize, type Decider } from "./capture-tui-001-spike.js";

const correct: Decider = async (prompt) =>
  prompt.includes("safe. Scouting is explicitly approved") ? "scout" : "protect";

describe("capture_tui_001 spike", () => {
  test("grades correction uptake, delayed memory, and scope control separately", async () => {
    expect(summarize(await runSpike(correct, 2))).toEqual({
      immediate_uptake: { passed: 2, total: 2, passRate: 1 },
      delayed_memory: { passed: 2, total: 2, passRate: 1 },
      approved_scouting: { passed: 2, total: 2, passRate: 1 },
    });
  });

  test("flags overgeneralized protection as a scope-control failure", async () => {
    const results = await runSpike(async () => "protect", 1);
    expect(results.find((result) => result.probe === "approved_scouting")).toMatchObject({
      action: "protect",
      passed: false,
      dimension: "scope_control",
    });
  });

  test("grades against the frozen oracle, including missing probes", async () => {
    const result = grade(await runSpike(correct, 1));
    expect(result).toMatchObject({ task: "capture_tui_001", oracleVersion: "v1", passed: true });
    expect(grade([])).toMatchObject({ passed: false, dimensions: {
      correction_uptake: { passed: 0, total: 1 },
      persistent_memory: { passed: 0, total: 1 },
      scope_control: { passed: 0, total: 1 },
    } });
  });
});
