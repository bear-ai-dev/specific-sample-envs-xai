import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backendConfigPath,
  clearBackendSession,
  loadBackendConfig,
  resolveBackendConfig,
  saveBackendSession,
} from "./config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveBackendConfig", () => {
  it("uses the sync backend by default when only a token is configured", () => {
    expect(resolveBackendConfig({
      GAMEPIGEON_BACKEND_TOKEN: "retro_user_token",
    })).toEqual({
      baseUrl: "https://api.runretroarcade.com",
      token: "retro_user_token",
      meUrl: "https://api.runretroarcade.com/v1/me",
      eventChunksUrl: "https://api.runretroarcade.com/v1/game-event-chunks",
      gameResultsUrl: "https://api.runretroarcade.com/v1/game-results",
    });
  });

  it("prefers the backend URL and opaque token", () => {
    expect(resolveBackendConfig({
      GAMEPIGEON_BACKEND_URL: "https://retro.example/",
      GAMEPIGEON_BACKEND_TOKEN: "retro_user_token",
      GAMEPIGEON_INGEST_URL: "https://legacy.example/v1/game-event-chunks",
      GAMEPIGEON_INGEST_API_KEY: "legacy-token",
    })).toEqual({
      baseUrl: "https://retro.example",
      token: "retro_user_token",
      meUrl: "https://retro.example/v1/me",
      eventChunksUrl: "https://retro.example/v1/game-event-chunks",
      gameResultsUrl: "https://retro.example/v1/game-results",
    });
  });

  it("supports the temporary ingest aliases as a bearer-token pair", () => {
    expect(resolveBackendConfig({
      GAMEPIGEON_INGEST_URL: "http://127.0.0.1:8000/v1/game-event-chunks",
      GAMEPIGEON_INGEST_API_KEY: "retro_legacy_user_token",
    }))?.toMatchObject({
      baseUrl: "http://127.0.0.1:8000",
      token: "retro_legacy_user_token",
      gameResultsUrl: "http://127.0.0.1:8000/v1/game-results",
    });
  });

  it("keeps remote sync disabled for incomplete configuration", () => {
    expect(resolveBackendConfig({ GAMEPIGEON_BACKEND_URL: "https://retro.example" }))
      .toBeNull();
    expect(resolveBackendConfig({})).toBeNull();
  });

  it("reloads and tightens the private backend config file", () => {
    const home = mkdtempSync(join(tmpdir(), "gamepigeon-backend-config-"));
    roots.push(home);
    const path = backendConfigPath(home);
    writeFileSync(path, "https://retro.example\nfirst-token\n", { mode: 0o666 });
    chmodSync(join(home, ".tui-gamepigeon"), 0o777);
    expect(loadBackendConfig({}, path)?.token).toBe("first-token");
    expect(statSync(join(home, ".tui-gamepigeon")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writeFileSync(path, "https://retro.example\nrotated-token\n", { mode: 0o600 });
    expect(loadBackendConfig({}, path)?.token).toBe("rotated-token");
  });

  it("allows direct environment overrides while launcher processes prefer the file", () => {
    const home = mkdtempSync(join(tmpdir(), "gamepigeon-backend-priority-"));
    roots.push(home);
    const path = backendConfigPath(home);
    writeFileSync(path, "https://file.example\nfile-token\n", { mode: 0o600 });
    const environment = {
      GAMEPIGEON_BACKEND_URL: "https://direct.example",
      GAMEPIGEON_BACKEND_TOKEN: "direct-token",
    };
    expect(loadBackendConfig(environment, path)?.token).toBe("direct-token");
    expect(loadBackendConfig({
      ...environment,
      GAMEPIGEON_BACKEND_CONFIG_PREFER_FILE: "1",
    }, path)?.token).toBe("file-token");
  });

  it("atomically stores and clears a private backend session", () => {
    const home = mkdtempSync(join(tmpdir(), "gamepigeon-backend-session-"));
    roots.push(home);
    const path = backendConfigPath(home);

    saveBackendSession("session-token", "https://retro.example/", path);
    expect(loadBackendConfig({}, path)).toMatchObject({
      baseUrl: "https://retro.example",
      token: "session-token",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    clearBackendSession(path);
    expect(loadBackendConfig({}, path)).toBeNull();
  });
});
