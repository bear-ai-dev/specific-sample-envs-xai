import type { GameEntry, PlayableGame } from "../src/games/registry.js";

const STORAGE_KEY = "gamepigeon.arcade.active-game.v1";
const MAX_ACTIONS = 50_000;

export interface SavedGame {
  schemaVersion: 1;
  ownerId: string;
  gameId: string;
  gameVersion: string;
  variationId: string;
  seed: number;
  actions: string[];
}

export interface RestoredGame {
  game: PlayableGame;
  actions: string[];
}

function validSavedGame(value: unknown): value is SavedGame {
  if (!value || typeof value !== "object") return false;
  const saved = value as Partial<SavedGame>;
  return saved.schemaVersion === 1
    && typeof saved.ownerId === "string"
    && typeof saved.gameId === "string"
    && typeof saved.gameVersion === "string"
    && typeof saved.variationId === "string"
    && Number.isInteger(saved.seed)
    && Array.isArray(saved.actions)
    && saved.actions.length <= MAX_ACTIONS
    && saved.actions.every((action) => typeof action === "string");
}

export function loadSavedGame(storage: Storage = localStorage): SavedGame | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved: unknown = JSON.parse(raw);
    return validSavedGame(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** Rebuild only actions that remain accepted by this version of the game. */
export function restoreGame(entry: GameEntry, saved: SavedGame): RestoredGame | null {
  if (!entry.create || saved.gameId !== entry.id || saved.gameVersion !== entry.version) return null;
  const game = entry.create(saved.variationId);
  game.reset(saved.seed);
  const actions: string[] = [];
  for (const action of saved.actions) {
    if (!(game.actions as readonly string[]).includes(action)) return null;
    if (game.step(action).moved) actions.push(action);
  }
  return { game, actions };
}
