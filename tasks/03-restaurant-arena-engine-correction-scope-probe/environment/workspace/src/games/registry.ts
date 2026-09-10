import type { Game, GameVariation } from "../core/game.js";
import { RestaurantGame } from "./restaurant-arena/restaurant-game.js";

/**
 * Central game registry. The menu, the CLI (`gamepigeon <id>`), and any
 * future launcher all read from here — adding a game is one entry.
 * Entries without a factory show up as "coming soon" and can't be launched.
 */

/** What the TUI shell needs beyond the core gym-style contract. */
export interface PlayableGame extends Game<unknown, string> {
  isOver(): boolean;
  hasWon(): boolean;
  /**
   * Auto-advance interval in ms. Games that implement this must accept a
   * "tick" action; the shell steps it on this cadence.
   */
  tickMs?(): number;
  /**
   * Optional key → action translation so action ids can stay semantic
   * ("reveal") while keys stay generic ("space"). Keys are logical key
   * names, single lowercase chars, or "space".
   */
  readonly keymap?: Readonly<Record<string, string>>;
  /** Full engine state for privileged replay checkpoints, when it exceeds the visible state. */
  checkpointState?(): unknown;
}

export interface GameEntry {
  /** Stable id used for CLI launch (`gamepigeon restaurant-arena`) and lookups. */
  id: string;
  /** Version of the game rules/state contract captured in recordings. */
  version: string;
  title: string;
  /** One-liner shown next to the title in the menu. */
  description: string;
  /** Null while the game is still in development ("coming soon"). */
  create: ((variationId?: string) => PlayableGame) | null;
  variations: readonly GameVariation[];
}

export const FEATURED_GAME_IDS = ["restaurant-arena"] as const;

export const REGISTRY: readonly GameEntry[] = [
  {
    id: "restaurant-arena",
    version: "1",
    title: "Restaurant Arena",
    description: "Manage a bustling dinner rush with model-driven workers.",
    create: (variationId) => new RestaurantGame(undefined, variationId),
    variations: RestaurantGame.VARIATIONS,
  },
];

/** The consumer product exposes the featured launch games. */
export const MENU_GAMES = REGISTRY;

export function isPlayable(entry: GameEntry): boolean {
  return entry.create !== null;
}

/** Case-insensitive lookup by registry id. */
export function findGame(id: string): GameEntry | undefined {
  const norm = id.trim().toLowerCase();
  return REGISTRY.find((e) => e.id === norm);
}

export function playableGames(): GameEntry[] {
  return REGISTRY.filter(isPlayable);
}
