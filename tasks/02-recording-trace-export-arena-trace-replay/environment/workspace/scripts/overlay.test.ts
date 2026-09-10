import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  adapterCheckHarness,
  applyOverlayLease,
  isSteadyStateLaunch,
  ensureOverlayBinary,
  linuxReleaseDistro,
  managedBinaryPath,
  overlayBinaryCandidates,
  overlayExecutableName,
  overlayReleaseAsset,
  ownsUpdateCheck,
  parseAction,
  readReleaseManifest,
  resolveOverlayBinary,
  setOverlayLease,
  shouldRunAction,
} from "./overlay.js";

describe("overlay launcher", () => {
  test("settings gate automatic lifecycle actions", () => {
    expect(shouldRunAction("show", { autoOpenOnPrompt: false, autoPauseOnStop: true, resetOnNewSession: true } as any)).toBe(false);
    expect(shouldRunAction("pause", { autoOpenOnPrompt: true, autoPauseOnStop: false, resetOnNewSession: true } as any)).toBe(false);
    expect(shouldRunAction("reset", { autoOpenOnPrompt: true, autoPauseOnStop: true, resetOnNewSession: false } as any)).toBe(false);
    expect(shouldRunAction("enable", { autoOpenOnPrompt: false, autoPauseOnStop: false, resetOnNewSession: false } as any)).toBe(true);
  });
  test("opens only when the user submits a prompt; new sessions reset without popping the window open", () => {
    const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
    expect(hooks.SessionStart[0].hooks.map((hook: { command: string; args: string[] }) => [hook.command, ...hook.args])).toEqual([
      ["node", "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-bun.cjs", "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-update.ts", "--check"],
      ["node", "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-bun.cjs", "${CLAUDE_PLUGIN_ROOT}/scripts/overlay.ts", "--reset"],
      ["node", "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-bun.cjs", "${CLAUDE_PLUGIN_ROOT}/scripts/arcade-engagement.ts", "--reset"],
    ]);
    expect(hooks.UserPromptSubmit[0].hooks.map((hook: { command: string; args: string[] }) => [hook.command, ...hook.args])).toEqual([
      ["node", "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-bun.cjs", "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-update.ts", "--nudge"],
      ["node", "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-bun.cjs", "${CLAUDE_PLUGIN_ROOT}/scripts/arcade-engagement.ts", "--deliver"],
      ["node", "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-bun.cjs", "${CLAUDE_PLUGIN_ROOT}/scripts/overlay.ts", "--show"],
    ]);
    // The overlay stays visible across turns; Stop pauses active gameplay. The
    // engagement nudge only *arms* here and prints nothing: a Stop hook's
    // additionalContext renders to the user as "Stop hook feedback: ...", so the
    // UserPromptSubmit handler above is what actually delivers it.
    expect(hooks.Stop[0].hooks.map((hook: { command: string; args: string[] }) => [hook.command, ...hook.args])).toEqual([
      ["node", "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-bun.cjs", "${CLAUDE_PLUGIN_ROOT}/scripts/overlay.ts", "--pause"],
      ["node", "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-bun.cjs", "${CLAUDE_PLUGIN_ROOT}/scripts/arcade-engagement.ts", "--arm"],
    ]);
  });

  test("ships an accessible full-window state for confirmed updates", () => {
    const html = readFileSync(new URL("../overlay/dist/index.html", import.meta.url), "utf8");
    expect(html).toContain('id="update-loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("Keep Tui open — your game will restart automatically when finished.");
  });

  test("accepts lifecycle actions and legacy hook aliases", () => {
    expect(parseAction([])).toBe("show");
    expect(parseAction(["--enable"])).toBe("enable");
    expect(parseAction(["--pause"])).toBe("pause");
    expect(parseAction(["--reset"])).toBe("reset");
    expect(parseAction(["--stop"])).toBe("quit");
    expect(() => parseAction(["--unknown"])).toThrow("Unknown overlay action");
  });

  test("session cleanup removes the lease watched by every overlay process", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gamepigeon-lease-")), "overlay.alive");
    setOverlayLease(true, path);
    expect(existsSync(path)).toBe(true);
    setOverlayLease(false, path);
    expect(existsSync(path)).toBe(false);
  });

  test("reset keeps the overlay lease alive while quit clears it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gamepigeon-lease-")), "overlay.alive");
    setOverlayLease(true, path);
    applyOverlayLease("reset", path);
    expect(existsSync(path)).toBe(true);
    applyOverlayLease("quit", path);
    expect(existsSync(path)).toBe(false);
  });

  test("prefers a packaged platform binary", () => {
    const root = mkdtempSync(join(tmpdir(), "gamepigeon-overlay-"));
    const candidate = overlayBinaryCandidates(root).find((path) => path.startsWith(join(root, "bin")))!;
    mkdirSync(dirname(candidate), { recursive: true });
    writeFileSync(candidate, "");
    if (process.platform !== "win32") chmodSync(candidate, 0o755);
    expect(resolveOverlayBinary(root)).toBe(candidate);
  });

  test("reads the release manifest committed by CI and ignores missing or malformed ones", () => {
    const root = mkdtempSync(join(tmpdir(), "gamepigeon-overlay-"));
    expect(readReleaseManifest(root)).toBeNull();
    writeFileSync(join(root, "overlay-release.json"), "not json");
    expect(readReleaseManifest(root)).toBeNull();
    writeFileSync(join(root, "overlay-release.json"), JSON.stringify({ tag: "overlay-abc1234", version: "abc1234" }));
    expect(readReleaseManifest(root)).toEqual({ tag: "overlay-abc1234", version: "abc1234" });
  });

  test("prefers the managed auto-updated binary over local development builds", () => {
    const root = mkdtempSync(join(tmpdir(), "gamepigeon-overlay-"));
    const manifest = { tag: "overlay-abc1234", version: "abc1234" };
    const candidates = overlayBinaryCandidates(root, manifest);
    expect(candidates[0]).toBe(managedBinaryPath(manifest.version));
    expect(candidates.some((path) => path.startsWith(join(root, "bin")))).toBe(true);
  });

  test("falls back to the managed version in use when the manifest's version was pruned", () => {
    const home = mkdtempSync(join(tmpdir(), "gamepigeon-bin-"));
    const previous = process.env.GAMEPIGEON_OVERLAY_HOME;
    process.env.GAMEPIGEON_OVERLAY_HOME = home;
    try {
      writeFileSync(join(home, "current"), "9.9.9\n");
      const root = mkdtempSync(join(tmpdir(), "gamepigeon-overlay-"));
      const candidates = overlayBinaryCandidates(root, { tag: "overlay-abc1234", version: "abc1234" });
      expect(candidates.at(-1)).toBe(managedBinaryPath("9.9.9"));
      // A dev checkout with no manifest keeps resolving its own builds only.
      expect(overlayBinaryCandidates(root, null)).not.toContain(managedBinaryPath("9.9.9"));
    } finally {
      if (previous === undefined) delete process.env.GAMEPIGEON_OVERLAY_HOME;
      else process.env.GAMEPIGEON_OVERLAY_HOME = previous;
    }
  });

  test("names release assets by platform so the launcher and CI agree", () => {
    const asset = overlayReleaseAsset();
    expect(asset.startsWith("gamepigeon-overlay-")).toBe(true);
    if (process.platform === "darwin") expect(asset).toBe(`gamepigeon-overlay-macos-${process.arch}`);
    if (process.platform === "win32") expect(asset).toBe(`gamepigeon-overlay-windows-${process.arch}.exe`);
    if (process.platform === "linux") {
      expect(asset).toBe(`gamepigeon-overlay-${linuxReleaseDistro()}-${process.arch}`);
    }
  });

  test("selects Ubuntu and Fedora release assets from os-release", () => {
    expect(linuxReleaseDistro('NAME="Ubuntu"\nID=ubuntu\n')).toBe("ubuntu");
    expect(linuxReleaseDistro("NAME=Fedora Linux\nID='fedora'\n")).toBe("fedora");
    expect(linuxReleaseDistro("ID=debian\n")).toBe("linux");
  });

  test("downloads the managed binary from the public release CDN and verifies its checksum", async () => {
    const home = mkdtempSync(join(tmpdir(), "gamepigeon-bin-"));
    const root = mkdtempSync(join(tmpdir(), "gamepigeon-overlay-"));
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const asset = overlayReleaseAsset();
    writeFileSync(join(root, "overlay-release.json"), JSON.stringify({ tag: "overlay-v0.0.0-test", version: "0.0.0-test" }));

    const previousHome = process.env.GAMEPIGEON_OVERLAY_HOME;
    const previousFetch = globalThis.fetch;
    process.env.GAMEPIGEON_OVERLAY_HOME = home;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/manifest.json")) {
        return new Response(JSON.stringify({ version: "0.0.0-test", tag: "overlay-v0.0.0-test", assets: { [asset]: { sha256, size: bytes.length } } }), {
          status: 200,
        });
      }
      if (url.endsWith(`/${asset}`)) return new Response(bytes, { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      await ensureOverlayBinary(root);
      const downloaded = join(home, "0.0.0-test", overlayExecutableName());
      expect(readFileSync(downloaded)).toEqual(Buffer.from(bytes));
      expect(readFileSync(join(home, "current"), "utf8").trim()).toBe("0.0.0-test");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.GAMEPIGEON_OVERLAY_HOME;
      else process.env.GAMEPIGEON_OVERLAY_HOME = previousHome;
    }
  });

  test("refuses a downloaded binary whose checksum does not match the manifest", async () => {
    const home = mkdtempSync(join(tmpdir(), "gamepigeon-bin-"));
    const root = mkdtempSync(join(tmpdir(), "gamepigeon-overlay-"));
    const asset = overlayReleaseAsset();
    writeFileSync(join(root, "overlay-release.json"), JSON.stringify({ tag: "overlay-v0.0.0-bad", version: "0.0.0-bad" }));

    const previousHome = process.env.GAMEPIGEON_OVERLAY_HOME;
    const previousFetch = globalThis.fetch;
    process.env.GAMEPIGEON_OVERLAY_HOME = home;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/manifest.json")) {
        return new Response(
          JSON.stringify({ version: "0.0.0-bad", tag: "overlay-v0.0.0-bad", assets: { [asset]: { sha256: "0".repeat(64), size: 3 } } }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/${asset}`)) return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      // ensureOverlayBinary swallows download failures so an offline/broken
      // session still launches whatever binary is already resolvable.
      await ensureOverlayBinary(root);
      expect(existsSync(join(home, "0.0.0-bad", overlayExecutableName()))).toBe(false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.GAMEPIGEON_OVERLAY_HOME;
      else process.env.GAMEPIGEON_OVERLAY_HOME = previousHome;
    }
  });
});

describe("isSteadyStateLaunch", () => {
  // Both paths are injected: the real shutdown flag lives in tmpdir and is left
  // behind whenever a developer hits Shutdown in the overlay, which would
  // otherwise make this suite fail depending on the machine's state.
  const stateDir = mkdtempSync(join(tmpdir(), "gamepigeon-lease-"));
  const leasePath = join(stateDir, "alive");
  const shutdownPath = join(stateDir, "off");

  test("is false while no overlay is running", () => {
    setOverlayLease(false, leasePath);
    expect(isSteadyStateLaunch("show", leasePath, shutdownPath)).toBe(false);
    expect(isSteadyStateLaunch("pause", leasePath, shutdownPath)).toBe(false);
  });

  // The per-prompt and per-turn actions are the only ones that repeat, so they
  // are the only ones allowed to skip the slow prep.
  test("is true for show and pause once the overlay is up", () => {
    setOverlayLease(true, leasePath);
    expect(isSteadyStateLaunch("show", leasePath, shutdownPath)).toBe(true);
    expect(isSteadyStateLaunch("pause", leasePath, shutdownPath)).toBe(true);
  });

  test("is false once the overlay has been shut down for the session", () => {
    setOverlayLease(true, leasePath);
    writeFileSync(shutdownPath, "");
    expect(isSteadyStateLaunch("show", leasePath, shutdownPath)).toBe(false);
    rmSync(shutdownPath, { force: true });
  });

  test("never short-circuits enable, reset, or quit", () => {
    setOverlayLease(true, leasePath);
    for (const action of ["enable", "reset", "quit", "hide"] as const) {
      expect(isSteadyStateLaunch(action, leasePath, shutdownPath)).toBe(false);
    }
    setOverlayLease(false, leasePath);
  });
});

describe("ownsUpdateCheck", () => {
  // `enable` only fires when the user explicitly invokes the Tui skill. An
  // install driven purely by the lifecycle hooks therefore never ran a check,
  // so no update flag was ever written and the overlay's checkAndAutoUpdate had
  // nothing to act on — a copied adapter could sit on a stale version forever.
  test("checks on the session-start reset, not only on an explicit launch", () => {
    expect(ownsUpdateCheck("reset")).toBe(true);
    expect(ownsUpdateCheck("enable")).toBe(true);
  });

  // These fire on every prompt and every turn end, and run synchronously in
  // front of the user on Codex.
  test("stays off the per-prompt actions", () => {
    for (const action of ["show", "pause", "hide", "quit"] as const) {
      expect(ownsUpdateCheck(action)).toBe(false);
    }
  });
});

describe("adapterCheckHarness", () => {
  const context = (updateMethod: string) => ({ updateMethod } as never);

  test("runs the check for a Claude skill install that has no harness marker", () => {
    // Adapters all export GAMEPIGEON_HARNESS; the Claude skill/bunx copy does
    // not, and it has no marketplace hook either, so without this it never
    // checked for updates at all and sat on its install-time version forever.
    delete process.env.GAMEPIGEON_HARNESS;
    expect(adapterCheckHarness(context("copied-adapter"))).toBe("claude");
  });

  // The lifecycle hooks pass `--harness claude`, and run-with-bun.cjs turns that
  // into GAMEPIGEON_HARNESS=claude before overlay.ts sees it. Matching that env
  // against ADAPTER_UPDATE_HARNESSES (which excludes "claude", so a marketplace
  // install stays out) returned null, so every Claude hook silently skipped the
  // check and only the harness-less `/tui` skill command ever ran one.
  test("still checks when the Claude hooks export GAMEPIGEON_HARNESS=claude", () => {
    process.env.GAMEPIGEON_HARNESS = "claude";
    try {
      expect(adapterCheckHarness(context("copied-adapter"))).toBe("claude");
      expect(adapterCheckHarness(context("claude-marketplace"))).toBeNull();
    } finally {
      delete process.env.GAMEPIGEON_HARNESS;
    }
  });

  test("leaves marketplace and dev installs to their own update paths", () => {
    delete process.env.GAMEPIGEON_HARNESS;
    expect(adapterCheckHarness(context("claude-marketplace"))).toBeNull();
    expect(adapterCheckHarness(context("dev"))).toBeNull();
    expect(adapterCheckHarness(context("unknown"))).toBeNull();
  });

  test("keeps each adapter on its own harness, and ignores unknown markers", () => {
    process.env.GAMEPIGEON_HARNESS = "codex";
    expect(adapterCheckHarness(context("copied-adapter"))).toBe("codex");
    process.env.GAMEPIGEON_HARNESS = "not-a-harness";
    expect(adapterCheckHarness(context("copied-adapter"))).toBeNull();
    delete process.env.GAMEPIGEON_HARNESS;
  });
});
