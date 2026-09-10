import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, readSettings, settingsPath, suggestionsEnabled, writeSettings } from "./settings.js";

describe("arcade settings", () => {
  test("merges defaults and writes a private atomic settings file", () => {
    const home = mkdtempSync(join(tmpdir(), "gamepigeon-settings-"));
    expect(readSettings(home)).toEqual(DEFAULT_SETTINGS);
    writeSettings({ autoOpenOnPrompt: false }, home);
    expect(readSettings(home).autoOpenOnPrompt).toBe(false);
    expect(statSync(settingsPath(home)).mode & 0o777).toBe(0o600);
  });

  test("snooze gates suggestions until its timestamp", () => {
    expect(suggestionsEnabled({ ...DEFAULT_SETTINGS, agentBreakSuggestions: false })).toBe(false);
    expect(suggestionsEnabled({ ...DEFAULT_SETTINGS, suggestionsSnoozedUntil: Date.now() + 60_000 })).toBe(false);
    expect(suggestionsEnabled({ ...DEFAULT_SETTINGS, suggestionsSnoozedUntil: Date.now() - 1 })).toBe(true);
  });
});
