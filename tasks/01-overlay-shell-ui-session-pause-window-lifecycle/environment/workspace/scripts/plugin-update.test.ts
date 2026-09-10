import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fetchRemoteReleaseManifest,
  detectInstallContext,
  formatUpdateStatusLine,
  formatUpdateVersions,
  isDirectoryMarketplace,
  nudgeHookOutput,
  parsePluginUpdateAction,
  parseUpdateHarness,
  readInstalledPlugin,
  readUpdateFlag,
  resolveInstalledVersion,
  resolvePluginUpdatePaths,
  runAdapterUpdateCheck,
  runPluginUpdateCheck,
  runPluginUpdateClear,
  runPluginUpdateNudge,
  shouldSkipUpdateCheck,
  stableRuntimeRoot,
  writeStatusLineShim,
  writeInstallContext,
} from "./plugin-update.js";
import { RELEASES_BASE_URL } from "./overlay.js";

function tempPaths(homeDir = mkdtempSync(join(tmpdir(), "gamepigeon-update-"))) {
  const claudeConfigDir = join(homeDir, ".claude");
  mkdirSync(join(claudeConfigDir, "plugins"), { recursive: true });
  return resolvePluginUpdatePaths({ homeDir, claudeConfigDir });
}

function writeInstalled(
  paths: ReturnType<typeof tempPaths>,
  sha: string,
  version = "0.2.0",
): void {
  writeFileSync(
    paths.installedPluginsPath,
    JSON.stringify({
      version: 2,
      plugins: {
        "tui-gamepigeon@tui-gamepigeon": [
          {
            scope: "user",
            version,
            gitCommitSha: sha,
            installPath: "/tmp/plugin",
          },
        ],
      },
    }),
  );
}

function writeFlag(
  paths: ReturnType<typeof tempPaths>,
  flag: {
    fromVersion: string;
    toVersion: string;
    fromLabel?: string;
    toLabel?: string;
    detectedAt?: string;
  },
): void {
  mkdirSync(dirname(paths.flagPath), { recursive: true });
  writeFileSync(
    paths.flagPath,
    JSON.stringify({
      fromLabel: "0.2.0",
      toLabel: "0.2.0",
      detectedAt: "2026-07-19T00:00:00.000Z",
      ...flag,
    }),
  );
}

function writeMarketplace(
  paths: ReturnType<typeof tempPaths>,
  source: { source: string; path?: string; repo?: string },
): void {
  writeFileSync(
    paths.knownMarketplacesPath,
    JSON.stringify({
      "tui-gamepigeon": { source },
    }),
  );
}

function writeAdapterRoot(version = "0.2.0"): string {
  const root = mkdtempSync(join(tmpdir(), "gamepigeon-adapter-root-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  return root;
}

function mockFetch(remoteVersion: string | null, ok = true, tag?: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(RELEASES_BASE_URL) && url.endsWith("/manifest.json")) {
      return {
        ok: ok && Boolean(remoteVersion),
        // The real CDN manifest also carries per-asset checksums; the update
        // check only reads tag/version and ignores the rest.
        json: async () => (remoteVersion ? { tag: tag ?? `overlay-v${remoteVersion}`, version: remoteVersion, assets: {} } : {}),
      } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

describe("plugin update checker", () => {
  test("gives a copied adapter the installer command for its own harness", () => {
    // The overlay's Update button runs `updateCommand` verbatim, so an
    // Antigravity install must not be handed Claude's marketplace updater —
    // that mismatch is what produced "install path not found" (#176).
    const adapterRoot = writeAdapterRoot();
    const adapter = detectInstallContext(adapterRoot, { GAMEPIGEON_HARNESS: "antigravity" });
    expect(adapter).toEqual({
      harness: "antigravity",
      launcherRoot: adapterRoot,
      updateMethod: "copied-adapter",
      updateCommand: ["bun", "x", "@tui-games/tui@latest", "install", "--antigravity"],
      manualCommand: "npx -y bun x @tui-games/tui@latest install --antigravity",
    });

    const contextPath = join(mkdtempSync(join(tmpdir(), "gamepigeon-context-")), "install-context.json");
    writeInstallContext(adapter, contextPath);
    expect(JSON.parse(readFileSync(contextPath, "utf8"))).toEqual(adapter);
  });

  test("treats an npx/bunx checkout as a copied adapter even with no harness marker", () => {
    // Claude's own npx install writes a launcher command without
    // GAMEPIGEON_HARNESS; the checkout still lives in the bunx cache.
    const root = join(mkdtempSync(join(tmpdir(), "gamepigeon-bunx-")), ".bun", "install", "cache", "@tui-games", "tui@0.2.13");
    mkdirSync(root, { recursive: true });
    expect(detectInstallContext(root, {})).toMatchObject({
      harness: "unknown",
      updateMethod: "copied-adapter",
      updateCommand: ["bun", "x", "@tui-games/tui@latest", "install", "--claude"],
    });
  });

  test("treats bun's own bunx temp directory as a copied adapter", () => {
    // The regression behind "the overlay never updates itself": `bun x` runs out
    // of $TMPDIR/bunx-<uid>-<pkg>/<spec>/…, not the global cache, so the
    // documented `npx -y bun x @tui-games/tui@latest install` landed on
    // "unknown" — the one method with `updateCommand: null`. The installer bakes
    // that temp path into the launcher, so nothing else re-resolved @latest
    // either and the install was frozen on its original version for good.
    const root = join(
      mkdtempSync(join(tmpdir(), "gamepigeon-tmp-")),
      "bunx-501-@tui-games",
      "tui@latest",
      "node_modules",
      "@tui-games",
      "tui",
    );
    mkdirSync(root, { recursive: true });
    expect(detectInstallContext(root, { GAMEPIGEON_HARNESS: "claude" })).toMatchObject({
      updateMethod: "copied-adapter",
      updateCommand: ["bun", "x", "@tui-games/tui@latest", "install", "--claude"],
    });
  });

  test("treats the relocated stable runtime copy as a copied adapter", () => {
    // install-adapters.sh copies an ephemeral bunx checkout here so the hooks it
    // writes outlive the OS reclaiming $TMPDIR. The copy has none of the markers
    // that identified the original — no bunx path, no .git — so without an
    // explicit rule it would land on "unknown" and lose `updateCommand`, trading
    // one cause of "never updates" for another.
    const home = mkdtempSync(join(tmpdir(), "gamepigeon-stable-"));
    const previous = process.env.GAMEPIGEON_HOME;
    process.env.GAMEPIGEON_HOME = home;
    try {
      const root = stableRuntimeRoot();
      expect(root.startsWith(home)).toBe(true);
      mkdirSync(root, { recursive: true });
      expect(detectInstallContext(root, { GAMEPIGEON_HARNESS: "claude" })).toMatchObject({
        updateMethod: "copied-adapter",
        updateCommand: ["bun", "x", "@tui-games/tui@latest", "install", "--claude"],
      });
    } finally {
      if (previous === undefined) delete process.env.GAMEPIGEON_HOME;
      else process.env.GAMEPIGEON_HOME = previous;
    }
  });

  // ROOT_DIR comes from import.meta.url, which the runtime reports with symlinks
  // already resolved, while stableRuntimeRoot() is built from the env as written.
  // On macOS everything under /var is really /private/var, so an exact string
  // compare answered "not the stable root" and silently dropped the install to
  // "unknown" — no updateCommand, no self-update.
  test("matches the stable root through a symlinked home", () => {
    const real = mkdtempSync(join(tmpdir(), "gamepigeon-real-"));
    const link = join(mkdtempSync(join(tmpdir(), "gamepigeon-link-")), "home");
    symlinkSync(real, link);
    const previous = process.env.GAMEPIGEON_HOME;
    process.env.GAMEPIGEON_HOME = link;
    try {
      mkdirSync(stableRuntimeRoot(), { recursive: true });
      // The launcher resolves to the real path; the env still names the link.
      const resolved = join(real, "runtime", "node_modules", "@tui-games", "tui");
      expect(detectInstallContext(resolved, {})).toMatchObject({
        updateMethod: "copied-adapter",
        updateCommand: ["bun", "x", "@tui-games/tui@latest", "install", "--claude"],
      });
    } finally {
      if (previous === undefined) delete process.env.GAMEPIGEON_HOME;
      else process.env.GAMEPIGEON_HOME = previous;
    }
  });

  test("offers no self-update for a dev checkout or an unrecognised install", () => {
    const devRoot = mkdtempSync(join(tmpdir(), "gamepigeon-dev-"));
    mkdirSync(join(devRoot, ".git"));
    expect(detectInstallContext(devRoot, { GAMEPIGEON_HARNESS: "codex" })).toEqual({
      harness: "codex",
      launcherRoot: devRoot,
      updateMethod: "dev",
      updateCommand: null,
      manualCommand: `git -C ${devRoot} pull --ff-only`,
    });

    const strayRoot = writeAdapterRoot();
    expect(detectInstallContext(strayRoot, {})).toMatchObject({
      updateMethod: "unknown",
      updateCommand: null,
      manualCommand: "npx -y bun x @tui-games/tui@latest install",
    });
  });

  test("keeps the Claude marketplace install on its own updater", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "gamepigeon-claude-"));
    const claudeRoot = writeAdapterRoot();
    mkdirSync(join(claudeHome, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(claudeHome, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "tui-gamepigeon@tui-gamepigeon": [{ installPath: claudeRoot }] },
    }));
    expect(detectInstallContext(claudeRoot, { HOME: claudeHome })).toEqual({
      harness: "unknown",
      launcherRoot: claudeRoot,
      updateMethod: "claude-marketplace",
      updateCommand: ["bun", join(claudeRoot, "scripts", "run-plugin-update.ts")],
      manualCommand: "/tui-gamepigeon:arcade-update",
    });
  });

  test("recognises a global npm install but not a project-local one", () => {
    const prefix = mkdtempSync(join(tmpdir(), "gamepigeon-npm-"));
    const global = join(prefix, "lib", "node_modules", "@tui-games", "tui");
    mkdirSync(global, { recursive: true });
    expect(detectInstallContext(global, {})).toMatchObject({
      updateMethod: "npm-global",
      updateCommand: ["npm", "i", "-g", "@tui-games/tui@latest"],
      manualCommand: "npm i -g @tui-games/tui@latest",
    });

    // `npm i -g` would not touch a dependency the project's package manager owns.
    const local = join(prefix, "project", "node_modules", "@tui-games", "tui");
    mkdirSync(local, { recursive: true });
    expect(detectInstallContext(local, {})).toMatchObject({ updateMethod: "unknown", updateCommand: null });
  });

  test("ignores a garbled harness marker instead of failing the launch", () => {
    const adapterRoot = writeAdapterRoot();
    expect(detectInstallContext(adapterRoot, { GAMEPIGEON_HARNESS: "not-a-harness" }).harness).toBe("unknown");
  });
  test("parses check, nudge, and clear actions", () => {
    expect(parsePluginUpdateAction(["--check"])).toBe("check");
    expect(parsePluginUpdateAction(["--nudge"])).toBe("nudge");
    expect(parsePluginUpdateAction(["--clear"])).toBe("clear");
    expect(parsePluginUpdateAction([])).toBe("check");
    expect(() => parsePluginUpdateAction(["--unknown"])).toThrow("Unknown plugin-update action");
  });

  test("skips when GAMEPIGEON_SKIP_UPDATE_CHECK=1", () => {
    expect(shouldSkipUpdateCheck({ GAMEPIGEON_SKIP_UPDATE_CHECK: "1" })).toBe(true);
    expect(shouldSkipUpdateCheck({})).toBe(false);
  });

  test("detects directory marketplaces and reads installed plugin records", () => {
    const paths = tempPaths();
    writeMarketplace(paths, { source: "directory", path: "/tmp/local" });
    expect(isDirectoryMarketplace(paths.knownMarketplacesPath)).toBe(true);
    writeMarketplace(paths, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    expect(isDirectoryMarketplace(paths.knownMarketplacesPath)).toBe(false);

    writeInstalled(paths, "abcdef1234567890");
    expect(readInstalledPlugin(paths.installedPluginsPath)?.gitCommitSha).toBe("abcdef1234567890");
  });

  test("writes a flag when the published release manifest version differs from the installed plugin", async () => {
    const paths = tempPaths();
    writeMarketplace(paths, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.2.0");

    const flag = await runPluginUpdateCheck({
      paths,
      request: mockFetch("0.2.2"),
      now: () => "2026-07-19T00:00:00.000Z",
    });

    expect(flag).toEqual({
      fromVersion: "0.2.0",
      toVersion: "0.2.2",
      fromLabel: "0.2.0",
      toLabel: "0.2.2",
      detectedAt: "2026-07-19T00:00:00.000Z",
    });
    expect(readUpdateFlag(paths.flagPath)?.toVersion).toBe("0.2.2");
    expect(existsSync(paths.statusLinePath)).toBe(true);
    expect(readFileSync(paths.statusLinePath, "utf8")).toContain("update-available.json");
  });

  test("still detects an update for a Claude install with no marketplace record", async () => {
    // The Claude skill/bunx install has no marketplace record, so the check used
    // to return null before ever reaching the network — no flag, nothing for the
    // overlay's updater to act on, and no nudge. Its version of record is simply
    // the package.json of the checkout the launcher points at.
    const paths = tempPaths();
    const root = writeAdapterRoot("0.2.14");

    const flag = await runPluginUpdateCheck({
      paths,
      root,
      request: mockFetch("0.3.1"),
      now: () => "2026-08-06T00:00:00.000Z",
    });

    expect(flag).toMatchObject({ fromVersion: "0.2.14", toVersion: "0.3.1" });
    expect(readUpdateFlag(paths.flagPath)?.toVersion).toBe("0.3.1");
  });

  test("clears the flag when the installed plugin matches the published release", async () => {
    const paths = tempPaths();
    writeMarketplace(paths, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    writeInstalled(paths, "cccccccccccccccccccccccccccccccccccccccc", "0.2.0");
    writeFlag(paths, { fromVersion: "0.1.9", toVersion: "0.2.0" });

    const flag = await runPluginUpdateCheck({
      paths,
      request: mockFetch("0.2.0"),
    });

    expect(flag).toBeNull();
    expect(readUpdateFlag(paths.flagPath)).toBeNull();
  });

  test("does not nudge merely because main's HEAD moved without a published release", async () => {
    // A version-bump commit landing on main (before the release job finishes
    // building/publishing) must not trigger a nudge; only overlay-release.json
    // catching up to the installed version should.
    const paths = tempPaths();
    writeMarketplace(paths, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.2.0");

    const flag = await runPluginUpdateCheck({
      paths,
      request: mockFetch("0.2.0"),
    });

    expect(flag).toBeNull();
  });

  test("does not nudge backward when the installed plugin is already ahead of the last published release", async () => {
    // Simulates the marketplace's own auto-update pulling main HEAD (already
    // bumped to 0.2.3 locally) while overlay-release.json still points at
    // the last published 0.2.2 because the 0.2.3 release build is still
    // running. A plain inequality check would wrongly nudge "0.2.3 → 0.2.2".
    const paths = tempPaths();
    writeMarketplace(paths, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.2.3");

    const flag = await runPluginUpdateCheck({
      paths,
      request: mockFetch("0.2.2"),
    });

    expect(flag).toBeNull();
  });

  test("skips directory marketplaces and missing install records", async () => {
    const paths = tempPaths();
    writeMarketplace(paths, { source: "directory", path: "/tmp/local" });
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(
      await runPluginUpdateCheck({
        paths,
        request: mockFetch("0.2.2"),
      }),
    ).toBeNull();

    const empty = tempPaths();
    writeMarketplace(empty, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    expect(
      await runPluginUpdateCheck({
        paths: empty,
        request: mockFetch("0.2.2"),
      }),
    ).toBeNull();
  });

  test("offline fetch failures are a no-op and leave an existing flag alone", async () => {
    const paths = tempPaths();
    writeMarketplace(paths, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    writeFlag(paths, { fromVersion: "0.2.0", toVersion: "0.2.1" });

    const flag = await runPluginUpdateCheck({
      paths,
      request: mockFetch(null, false),
      runGhManifest: async () => null,
    });

    expect(flag).toBeNull();
    expect(readUpdateFlag(paths.flagPath)?.toVersion).toBe("0.2.1");
  });

  test("falls back to gh when the public GitHub API cannot see a private repo", async () => {
    const paths = tempPaths();
    writeMarketplace(paths, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.2.0");

    const flag = await runPluginUpdateCheck({
      paths,
      request: mockFetch(null, false),
      runGhManifest: async () => ({ tag: "overlay-v0.2.2", version: "0.2.2" }),
      now: () => "2026-07-19T00:00:00.000Z",
    });

    expect(flag?.fromVersion).toBe("0.2.0");
    expect(flag?.toVersion).toBe("0.2.2");
    expect(readUpdateFlag(paths.flagPath)?.toVersion).toBe("0.2.2");
  });

  test("skips checks when GAMEPIGEON_SKIP_UPDATE_CHECK is set", async () => {
    const paths = tempPaths();
    writeMarketplace(paths, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const flag = await runPluginUpdateCheck({
      paths,
      env: { GAMEPIGEON_SKIP_UPDATE_CHECK: "1" },
      request: mockFetch("0.2.2"),
    });

    expect(flag).toBeNull();
    expect(readUpdateFlag(paths.flagPath)).toBeNull();
    expect(existsSync(paths.statusLinePath)).toBe(true);
  });

  test("nudge emits hookSpecificOutput JSON when a flag is present", () => {
    const paths = tempPaths();
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.2.0");
    writeFlag(paths, { fromVersion: "0.2.0", toVersion: "0.2.1", fromLabel: "0.2.0", toLabel: "0.2.1" });

    const output = runPluginUpdateNudge(paths);
    expect(output).toBeTruthy();
    const parsed = JSON.parse(output!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("/tui-gamepigeon:arcade-update");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("(0.2.1)");

    runPluginUpdateClear(paths);
    expect(runPluginUpdateNudge(paths)).toBeNull();
  });

  test("nudge stays silent and clears a stale flag once the install is already current", () => {
    // The upgrade path clears the flag, but a manual reinstall (or a crash
    // between upgrade and clear) leaves it behind; the nudge must re-check
    // rather than nagging about a release the user is already on.
    const paths = tempPaths();
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.2.2");
    writeFlag(paths, { fromVersion: "0.2.0", toVersion: "0.2.2" });

    expect(runPluginUpdateNudge(paths)).toBeNull();
    expect(readUpdateFlag(paths.flagPath)).toBeNull();
  });

  test("nudge stays silent when the install has moved past the flagged release", () => {
    const paths = tempPaths();
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.3.0");
    writeFlag(paths, { fromVersion: "0.2.0", toVersion: "0.2.2" });

    expect(runPluginUpdateNudge(paths)).toBeNull();
    expect(readUpdateFlag(paths.flagPath)).toBeNull();
  });

  test("nudge still fires while the flagged release is genuinely newer", () => {
    const paths = tempPaths();
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.2.0");
    writeFlag(paths, { fromVersion: "0.2.0", toVersion: "0.2.2", toLabel: "0.2.2" });

    const output = runPluginUpdateNudge(paths);
    expect(output).toBeTruthy();
    expect(JSON.parse(output!).hookSpecificOutput.additionalContext).toContain("(0.2.2)");
    expect(readUpdateFlag(paths.flagPath)?.toVersion).toBe("0.2.2");
  });

  test("adapter nudges gate on the checkout's package.json, not the Claude install record", () => {
    const current = tempPaths();
    writeFlag(current, { fromVersion: "0.2.0", toVersion: "0.2.2" });
    expect(runPluginUpdateNudge(current, "codex", writeAdapterRoot("0.2.2"))).toBeNull();
    expect(readUpdateFlag(current.flagPath)).toBeNull();

    const behind = tempPaths();
    writeFlag(behind, { fromVersion: "0.2.0", toVersion: "0.2.2" });
    // A Claude install record at 0.2.2 must not silence a stale codex checkout.
    writeInstalled(behind, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.2.2");
    expect(runPluginUpdateNudge(behind, "codex", writeAdapterRoot("0.2.0"))).toBeTruthy();
    expect(readUpdateFlag(behind.flagPath)?.toVersion).toBe("0.2.2");
  });

  test("nudge trusts the flag when no installed version can be resolved", () => {
    const paths = tempPaths();
    writeFlag(paths, { fromVersion: "0.2.0", toVersion: "0.2.2" });
    const root = mkdtempSync(join(tmpdir(), "gamepigeon-no-version-"));

    expect(runPluginUpdateNudge(paths, "codex", root)).toBeTruthy();
    expect(readUpdateFlag(paths.flagPath)?.toVersion).toBe("0.2.2");
  });

  test("resolveInstalledVersion prefers the install record and rejects unrankable versions", () => {
    const paths = tempPaths();
    const root = writeAdapterRoot("0.2.0");
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0.2.5");

    expect(resolveInstalledVersion(paths, "claude", root)).toBe("0.2.5");
    expect(resolveInstalledVersion(paths, "codex", root)).toBe("0.2.0");

    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "nightly");
    expect(resolveInstalledVersion(paths, "claude", root)).toBe("0.2.0");
    expect(resolveInstalledVersion(paths, "claude", mkdtempSync(join(tmpdir(), "gamepigeon-empty-")))).toBeNull();
  });

  test("check leaves an existing flag alone when the installed version is unrankable", async () => {
    const paths = tempPaths();
    const root = mkdtempSync(join(tmpdir(), "gamepigeon-unknown-root-"));
    writeMarketplace(paths, { source: "github", repo: "Trolleroof/tui-gamepigeon" });
    writeInstalled(paths, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "nightly");
    writeFlag(paths, { fromVersion: "0.2.0", toVersion: "0.2.1" });

    const flag = await runPluginUpdateCheck({ paths, root, request: mockFetch("0.2.2") });

    expect(flag).toBeNull();
    expect(readUpdateFlag(paths.flagPath)?.toVersion).toBe("0.2.1");
  });

  test("status-line shim and nudge helper use subdued version labels", () => {
    const paths = tempPaths();
    writeStatusLineShim(paths.statusLinePath, paths.flagPath);
    const script = readFileSync(paths.statusLinePath, "utf8");
    expect(script).toContain("update available");
    expect(script).toContain("\\u001b[90m"); // muted gray
    expect(script).not.toContain(">>>");
    const line = formatUpdateStatusLine("0.2.0", "0.2.2");
    expect(line).toContain("Tui");
    expect(line).toContain("0.2.0");
    expect(line).toContain("0.2.2");
    expect(line).toContain("update available");
    expect(line).not.toContain(">>>");
    expect(line).not.toContain("/tui-gamepigeon:arcade-update");
    const nudge = nudgeHookOutput({
      fromVersion: "0.2.0",
      toVersion: "0.2.2",
      fromLabel: "0.2.0",
      toLabel: "0.2.2",
      detectedAt: "2026-07-19T00:00:00.000Z",
    });
    expect(nudge).toContain("An update is available (0.2.2)");
    expect(nudge).toContain("/tui-gamepigeon:arcade-update");
  });

  test("parseUpdateHarness defaults to claude and validates known harnesses", () => {
    expect(parseUpdateHarness([])).toBe("claude");
    expect(parseUpdateHarness(["--check", "--harness", "codex"])).toBe("codex");
    expect(parseUpdateHarness(["--nudge", "--harness", "antigravity"])).toBe("antigravity");
    expect(parseUpdateHarness(["--check", "--harness", "opencode"])).toBe("opencode");
    expect(parseUpdateHarness(["--check", "--harness", "hermes"])).toBe("hermes");
    expect(parseUpdateHarness(["--check", "--harness", "openclaw"])).toBe("openclaw");
    expect(() => parseUpdateHarness(["--check", "--harness", "unknown"])).toThrow(
      "Unknown plugin-update harness",
    );
  });

  test("runAdapterUpdateCheck skips the Claude-only install record and compares package.json directly", async () => {
    const paths = tempPaths();
    const root = writeAdapterRoot("0.2.0");

    const flag = await runAdapterUpdateCheck({
      paths,
      root,
      request: mockFetch("0.2.2"),
      now: () => "2026-07-19T00:00:00.000Z",
    });

    expect(flag).toEqual({
      fromVersion: "0.2.0",
      toVersion: "0.2.2",
      fromLabel: "0.2.0",
      toLabel: "0.2.2",
      detectedAt: "2026-07-19T00:00:00.000Z",
    });
    expect(readUpdateFlag(paths.flagPath)?.toVersion).toBe("0.2.2");
  });

  test("runAdapterUpdateCheck clears the flag once the adapter's package.json catches up", async () => {
    const paths = tempPaths();
    const root = writeAdapterRoot("0.2.2");
    writeFlag(paths, { fromVersion: "0.2.0", toVersion: "0.2.2" });

    const flag = await runAdapterUpdateCheck({ paths, root, request: mockFetch("0.2.2") });

    expect(flag).toBeNull();
    expect(readUpdateFlag(paths.flagPath)).toBeNull();
  });

  test("runAdapterUpdateCheck respects GAMEPIGEON_SKIP_UPDATE_CHECK without needing an install record", async () => {
    const paths = tempPaths();
    const root = writeAdapterRoot("0.2.0");

    const flag = await runAdapterUpdateCheck({
      paths,
      root,
      env: { GAMEPIGEON_SKIP_UPDATE_CHECK: "1" },
      request: mockFetch("0.2.2"),
    });

    expect(flag).toBeNull();
    expect(readUpdateFlag(paths.flagPath)).toBeNull();
  });

  test("nudge text points each harness at its own update command", () => {
    const flag = {
      fromVersion: "0.2.0",
      toVersion: "0.2.2",
      fromLabel: "0.2.0",
      toLabel: "0.2.2",
      detectedAt: "2026-07-19T00:00:00.000Z",
    };
    // A Claude copied adapter has no marketplace slash command to run.
    expect(
      JSON.parse(nudgeHookOutput(flag, "claude", "copied-adapter")).hookSpecificOutput.additionalContext,
    ).toContain("npx -y bun x @tui-games/tui@latest install --claude");
    expect(JSON.parse(nudgeHookOutput(flag, "claude")).hookSpecificOutput.additionalContext).toContain(
      "/tui-gamepigeon:arcade-update",
    );
    expect(JSON.parse(nudgeHookOutput(flag, "codex")).hookSpecificOutput.additionalContext).toContain(
      "npx -y bun x @tui-games/tui@latest install --codex",
    );
    expect(JSON.parse(nudgeHookOutput(flag, "antigravity")).hookSpecificOutput.additionalContext).toContain(
      "npx -y bun x @tui-games/tui@latest install --antigravity",
    );
    for (const harness of ["opencode", "hermes", "openclaw"] as const) {
      expect(JSON.parse(nudgeHookOutput(flag, harness)).hookSpecificOutput.additionalContext).toContain(
        `npx -y bun x @tui-games/tui@latest install --${harness}`,
      );
    }
  });

  test("fetchRemoteReleaseManifest reads the public release CDN manifest", async () => {
    const requested: string[] = [];
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      return mockFetch("0.2.3")(input, init);
    }) as typeof fetch;

    const manifest = await fetchRemoteReleaseManifest("Trolleroof/tui-gamepigeon", request);
    expect(manifest).toEqual({ tag: "overlay-v0.2.3", version: "0.2.3" });
    // The private repo 404s for anyone without repo access, so the nudge must
    // not depend on GitHub being readable.
    expect(requested).toEqual([`${RELEASES_BASE_URL}/manifest.json`]);
    expect(requested.some((url) => url.includes("githubusercontent"))).toBe(false);
  });

  test("fetchRemoteReleaseManifest falls back to gh when the CDN is unreachable", async () => {
    const manifest = await fetchRemoteReleaseManifest(
      "Trolleroof/tui-gamepigeon",
      (async () => {
        throw new Error("offline");
      }) as typeof fetch,
      async () => ({ tag: "overlay-v0.9.9", version: "0.9.9" }),
    );
    expect(manifest).toEqual({ tag: "overlay-v0.9.9", version: "0.9.9" });
  });

  test("formatUpdateVersions prefers labels", () => {
    expect(formatUpdateVersions({
      fromVersion: "ignored",
      toVersion: "ignored",
      fromLabel: "0.2.0",
      toLabel: "0.2.2",
      detectedAt: "2026-07-19T00:00:00.000Z",
    })).toEqual({ from: "0.2.0", to: "0.2.2" });
  });
});
