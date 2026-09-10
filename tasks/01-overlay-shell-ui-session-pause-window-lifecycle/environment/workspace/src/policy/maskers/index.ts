import type { ActionMasker } from "../masking.js";

/**
 * Masker registry, keyed by the same game ids as `src/games/registry.ts`.
 *
 * Only games with a policy path appear here. Trace collection is
 * game-agnostic and covers the whole arcade, but legality rules, observation
 * encodings, and action spaces are irreducibly per-game — so this stays an
 * opt-in list rather than something derived from the game registry.
 *
 * Adding a game is one entry plus its masker module. Do not generalize the
 * rules across games; they have nothing in common beyond this interface.
 */
const MASKERS: readonly ActionMasker<never, string>[] = [];

/** Masker for a registry game id, or undefined when the game has no policy path yet. */
export function maskerFor(gameId: string): ActionMasker<never, string> | undefined {
  const normalized = gameId.trim().toLowerCase();
  return MASKERS.find((masker) => masker.gameId === normalized);
}

/** Game ids that currently support masked policy play. */
export function maskedGameIds(): string[] {
  return MASKERS.map((masker) => masker.gameId);
}
