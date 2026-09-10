export interface GameResultRequest {
  result_id: string;
  game_id: string;
  game_type: string;
  score: number;
  completed_at: string;
}

export interface GameResultAcknowledgment {
  accepted: true;
  personal_best: number;
  high_score_updated: boolean;
}

export interface PersistedGameResult {
  userId: string;
  request: GameResultRequest;
  path: string;
  bytes: string;
}
