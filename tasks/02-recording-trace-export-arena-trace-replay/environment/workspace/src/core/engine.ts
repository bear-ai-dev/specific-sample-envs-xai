import type { Game, StepResult } from "./game.js";

export interface Seat<State, Action extends string> {
  observe?: (state: State, game: Game<State, Action>) => unknown;
  actions?: (state: State, game: Game<State, Action>) => readonly Action[];
}

export interface EngineTurn<Action extends string> {
  seat: string;
  action: Action;
}

export interface EngineEvent<State, Action extends string> {
  sequence: number;
  seat: string;
  action: Action;
  stateBefore: State;
  result: StepResult;
  stateAfter: State;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Deterministic, replayable episode runner for humans and agents. */
export class GameEngine<State, Action extends string> {
  private readonly seats: Readonly<Record<string, Seat<State, Action>>>;
  private episodeSeed = 0;
  private sequence = 0;
  private episodeEvents: EngineEvent<State, Action>[] = [];

  constructor(
    readonly game: Game<State, Action>,
    seats: Readonly<Record<string, Seat<State, Action>>> = {},
  ) {
    this.seats = { player: {}, ...seats };
  }

  reset(seed: number): unknown {
    this.episodeSeed = seed;
    this.sequence = 0;
    this.episodeEvents = [];
    this.game.reset(seed);
    return this.observe();
  }

  observe(seat = "player"): State | unknown {
    const definition = this.seat(seat);
    const state = this.game.state();
    return copy(definition.observe?.(state, this.game) ?? state);
  }

  actions(seat = "player"): readonly Action[] {
    const definition = this.seat(seat);
    const state = this.game.state();
    return [...(definition.actions?.(state, this.game) ?? this.game.actions)];
  }

  step(seat: string, action: Action): StepResult {
    if (this.episodeEvents.at(-1)?.result.done) throw new Error("Episode is already complete");
    if (!this.actions(seat).includes(action)) throw new Error(`Action "${action}" is not available to seat "${seat}"`);
    const stateBefore = copy(this.game.state());
    const result = this.game.step(action);
    const stateAfter = copy(this.game.state());
    this.episodeEvents.push({
      sequence: ++this.sequence,
      seat,
      action,
      stateBefore,
      result: copy(result),
      stateAfter,
    });
    return result;
  }

  run(turns: Iterable<EngineTurn<Action>>): readonly EngineEvent<State, Action>[] {
    for (const turn of turns) {
      if (this.episodeEvents.at(-1)?.result.done) break;
      this.step(turn.seat, turn.action);
    }
    return this.events();
  }

  events(): readonly EngineEvent<State, Action>[] {
    return copy(this.episodeEvents);
  }

  seed(): number {
    return this.episodeSeed;
  }

  private seat(id: string): Seat<State, Action> {
    const definition = this.seats[id];
    if (!definition) throw new Error(`Unknown seat "${id}"`);
    return definition;
  }
}
