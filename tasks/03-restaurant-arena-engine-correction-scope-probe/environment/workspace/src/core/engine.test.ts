import { describe, expect, test } from "bun:test";
import { GameEngine } from "./engine.js";
import type { Game, StepResult } from "./game.js";

type State = { value: number };
type Action = "add" | "finish";

class Counter implements Game<State, Action> {
  readonly name = "counter";
  readonly actions = ["add", "finish"] as const;
  private current: State = { value: 0 };

  reset(): void { this.current = { value: 0 }; }
  step(action: Action): StepResult {
    if (action === "add") this.current.value++;
    return { reward: action === "add" ? 1 : 0, moved: true, done: action === "finish", success: action === "finish" };
  }
  state(): State { return { ...this.current }; }
  score(): number { return this.current.value; }
}

describe("GameEngine", () => {
  test("exposes seat observations/actions and records a bounded episode", () => {
    const engine = new GameEngine(new Counter(), {
      agent: {
        observe: (state) => ({ value: state.value }),
        actions: () => ["add", "finish"],
      },
    });

    expect(engine.reset(42)).toEqual({ value: 0 });
    expect(engine.actions("agent")).toEqual(["add", "finish"]);
    engine.run([
      { seat: "agent", action: "add" },
      { seat: "agent", action: "finish" },
      { seat: "agent", action: "add" },
    ]);

    expect(engine.events()).toHaveLength(2);
    expect(engine.events()[0]).toMatchObject({ sequence: 1, seat: "agent", action: "add" });
    expect(() => engine.step("agent", "add")).toThrow("already complete");
  });
});
