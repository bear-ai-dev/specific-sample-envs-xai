import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthCommand } from "./auth.js";

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

