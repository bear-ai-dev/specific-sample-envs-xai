/**
 * Pure decisions about the overlay's pause/prompt state, kept out of `app.ts`
 * so they can be unit tested without a DOM.
 */

export type PauseReason = "agent" | "game-over" | "signout" | "how-to-play" | undefined;

export interface OverlayGameState {
  /** Which screen the overlay is showing. */
  screen: string;
  /** Whether the active run has finished (`game.isOver()`). */
  gameOver: boolean;
  /** The prompt currently on screen, if any. */
  pauseReason: PauseReason;
}

/**
 * Returning to the agent from a finished run closes the game-over prompt so the
 * hidden overlay isn't left mid-dialog, but the run itself is still over. When
 * the overlay comes back into view the end-of-game UI has to be put back —
 * otherwise the board reads as an in-progress run the player can no longer move
 * (issue #141).
 *
 * Any other prompt wins: an agent pause or a sign-out confirmation is the more
 * recent, more specific thing the player is being asked about.
 */
export function shouldReopenGameOver({ screen, gameOver, pauseReason }: OverlayGameState): boolean {
  return screen === "game" && gameOver && pauseReason === undefined;
}

/**
 * Whether a game's self-running clock (any auto-advancing `tickMs`) may keep
 * ticking. Keyboard input is already blocked behind a prompt, but the timer
 * was not: opening the agent pause dialog left the loop alive, so the game
 * kept advancing (and could end) behind the dialog the player was reading.
 *
 * Every resume path funnels back through `scheduleGravity`, so this is the one
 * place that decides, and it stays false for any prompt — an agent pause, the
 * game-over card, the sign-out confirmation, or the How to Play guide.
 */
export function shouldScheduleTick({ screen, gameOver, pauseReason }: OverlayGameState): boolean {
  return screen === "game" && !gameOver && pauseReason === undefined;
}
