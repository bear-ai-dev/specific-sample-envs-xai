import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arcTabScript, isArcBundle, runAuthCommand, startOAuthCallbackServer } from "./auth.js";

const argv = process.argv;
const home = process.env.HOME;
const authUrl = process.env.GAMEPIGEON_AUTH_URL;
const fetch = globalThis.fetch;
const prompt = globalThis.prompt;

afterEach(() => {
  process.argv = argv;
  process.env.HOME = home;
  if (authUrl === undefined) delete process.env.GAMEPIGEON_AUTH_URL;
  else process.env.GAMEPIGEON_AUTH_URL = authUrl;
  globalThis.fetch = fetch;
  globalThis.prompt = prompt;
});

test("OAuth only accepts Google or GitHub", async () => {
  process.argv = ["bun", "gamepigeon", "auth", "oauth", "microsoft"];
  await expect(runAuthCommand("oauth")).rejects.toThrow("usage: gamepigeon auth oauth <google|github>");
});

test("successful password login returns only pseudonymous analytics context", async () => {
  const testHome = mkdtempSync(join(tmpdir(), "gamepigeon-auth-"));
  process.env.HOME = testHome;
  process.env.GAMEPIGEON_AUTH_URL = "https://auth.example";
  const answers = ["person@example.com", "secret"];
  globalThis.prompt = () => answers.shift() ?? "";
  globalThis.fetch = Object.assign(
    async () => new Response(JSON.stringify({
      user: { id: "usr_test", email: "person@example.com" },
    }), {
      status: 200,
      headers: { "set-auth-token": "session-secret" },
    }),
    { preconnect: fetch.preconnect },
  );

  try {
    await expect(runAuthCommand("login")).resolves.toEqual({
      kind: "signed_in",
      method: "password",
      userId: "usr_test",
    });
    expect(readFileSync(join(testHome, ".tui-gamepigeon", "backend.conf"), "utf8"))
      .toBe("https://api.runretroarcade.com\nsession-secret\n");

    await runAuthCommand("logout");
    expect(existsSync(join(testHome, ".tui-gamepigeon", "auth.json"))).toBe(false);
    expect(existsSync(join(testHome, ".tui-gamepigeon", "backend.conf"))).toBe(false);
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test("OAuth callback listener binds before ready resolves and accepts tokens", async () => {
  const callback = startOAuthCallbackServer(0);
  try {
    await callback.ready;
    const base = `http://127.0.0.1:${callback.port}`;
    const ping = await fetch(`${base}/auth/ping`);
    expect(ping.ok).toBe(true);
    expect(await ping.text()).toBe("ok");

    const tokenPromise = callback.token;
    const response = await fetch(`${base}/auth/callback?token=session-from-handoff`);
    expect(response.ok).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("You&#39;re signed in");
    expect(body).toContain("close this tab");
    await expect(tokenPromise).resolves.toBe("session-from-handoff");
  } finally {
    callback.close();
  }
});

test("OAuth callback listener tolerates a redirect that appends ?token to ?state", async () => {
  const callback = startOAuthCallbackServer(0);
  try {
    await callback.ready;
    const tokenPromise = callback.token;
    // Some hosted redirects glue `?token` onto a callback already carrying
    // `?state`; URLSearchParams alone would fold the token into the state.
    const response = await fetch(
      `http://127.0.0.1:${callback.port}/auth/callback?state=nonce?token=session-from-malformed`,
    );
    expect(response.ok).toBe(true);
    await expect(tokenPromise).resolves.toBe("session-from-malformed");
  } finally {
    callback.close();
  }
});

test("OAuth callback listener reports why a failed handoff stopped", async () => {
  const callback = startOAuthCallbackServer(0);
  try {
    await callback.ready;
    const tokenPromise = callback.token;
    const response = await fetch(
      `http://127.0.0.1:${callback.port}/auth/callback?error=access_denied`,
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Sign-in was cancelled before it finished.");
    expect(body).toContain("gamepigeon auth login");
    await expect(tokenPromise).rejects.toThrow("Sign-in was cancelled before it finished.");
  } finally {
    callback.close();
  }
});

test("OAuth callback listener escapes a hostile error description", async () => {
  const callback = startOAuthCallbackServer(0);
  try {
    await callback.ready;
    const tokenPromise = callback.token;
    const response = await fetch(
      `http://127.0.0.1:${callback.port}/auth/callback?error=bad&error_description=${
        encodeURIComponent("<script>alert(1)</script>")
      }`,
    );
    const body = await response.text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
    await expect(tokenPromise).rejects.toThrow("alert(1)");
  } finally {
    callback.close();
  }
});

test("OAuth callback listener falls back to a free port when the preferred one is taken", async () => {
  const busy = startOAuthCallbackServer(0);
  try {
    await busy.ready;
    const busyPort = busy.port;

    const callback = startOAuthCallbackServer(busyPort);
    try {
      await callback.ready;
      expect(callback.port).not.toBe(busyPort);

      const base = `http://127.0.0.1:${callback.port}`;
      const tokenPromise = callback.token;
      const response = await fetch(`${base}/auth/callback?token=session-from-fallback`);
      expect(response.ok).toBe(true);
      await expect(tokenPromise).resolves.toBe("session-from-fallback");
    } finally {
      callback.close();
    }
  } finally {
    busy.close();
  }
});

test("Arc gets a real tab over AppleScript instead of a Little Arc window", () => {
  expect(isArcBundle("company.thebrowser.Browser")).toBe(true);
  expect(isArcBundle("company.thebrowser.dia")).toBe(true);
  expect(isArcBundle("com.google.Chrome")).toBe(false);

  const script = arcTabScript("company.thebrowser.Browser", 'https://x/?q="a\\b"');
  expect(script).toContain('tell application id "company.thebrowser.Browser"');
  expect(script).toContain("make new tab with properties");
  // Quotes and backslashes in the URL must not break out of the AppleScript string.
  expect(script).toContain('URL:"https://x/?q=\\"a\\\\b\\""');
});
