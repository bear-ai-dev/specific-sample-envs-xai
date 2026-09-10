import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthMethod } from "./analytics/events.js";
import { escapeHtml, signedInPage, signInFailedPage } from "./auth-pages.js";
import { clearBackendSession, saveBackendSession } from "./sync/config.js";

const oauthCallbackPort = 3210;
const oauthCallbackHost = "127.0.0.1";

function oauthCallbackUrlFor(port: number): string {
  return `http://${oauthCallbackHost}:${port}/auth/callback`;
}
const defaultAuthBaseUrl = "https://auth.runretroarcade.com";
const defaultLoginUrl = "https://runretroarcade.com/login";
const oauthProviders = ["google", "github"] as const;
type OAuthProvider = (typeof oauthProviders)[number];

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

function configuredLoginUrl(): string {
  const url = new URL(process.env.GAMEPIGEON_LOGIN_URL ?? defaultLoginUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("GAMEPIGEON_LOGIN_URL must use HTTP or HTTPS.");
  }
  return url.toString();
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

function isOAuthProvider(value: string | undefined): value is OAuthProvider {
  return oauthProviders.includes(value as OAuthProvider);
}

/**
 * Arc (and Dia, same vendor) send links from other apps into a "Little Arc"
 * window, which drops the hosted login page's redirect chain — sign-in then
 * never reaches our callback. Asking Arc for a real tab over AppleScript
 * bypasses Little Arc. Mirrors `open_in_arc` in `tauri/src/main.rs`.
 */
export function arcTabScript(bundleId: string, url: string): string {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `tell application id "${escape(bundleId)}"
    activate
    if (count of windows) is 0 then
        make new window
    end if
    tell front window to make new tab with properties {URL:"${escape(url)}"}
end tell`;
}

export function isArcBundle(bundleId: string): boolean {
  const id = bundleId.toLowerCase();
  return id === "company.thebrowser.browser" || id === "company.thebrowser.dia";
}

/** The bundle id macOS hands `https` URLs to, or null when it can't be read. */
function defaultHttpsHandler(): string | null {
  try {
    const read = spawnSync("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure"], {
      encoding: "utf8",
    });
    if (read.status !== 0 || !read.stdout) return null;
    for (const block of read.stdout.split("{")) {
      if (!block.includes("LSHandlerURLScheme = https;")) continue;
      const line = block.split("\n").find((entry) => entry.trim().startsWith("LSHandlerRoleAll = "));
      const value = line?.trim().slice("LSHandlerRoleAll = ".length).replace(/;$/, "").replace(/"/g, "");
      if (value) return value;
    }
  } catch {
    /* LaunchServices unreadable: fall through to plain `open` */
  }
  return null;
}

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    const handler = defaultHttpsHandler();
    if (handler && isArcBundle(handler)) {
      const arc = spawnSync("osascript", ["-e", arcTabScript(handler, url)], { stdio: "ignore" });
      if (arc.status === 0) return;
      // Arc refused the script (not installed where LaunchServices thinks, or
      // scripting denied): fall back to the ordinary opener below.
    }
    // Safari is the last resort: it is always present, so a broken or
    // missing default handler still gets the user to the login page.
    const open = spawnSync("open", [url], { stdio: "ignore" });
    if (open.status === 0) return;
    spawnSync("open", ["-a", "Safari", url], { stdio: "ignore" });
    return;
  }
  const command = process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const browser = spawn(command, args, { detached: true, stdio: "ignore" });
  browser.on("error", () => undefined);
  browser.unref();
}

/**
 * Reads one query parameter, tolerating both `&` and `?` separators: some
 * hosted redirects append `?token` onto a callback that already carried
 * `?state`, yielding `state=..?token=..`, which `URLSearchParams` would fold
 * into the state value. Mirrors `query_param` in `tauri/src/main.rs`.
 */
function callbackParam(query: string, key: string): string | null {
  for (const pair of query.split(/[&?]/)) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator) !== key) continue;
    const value = pair.slice(separator + 1).replace(/\+/g, " ");
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * Turns a failed handoff (`?error=...`) into a sentence worth showing. Capped
 * because it lands in both the browser page and the CLI's error output.
 */
function callbackFailure(query: string): string | null {
  const error = callbackParam(query, "error");
  if (!error) return null;
  if (error === "access_denied") return "Sign-in was cancelled before it finished.";
  const description = callbackParam(query, "error_description");
  return (description || `The login page reported an error: ${error}`).slice(0, 200);
}

function receiveOAuthCallback(port = oauthCallbackPort) {
  let server: ReturnType<typeof createServer> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const close = () => {
    if (timeout) clearTimeout(timeout);
    server?.close();
  };
  const finish = (onSettle: () => void) => {
    if (settled) return;
    settled = true;
    close();
    onSettle();
  };
  const boundPort = { value: port };
  const token = new Promise<string>((resolve, reject) => {
    server = createServer((request, response) => {
      const target = request.url ?? "/";
      const separator = target.indexOf("?");
      const path = separator === -1 ? target : target.slice(0, separator);
      const query = separator === -1 ? "" : target.slice(separator + 1);
      if (path === "/auth/ping") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok");
        return;
      }
      if (path !== "/auth/callback") {
        response.writeHead(404).end();
        return;
      }
      // The page carries a session token in its URL — keep it out of caches.
      const page = (status: number, body: string) =>
        response
          .writeHead(status, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          })
          .end(body);

      const failed = (message: string) => {
        page(400, signInFailedPage(escapeHtml(message)));
        finish(() => reject(new Error(message)));
      };

      const failure = callbackFailure(query);
      if (failure) {
        failed(failure);
        return;
      }
      const sessionToken = callbackParam(query, "token");
      if (!sessionToken) {
        failed("The login page came back without a session token.");
        return;
      }
      page(200, signedInPage());
      finish(() => resolve(sessionToken));
    });
    let triedFallbackPort = false;
    const listen = (listenPort: number) => {
      server?.listen(listenPort, oauthCallbackHost, () => {
        const address = server?.address();
        if (address && typeof address === "object") boundPort.value = address.port;
        resolveReady();
      });
    };
    server.on("error", (error: NodeJS.ErrnoException) => {
      // The preferred port may be held by a stale listener (e.g. an orphaned
      // sign-in from a prior run). Fall back to an OS-assigned port rather
      // than failing outright — the backend only checks the callback
      // hostname, not the port, so any localhost port is accepted.
      if (error.code === "EADDRINUSE" && port !== 0 && !triedFallbackPort) {
        triedFallbackPort = true;
        listen(0);
        return;
      }
      rejectReady(error);
      finish(() => reject(error));
    });
    listen(port);
    timeout = setTimeout(
      () => finish(() => reject(new Error("OAuth sign-in timed out after 5 minutes."))),
      5 * 60_000,
    );
  });
  void token.catch(() => undefined);
  return {
    token,
    ready,
    close,
    get port() {
      return boundPort.value;
    },
  };
}

/** Starts the localhost OAuth callback listener. Exported for tests. */
function startOAuthCallbackServer(port = oauthCallbackPort) {
  return receiveOAuthCallback(port);
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

export type { AuthUser, OAuthProvider, StoredSession };
export { startOAuthCallbackServer };

export function authConfigured(): boolean {
  return Boolean(configuredAuthBaseUrl());
}

export function storedSession(): StoredSession | null {
  return readSession();
}

export function storedUserId(): string | null {
  return readSession()?.user.id ?? null;
}

/** Browser OAuth for Google/GitHub. Used by the CLI and the Tui login screen. */
export async function signInWithOAuth(
  provider: OAuthProvider,
  options: { onUrl?: (url: string) => void; signal?: AbortSignal } = {},
): Promise<AuthUser> {
  if (!isOAuthProvider(provider)) {
    throw new Error("usage: gamepigeon auth oauth <google|github>");
  }
  if (options.signal?.aborted) {
    throw new Error("OAuth sign-in cancelled.");
  }
  const callback = receiveOAuthCallback();
  const cancelled = () => new Error("OAuth sign-in cancelled.");
  const whenAborted = <T>() =>
    new Promise<T>((_, reject) => {
      if (!options.signal) return;
      if (options.signal.aborted) {
        reject(cancelled());
        return;
      }
      options.signal.addEventListener("abort", () => reject(cancelled()), { once: true });
    });
  const onAbort = () => callback.close();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await (options.signal
      ? Promise.race([callback.ready, whenAborted<void>()])
      : callback.ready);
    if (options.signal?.aborted) throw cancelled();
    const start = new URL("/cli/oauth", `${requireAuthBaseUrl()}/`);
    start.searchParams.set("provider", provider);
    start.searchParams.set("next", oauthCallbackUrlFor(callback.port));
    options.onUrl?.(start.toString());
    openBrowser(start.toString());
    const sessionToken = options.signal
      ? await Promise.race([callback.token, whenAborted<string>()])
      : await callback.token;
    const user = await resolveUser(sessionToken);
    saveSession(sessionToken, user);
    return user;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    callback.close();
  }
}

/** Opens the shared Tui login page for sign-in, sign-up, or OAuth. */
export async function signInOnWeb(
  options: { onUrl?: (url: string) => void } = {},
): Promise<AuthUser> {
  const callback = receiveOAuthCallback();
  try {
    await callback.ready;
    const login = new URL(configuredLoginUrl());
    login.searchParams.set("auth_url", requireAuthBaseUrl());
    login.searchParams.set("callback", oauthCallbackUrlFor(callback.port));
    login.searchParams.set("plugin", "1");
    options.onUrl?.(login.toString());
    openBrowser(login.toString());
    const sessionToken = await callback.token;
    const user = await resolveUser(sessionToken);
    saveSession(sessionToken, user);
    return user;
  } finally {
    callback.close();
  }
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

export async function ensureSignedIn(): Promise<AuthUser> {
  const user = await refreshSessionIfPresent();
  if (user) return user;
  return signInOnWeb({
    onUrl: (url) => console.log(`Opening Tui sign-in. If your browser does not open, paste this URL:\n${url}`),
  });
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

  if (action === "oauth") {
    const provider = process.argv[4];
    if (!isOAuthProvider(provider)) {
      throw new Error("usage: gamepigeon auth oauth <google|github>");
    }
    const user = await signInWithOAuth(provider, {
      onUrl: (url) => {
        console.log(`Opening ${provider} sign-in. If your browser does not open, paste this URL:\n${url}`);
      },
    });
    console.log(`Signed in as ${user.email}`);
    return { kind: "signed_in", method: provider, userId: user.id };
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

  throw new Error("usage: gamepigeon auth [signup|login|oauth|status|logout]");
}
