import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthMethod } from "./analytics/events.js";
import { clearBackendSession, saveBackendSession } from "./sync/config.js";

const defaultAuthBaseUrl = "https://auth.runretroarcade.com";

interface AuthUser {
  id: string;
  email: string;
}

interface StoredSession {
  sessionToken: string;
  user: AuthUser;
}

interface AuthJson {
  user?: AuthUser;
  session?: { token?: string } | null;
  token?: string;
  url?: string;
  redirect?: boolean;
  message?: string;
  error?: string | { message?: string };
}

export interface AuthSuccess {
  kind: "signed_up" | "signed_in";
  method: AuthMethod;
  userId?: string;
}

function configuredAuthBaseUrl(): string {
  return (process.env.GAMEPIGEON_AUTH_URL ?? process.env.CLOUDFLARE_AUTH_URL ?? defaultAuthBaseUrl)
    .replace(/\/$/, "");
}

function sessionFile(): string {
  return join(process.env.HOME ?? homedir(), ".tui-gamepigeon", "auth.json");
}

function readSession(): StoredSession | null {
  try {
    const raw = JSON.parse(readFileSync(sessionFile(), "utf8")) as Partial<StoredSession> & {
      refreshToken?: string;
    };
    if (raw.sessionToken && raw.user?.id && raw.user.email) {
      return { sessionToken: raw.sessionToken, user: { id: raw.user.id, email: raw.user.email } };
    }
    return null;
  } catch {
    return null;
  }
}

function saveSession(sessionToken: string, user: AuthUser): void {
  if (!sessionToken) throw new Error("Auth did not return a session token.");
  if (!user.id || !user.email) throw new Error("Auth did not return a user.");
  const file = sessionFile();
  mkdirSync(join(process.env.HOME ?? homedir(), ".tui-gamepigeon"), { recursive: true });
  writeFileSync(file, JSON.stringify({ sessionToken, user: { id: user.id, email: user.email } }));
  chmodSync(file, 0o600);
  saveBackendSession(sessionToken, process.env.GAMEPIGEON_BACKEND_URL);
}

function requireAuthBaseUrl(): string {
  const authBaseUrl = configuredAuthBaseUrl();
  if (!authBaseUrl) {
    throw new Error("Set GAMEPIGEON_AUTH_URL (Cloudflare Worker URL) before using auth.");
  }
  return authBaseUrl;
}

function authApi(path: string): string {
  return `${requireAuthBaseUrl()}/api/auth${path}`;
}

function errorMessage(payload: AuthJson | null, fallback: string): string {
  if (!payload) return fallback;
  if (typeof payload.error === "string" && payload.error) return payload.error;
  if (payload.error && typeof payload.error === "object" && payload.error.message) {
    return payload.error.message;
  }
  if (payload.message) return payload.message;
  return fallback;
}

async function authRequest(
  path: string,
  init: RequestInit = {},
  sessionToken?: string,
): Promise<{ response: Response; json: AuthJson | null; sessionToken: string | null }> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  if (sessionToken) headers.set("authorization", `Bearer ${sessionToken}`);

  const response = await fetch(authApi(path), { ...init, headers });
  const text = await response.text();
  let json: AuthJson | null = null;
  if (text) {
    try {
      json = JSON.parse(text) as AuthJson;
    } catch {
      json = null;
    }
  }
  return {
    response,
    json,
    sessionToken: response.headers.get("set-auth-token"),
  };
}

async function ask(label: string, secret = false): Promise<string> {
  process.stdout.write(label);
  if (!secret || !process.stdin.isTTY) return (prompt() ?? "").trim();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) process.exit(130);
        if (byte === 10 || byte === 13) {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if ((byte === 8 || byte === 127) && value) value = value.slice(0, -1);
        else if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}

async function resolveUser(sessionToken: string): Promise<AuthUser> {
  const { response, json } = await authRequest("/get-session", { method: "GET" }, sessionToken);
  if (!response.ok || !json?.user?.id || !json.user.email) {
    throw new Error(errorMessage(json, "Could not load the signed-in user."));
  }
  return { id: json.user.id, email: json.user.email };
}

export type { AuthUser, StoredSession };

export function authConfigured(): boolean {
  return Boolean(configuredAuthBaseUrl());
}

export function storedSession(): StoredSession | null {
  return readSession();
}

export function storedUserId(): string | null {
  return readSession()?.user.id ?? null;
}

/**
 * Validates a persisted session against the backend, dropping it if it no
 * longer resolves. Never opens a browser — safe to call from automated paths
 * (e.g. a hook that runs on every prompt) without surprising the user with a
 * sign-in tab. Returns null when there's no session to refresh.
 */
export async function refreshSessionIfPresent(): Promise<AuthUser | null> {
  const session = readSession();
  if (!session) return null;
  try {
    const user = await resolveUser(session.sessionToken);
    saveSession(session.sessionToken, user);
    return user;
  } catch {
    rmSync(sessionFile(), { force: true });
    clearBackendSession();
    return null;
  }
}

export async function signOutLocal(): Promise<void> {
  const session = readSession();
  try {
    if (session) {
      await authRequest("/sign-out", { method: "POST", body: "{}" }, session.sessionToken);
    }
  } finally {
    rmSync(sessionFile(), { force: true });
    clearBackendSession();
  }
}

export async function runAuthCommand(action?: string): Promise<AuthSuccess | null> {
  if (action === "status" || !action) {
    const session = readSession();
    console.log(session ? `Signed in as ${session.user.email}` : "Not signed in");
    return null;
  }

  if (action === "logout") {
    await signOutLocal();
    console.log("Signed out. Local games were not changed.");
    return null;
  }

  const email = await ask("Email: ");
  const password = await ask("Password: ", true);

  if (action === "login") {
    const { response, json, sessionToken } = await authRequest("/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok || !sessionToken) {
      throw new Error(errorMessage(json, "Sign in failed."));
    }
    const user = json?.user?.id && json.user.email
      ? { id: json.user.id, email: json.user.email }
      : await resolveUser(sessionToken);
    saveSession(sessionToken, user);
    console.log(`Signed in as ${user.email}`);
    return { kind: "signed_in", method: "password", userId: user.id };
  }

  if (action === "signup") {
    const name = await ask("Name (optional): ");
    const { response, json, sessionToken } = await authRequest("/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password, name: name || email.split("@")[0] }),
    });
    if (!response.ok) {
      throw new Error(errorMessage(json, "Sign up failed."));
    }
    if (!sessionToken) {
      console.log("Account created. If email verification is enabled, verify then run: gamepigeon auth login");
      return { kind: "signed_up", method: "password", userId: json?.user?.id };
    }
    const user = json?.user?.id && json.user.email
      ? { id: json.user.id, email: json.user.email }
      : await resolveUser(sessionToken);
    saveSession(sessionToken, user);
    console.log(`Signed up as ${user.email}`);
    return { kind: "signed_up", method: "password", userId: user.id };
  }

  throw new Error("usage: gamepigeon auth [signup|login|status|logout]");
}

