import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile } from "../recording/permissions.js";

export interface BackendConfig {
  baseUrl: string;
  token: string;
  meUrl: string;
  eventChunksUrl: string;
  gameResultsUrl: string;
}

export const defaultBackendBaseUrl = "https://api.runretroarcade.com";

function normalizedBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("GAMEPIGEON_BACKEND_URL must use HTTP or HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function baseFromLegacyEndpoint(value: string): string {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/v1\/game-event-chunks\/?$/, "");
  parsed.search = "";
  parsed.hash = "";
  return normalizedBaseUrl(parsed.toString());
}

export function resolveBackendConfig(
  environment: Record<string, string | undefined> = process.env,
): BackendConfig | null {
  const configuredBase = environment.GAMEPIGEON_BACKEND_URL?.trim();
  const configuredToken = environment.GAMEPIGEON_BACKEND_TOKEN?.trim();
  const legacyEndpoint = environment.GAMEPIGEON_INGEST_URL?.trim();
  const legacyToken = environment.GAMEPIGEON_INGEST_API_KEY?.trim();

  const token = configuredToken || legacyToken;
  const baseUrl = configuredBase
    ? normalizedBaseUrl(configuredBase)
    : legacyEndpoint
    ? baseFromLegacyEndpoint(legacyEndpoint)
    // Only the modern token opts into the default backend; a lone legacy key
    // was issued for a legacy endpoint and must not be sent elsewhere.
    : configuredToken
    ? defaultBackendBaseUrl
    : null;
  if (!baseUrl || !token) return null;

  return {
    baseUrl,
    token,
    meUrl: `${baseUrl}/v1/me`,
    eventChunksUrl: `${baseUrl}/v1/game-event-chunks`,
    gameResultsUrl: `${baseUrl}/v1/game-results`,
  };
}

export function backendConfigPath(home = process.env.HOME ?? homedir()): string {
  const directory = join(home, ".tui-gamepigeon");
  ensurePrivateDirectory(directory);
  return join(directory, "backend.conf");
}

export function saveBackendSession(
  token: string,
  baseUrl?: string,
  path = backendConfigPath(),
): void {
  if (!token) throw new Error("Backend session token is required");
  const normalized = normalizedBaseUrl(baseUrl ?? defaultBackendBaseUrl);
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${normalized}\n${token}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    ensurePrivateFile(path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function clearBackendSession(path = backendConfigPath()): void {
  rmSync(path, { force: true });
}

function configFromFile(path: string): BackendConfig | null {
  if (!existsSync(path)) return null;
  ensurePrivateDirectory(dirname(path));
  ensurePrivateFile(path);
  const [baseUrl, token] = readFileSync(path, "utf8").split("\n");
  if (!baseUrl?.trim() || !token?.trim()) return null;
  try {
    return resolveBackendConfig({
      GAMEPIGEON_BACKEND_URL: baseUrl,
      GAMEPIGEON_BACKEND_TOKEN: token,
    });
  } catch {
    return null;
  }
}

export function loadBackendConfig(
  environment: Record<string, string | undefined> = process.env,
  path = backendConfigPath(),
): BackendConfig | null {
  const fromEnvironment = () => resolveBackendConfig(environment);
  if (environment.GAMEPIGEON_BACKEND_CONFIG_PREFER_FILE === "1") {
    return configFromFile(path) ?? fromEnvironment();
  }
  return fromEnvironment() ?? configFromFile(path);
}
