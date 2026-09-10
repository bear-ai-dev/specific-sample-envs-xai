import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ArcadeSettings {
  autoOpenOnPrompt: boolean;
  autoPauseOnStop: boolean;
  resetOnNewSession: boolean;
  agentBreakSuggestions: boolean;
  suggestionsSnoozedUntil: number | null;
  defaultWindowSize: "compact" | "expanded";
  resumeLastGame: boolean;
  reducedMotion: boolean | null;
  showPersonalScores: boolean;
  cloudGameplaySync: boolean;
  productAnalytics: boolean;
  recordingWhilePlaying: boolean;
}

export const DEFAULT_SETTINGS: ArcadeSettings = {
  autoOpenOnPrompt: true,
  autoPauseOnStop: true,
  resetOnNewSession: true,
  agentBreakSuggestions: true,
  suggestionsSnoozedUntil: null,
  defaultWindowSize: "compact",
  resumeLastGame: false,
  reducedMotion: null,
  showPersonalScores: true,
  cloudGameplaySync: true,
  productAnalytics: true,
  recordingWhilePlaying: true,
};

export function settingsPath(home = homedir()): string {
  return join(home, ".gamepigeon", "settings.json");
}

export function readSettings(home = homedir()): ArcadeSettings {
  try {
    const value = JSON.parse(readFileSync(settingsPath(home), "utf8")) as Partial<ArcadeSettings>;
    return { ...DEFAULT_SETTINGS, ...value };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(settings: Partial<ArcadeSettings>, home = homedir()): ArcadeSettings {
  const next = { ...readSettings(home), ...settings };
  const path = settingsPath(home);
  mkdirSync(join(home, ".gamepigeon"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return next;
}

export function suggestionsEnabled(settings = readSettings()): boolean {
  return settings.agentBreakSuggestions &&
    (settings.suggestionsSnoozedUntil === null || settings.suggestionsSnoozedUntil <= Date.now());
}
