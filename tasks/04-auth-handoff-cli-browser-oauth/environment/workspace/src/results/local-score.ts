import type { GameResultRequest } from "./types.js";

export interface LocalScoreInput
  extends Pick<GameResultRequest, "game_id" | "game_type" | "score" | "completed_at"> {
  variation_id: string;
  success: boolean;
  duration_ms: number;
  platform: "terminal" | "overlay";
}

export interface LocalScoreEntry extends LocalScoreInput {
  schema_version: 1;
  personal_best: number;
  high_score_updated: boolean;
}

export function localScoreForCompletion(input: {
  outcome: "completed" | "abandoned";
  gameId: string;
  gameType: string;
  variationId: string;
  score: number;
  success: boolean;
  endedAtMs: number;
  startedAtMs: number;
  platform: LocalScoreInput["platform"];
}): LocalScoreInput | null {
  if (input.outcome !== "completed") return null;
  return {
    game_id: input.gameId,
    game_type: input.gameType,
    variation_id: input.variationId,
    score: input.score,
    success: input.success,
    completed_at: new Date(input.endedAtMs).toISOString(),
    duration_ms: Math.max(0, input.endedAtMs - input.startedAtMs),
    platform: input.platform,
  };
}
