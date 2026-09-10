import {
  CORRECTION,
  ProtectLootGame,
  type CompanionAction,
  type CompanionObservation,
  type ProtectLootState,
} from "../games/protect-loot/protect-loot.js";

export interface StatefulDecision {
  room: number;
  observation: CompanionObservation;
  action: CompanionAction;
  stateBefore: ProtectLootState;
  stateAfter: ProtectLootState;
}

export interface StatefulCaptureResult {
  task: "capture_tui_001";
  seed: number;
  correction: string;
  decisions: StatefulDecision[];
  finalState: ProtectLootState;
}

export type StatefulDecider = (observation: CompanionObservation) => Promise<CompanionAction>;

const TO_EXIT = ["down", "right", "right", "right", "right", "right", "right", "right", "up", "up"] as const;

/** Run a model through the actual seeded game while the player route stays reproducible. */
export async function runStatefulCapture(decide: StatefulDecider, seed = 42): Promise<StatefulCaptureResult> {
  const game = new ProtectLootGame(undefined, { autoCompanion: false });
  game.reset(seed);
  const decisions: StatefulDecision[] = [];

  const companionTurn = async (): Promise<void> => {
    const observation = game.observe();
    if (!observation) return;
    const stateBefore = game.state();
    const action = await decide(observation);
    game.companion(action);
    decisions.push({ room: observation.room, observation, action, stateBefore, stateAfter: game.state() });
  };

  const enterNextRoom = (): void => {
    const room = game.state().room;
    for (const action of TO_EXIT) {
      game.step(action);
      if (game.state().room !== room || game.isOver()) return;
    }
  };

  enterNextRoom();
  await companionTurn();
  game.step("correct");

  enterNextRoom();
  game.step("approve_scouting");
  await companionTurn();

  enterNextRoom();
  await companionTurn();

  enterNextRoom();
  enterNextRoom();
  return { task: "capture_tui_001", seed, correction: CORRECTION, decisions, finalState: game.state() };
}
