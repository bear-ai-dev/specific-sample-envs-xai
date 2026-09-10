import { describe, expect, test } from "bun:test";
import { arenaBrief, type BriefInput } from "./restaurant-arena-brief.js";

function base(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    orders: [],
    workers: [{ role: "chef", location: "kitchen" }],
    outcomes: { cash: 0, waste: 0, completed: 0 },
    sim: { started: true, running: true },
    waiting: [],
    goal: { cash: 190, maxWalkouts: 2, unsafeAllowed: 0 },
    staff: { chef: { name: "Mira" }, host: { name: "Vela" }, server: { name: "Kip" } },
    tally: { walkouts: 0, unsafeServed: 0 },
    ...overrides,
  };
}

describe("arenaBrief", () => {
  test("carries only the conditions the night is judged on", () => {
    // Waste is a debrief number and the queue is already drawn at the door;
    // neither earns a chip in a band this small.
    expect(arenaBrief(base()).chips.map((chip) => chip.label)).toEqual(["TAKINGS", "WALKOUTS", "UNVERIFIED"]);
  });

  test("reads the fail conditions against the goal, not against a fixed bar", () => {
    const brief = arenaBrief(base({ tally: { walkouts: 2, unsafeServed: 1 }, outcomes: { cash: 200, waste: 0, completed: 9 } }));
    const byLabel = new Map(brief.chips.map((chip) => [chip.label, chip]));
    expect(byLabel.get("TAKINGS")).toEqual({ label: "TAKINGS", value: "$200/$190", tone: "ok" });
    // Progress, not a fail condition: short of target is not an alarm.
    expect(arenaBrief(base()).chips[0]).toEqual({ label: "TAKINGS", value: "$0/$190", tone: "ok" });
    // Two walkouts is the last one tonight allows: a warning, not a failure.
    expect(byLabel.get("WALKOUTS")?.tone).toBe("warn");
    expect(byLabel.get("UNVERIFIED")).toEqual({ label: "UNVERIFIED", value: "1/0", tone: "bad" });
  });

  test("omits the fail-condition chips when the state carries no tally", () => {
    const brief = arenaBrief(base({ tally: undefined }));
    expect(brief.chips.map((chip) => chip.label)).toEqual(["TAKINGS"]);
  });

  test("leaves a healthy shift entirely uncoloured, so trouble has somewhere to shout from", () => {
    expect(arenaBrief(base({ outcomes: { cash: 200, waste: 0, completed: 9 } })).chips.every((chip) => chip.tone === "ok")).toBe(true);
  });

  test("an open decision outranks every other directive", () => {
    const brief = arenaBrief(
      base({
        decision: { id: "allergy_ticket", title: "Allergy ticket on the board", speaker: "Dario" },
        emergency: { kind: "oven_failure", active: true },
        waiting: [{ id: "a", size: 2 }, { id: "b", size: 2 }, { id: "c", size: 2 }],
      }),
    );
    expect(brief.nowLabel).toBe("DECIDE");
    expect(brief.now).toBe("Dario needs a call — pick an option.");
  });

  test("the training coach owns the line while it has something to teach", () => {
    const brief = arenaBrief(base({ coach: { step: 2, total: 4, title: "Rush table 1", detail: "Click the pasta ticket." } }));
    // The tag already carries the step, so the coach's title would only
    // repeat it — the instruction is what the line is for.
    expect(brief.nowLabel).toBe("STEP 2/4");
    expect(brief.now).toBe("Click the pasta ticket.");
  });

  test("an active incident names the click that clears it", () => {
    const brief = arenaBrief(base({ emergency: { kind: "oven_failure", active: true } }));
    expect(brief.nowLabel).toBe("FIX");
    expect(brief.now).toBe("oven failure — click the oven.");
  });

  test("a live allergy ticket outranks a queue at the door", () => {
    const brief = arenaBrief(
      base({
        orders: [{ id: "o1", tableId: "table-2", status: "preparing", allergy: "peanut", priority: "normal" }],
        waiting: [{ id: "a", size: 2 }, { id: "b", size: 2 }, { id: "c", size: 2 }],
      }),
    );
    expect(brief.nowLabel).toBe("SAFETY");
    expect(brief.now).toContain("table 2");
  });

  test("a queue outranks plates on the pass", () => {
    const brief = arenaBrief(
      base({
        orders: [{ id: "o1", tableId: "table-1", status: "ready", priority: "normal" }],
        waiting: [{ id: "a", size: 2 }, { id: "b", size: 2 }, { id: "c", size: 2 }],
      }),
    );
    expect(brief.nowLabel).toBe("DOOR");
    expect(brief.now).toContain("Vela");
    expect(brief.now).toContain("(H)");
  });

  test("falls back to a steady room rather than an empty line", () => {
    expect(arenaBrief(base()).nowLabel).toBe("STEADY");
  });

  test("before the doors open, the directive is how to open them", () => {
    expect(arenaBrief(base({ sim: { started: false, running: false } })).nowLabel).toBe("START");
  });

  test("carries the last decision's receipt so the consequence outlives its toast", () => {
    expect(arenaBrief(base({ lastOutcome: { headline: "Verified — plate is safe" } })).last).toBe("Verified — plate is safe");
    expect(arenaBrief(base()).last).toBeUndefined();
  });

  test("never reports a table wait, because the engine has no arrival-based one", () => {
    const brief = arenaBrief(base({ clock: { minute: 34 } }));
    const text = [brief.now, ...brief.chips.map((chip) => `${chip.label}${chip.value}`)].join(" ");
    expect(text.toLowerCase()).not.toContain("wait");
  });
});
