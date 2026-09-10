import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_NAMESPACE,
  LIFECYCLE,
  antigravityHooks,
  claudePluginEnabled,
  arcadeHookCommand,
  installAntigravityHooks,
  installClaudeHooks,
  installCodexHooks,
  isArcadeGroup,
  mergeGroupedHooks,
  parseHarness,
  readJsonFile,
  type HookGroup,
  type HooksFile,
} from "./manage-harness-hooks.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "gamepigeon-hooks-"));
}

function readJson(path: string): HooksFile {
  return JSON.parse(readFileSync(path, "utf8"));
}

const EVENTS = LIFECYCLE.map((entry) => entry.event).sort();

describe("arcadeHookCommand", () => {
  test("invokes the overlay launcher as a shell string", () => {
    expect(arcadeHookCommand("/repo", "pause", "codex")).toBe(
      "node '/repo/scripts/run-with-bun.cjs' '/repo/scripts/overlay.ts' --pause --harness codex",
    );
  });

  test("tags each harness so update nudges name the right install command", () => {
    for (const harness of ["claude", "codex", "antigravity"] as const) {
      expect(arcadeHookCommand("/repo", "show", harness)).toContain(`--harness ${harness}`);
    }
  });

  test("quotes a root directory containing spaces", () => {
    expect(arcadeHookCommand("/my repo", "show", "claude")).toContain("'/my repo/scripts/overlay.ts'");
  });
});

describe("mergeGroupedHooks", () => {
  test("covers every lifecycle event", () => {
    expect(Object.keys(mergeGroupedHooks(undefined, "/repo", "codex")).sort()).toEqual(EVENTS);
  });

  test("maps each event to its overlay action", () => {
    const events = mergeGroupedHooks(undefined, "/repo", "claude");
    expect(events.SessionStart?.[0]?.hooks[0]?.command).toContain("--reset");
    expect(events.UserPromptSubmit?.[0]?.hooks.at(-1)?.command).toContain("--show");
    expect(events.Stop?.[0]?.hooks[0]?.command).toContain("--pause");
    expect(events.SessionEnd?.[0]?.hooks[0]?.command).toContain("--quit");
  });

  // The overlay self-updates only while it is open, so an install whose overlay
  // the user never opens needs this to hear about a release at all.
  test("nudges before opening the overlay on Claude", () => {
    const hooks = mergeGroupedHooks(undefined, "/repo", "claude").UserPromptSubmit?.[0]?.hooks ?? [];
    expect(hooks).toHaveLength(2);
    expect(hooks[0]?.command).toContain("plugin-update.ts' --nudge --harness claude");
    expect(hooks[0]).not.toHaveProperty("statusMessage");
    expect(hooks[1]?.command).toContain("--show");
  });

  // nudgeHookOutput speaks Claude's hookSpecificOutput envelope; Codex would
  // print it as noise. Codex gets the launcher's "Update available:" line.
  test("adds no nudge handler for Codex", () => {
    const hooks = mergeGroupedHooks(undefined, "/repo", "codex").UserPromptSubmit?.[0]?.hooks ?? [];
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.command).toContain("--show");
  });

  test("replaces a Claude group without stacking a second nudge", () => {
    const once = mergeGroupedHooks(undefined, "/repo", "claude");
    expect(mergeGroupedHooks(once, "/repo", "claude")).toEqual(once);
  });

  // Codex logs "async hooks are not supported yet" and drops the handler, so a
  // single async-free format keeps all three harnesses on identical behaviour.
  test("emits no async handlers and bounds every handler with a timeout", () => {
    for (const groups of Object.values(mergeGroupedHooks(undefined, "/repo", "codex"))) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook).not.toHaveProperty("async");
          expect(hook).not.toHaveProperty("args");
          expect(typeof hook.timeout).toBe("number");
          expect(hook.type).toBe("command");
        }
      }
    }
  });

  test("preserves hooks written by other tools", () => {
    const existing: Record<string, HookGroup[]> = {
      Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }],
    };
    const merged = mergeGroupedHooks(existing, "/repo", "codex");
    expect(merged.PreToolUse).toEqual(existing.PreToolUse!);
    expect(merged.Stop?.[0]?.hooks[0]?.command).toBe("notify-send done");
    expect(merged.Stop).toHaveLength(2);
  });

  test("replaces its own groups instead of appending duplicates", () => {
    const once = mergeGroupedHooks(undefined, "/repo", "codex");
    expect(mergeGroupedHooks(once, "/repo", "codex")).toEqual(once);
  });

  test("retargets a group left behind by a previous checkout", () => {
    const stale = mergeGroupedHooks(undefined, "/old/checkout", "codex");
    for (const groups of Object.values(mergeGroupedHooks(stale, "/new/checkout", "codex"))) {
      expect(groups).toHaveLength(1);
      expect(groups[0]?.hooks[0]?.command).toContain("/new/checkout");
    }
  });
});

describe("antigravityHooks", () => {
  test("uses flat handler arrays under an enabled namespace", () => {
    const namespaced = antigravityHooks("/repo");
    expect(namespaced.enabled).toBe(true);
    expect(Object.keys(namespaced).sort()).toEqual(["PreInvocation", "SessionStart", "Stop", "enabled"]);
  });

  // Antigravity has no UserPromptSubmit and no SessionEnd, and drops unknown
  // event keys silently, so emitting the shared Claude table here produced two
  // handlers that could never run.
  test("declares only events Antigravity actually fires", () => {
    const namespaced = antigravityHooks("/repo");
    for (const absent of ["UserPromptSubmit", "SessionEnd"]) {
      expect(namespaced).not.toHaveProperty(absent);
    }
  });

  // The bridge maps the lifecycle onto the real events and carries the update
  // check/nudge, which a bare overlay.ts call would drop.
  test("routes through the antigravity-hook bridge", () => {
    const namespaced = antigravityHooks("/repo");
    for (const [event, flag] of [
      ["SessionStart", "--session-start"],
      ["PreInvocation", "--pre-invocation"],
      ["Stop", "--stop"],
    ] as const) {
      const handlers = namespaced[event] as { command: string }[];
      expect(handlers).toHaveLength(1);
      expect(handlers[0]?.command).toContain("antigravity-hook.ts");
      expect(handlers[0]?.command).toContain(flag);
    }
  });

  test("matches the workspace plugin the dev harness materializes", () => {
    const workspace = readFileSync(join(import.meta.dir, "materialize-agents-plugin.sh"), "utf8");
    for (const flag of ["--session-start", "--pre-invocation", "--stop"]) {
      expect(workspace).toContain(flag);
    }
  });
});

describe("claudePluginEnabled", () => {
  test("detects the marketplace plugin", () => {
    expect(claudePluginEnabled({ enabledPlugins: { "tui-gamepigeon@tui-gamepigeon": true } })).toBe(true);
    expect(claudePluginEnabled({ enabledPlugins: { "tui-gamepigeon@tui-gamepigeon": false } })).toBe(false);
    expect(claudePluginEnabled({ enabledPlugins: { "vercel@claude-plugins-official": true } })).toBe(false);
    expect(claudePluginEnabled({})).toBe(false);
  });
});

describe("installClaudeHooks with the marketplace plugin", () => {
  // The plugin ships hooks/hooks.json, so adding ours as well would run every
  // overlay action twice per event -- its async copy and our synchronous one.
  test("does not add a second copy of the lifecycle", () => {
    const home = tempHome();
    const settingsPath = join(home, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "tui-gamepigeon@tui-gamepigeon": true } }));
    const result = installClaudeHooks(home, "/repo");
    expect(result.skipped).toBe(true);
    expect(JSON.stringify(readJson(settingsPath))).not.toContain("overlay.ts");
  });

  test("removes hooks an earlier install added", () => {
    const home = tempHome();
    const settingsPath = join(home, "settings.json");
    installClaudeHooks(home, "/repo");
    const withHooks = readJson(settingsPath);
    withHooks.enabledPlugins = { "tui-gamepigeon@tui-gamepigeon": true };
    writeFileSync(settingsPath, JSON.stringify(withHooks));
    expect(installClaudeHooks(home, "/repo").skipped).toBe(true);
    expect(JSON.stringify(readJson(settingsPath))).not.toContain("overlay.ts");
  });

  test("keeps unrelated hooks while removing its own", () => {
    const home = tempHome();
    const settingsPath = join(home, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      enabledPlugins: { "tui-gamepigeon@tui-gamepigeon": true },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }, { hooks: [{ type: "command", command: "node x/overlay.ts --pause" }] }] },
    }));
    installClaudeHooks(home, "/repo");
    const hooks = readJson(settingsPath).hooks as Record<string, HookGroup[]>;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe("keep-me");
  });
});

describe("isArcadeGroup", () => {
  test("matches only Arcade launcher groups", () => {
    expect(isArcadeGroup({ hooks: [{ type: "command", command: arcadeHookCommand("/r", "show", "codex") }] })).toBe(true);
    expect(isArcadeGroup({ hooks: [{ type: "command", command: "echo hi" }] })).toBe(false);
    expect(isArcadeGroup({ hooks: [{ type: "command", command: "notify-send done" }] })).toBe(false);
    expect(isArcadeGroup({ hooks: [] })).toBe(false);
  });

  // A hook from an older installer points at a checkout that is often already
  // deleted, so it fails on every prompt until something replaces it.
  test("matches Arcade hooks from earlier installer generations", () => {
    for (const legacy of [
      "GAMEPIGEON_AUTO_OPEN=1 bash /old/checkout/scripts/start-arcade.sh --auto-open",
      "node /old/checkout/scripts/run-with-bun.cjs /old/checkout/scripts/plugin-update.ts --nudge",
    ]) {
      expect(isArcadeGroup({ hooks: [{ type: "command", command: legacy }] })).toBe(true);
    }
  });
});

describe("upgrading over an older install", () => {
  test("replaces a stale Arcade hook instead of stacking beside it", () => {
    const existing: Record<string, HookGroup[]> = {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "keep-my-notifier.sh" }] },
        { hooks: [{ type: "command", command: "GAMEPIGEON_AUTO_OPEN=1 bash /gone/scripts/start-arcade.sh --auto-open" }] },
      ],
    };
    const merged = mergeGroupedHooks(existing, "/repo", "claude");
    expect(merged.UserPromptSubmit).toHaveLength(2);
    expect(merged.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe("keep-my-notifier.sh");
    expect(merged.UserPromptSubmit?.[1]?.hooks.at(-1)?.command).toContain("--show --harness claude");
    expect(JSON.stringify(merged)).not.toContain("start-arcade.sh");
  });
});

describe("installClaudeHooks", () => {
  test("adds hooks without disturbing unrelated settings", () => {
    const home = tempHome();
    const settingsPath = join(home, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: "opus", statusLine: { type: "command" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "keep-me" }] }] } }),
    );
    installClaudeHooks(home, "/repo");
    const settings = readJson(settingsPath);
    expect(settings.model).toBe("opus");
    expect(settings.statusLine).toEqual({ type: "command" });
    const hooks = settings.hooks as Record<string, HookGroup[]>;
    expect(Object.keys(hooks).sort()).toEqual(EVENTS);
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe("keep-me");
    expect(hooks.Stop?.[1]?.hooks[0]?.command).toContain("--pause --harness claude");
  });

  test("creates settings.json when Claude has none", () => {
    const home = tempHome();
    installClaudeHooks(home, "/repo");
    expect(Object.keys(readJson(join(home, "settings.json")).hooks as object).sort()).toEqual(EVENTS);
  });
});

describe("installCodexHooks", () => {
  test("creates hooks.json when Codex has none", () => {
    const home = tempHome();
    installCodexHooks(home, "/repo");
    expect(Object.keys(readJson(join(home, "hooks.json")).hooks as object).sort()).toEqual(EVENTS);
  });

  test("is idempotent across repeated installs", () => {
    const home = tempHome();
    installCodexHooks(home, "/repo");
    installCodexHooks(home, "/repo");
    for (const groups of Object.values(readJson(join(home, "hooks.json")).hooks as Record<string, HookGroup[]>)) {
      expect(groups).toHaveLength(1);
    }
  });
});

describe("installAntigravityHooks", () => {
  test("replaces only its own namespace", () => {
    const home = tempHome();
    const hooksPath = join(home, "hooks.json");
    writeFileSync(hooksPath, JSON.stringify({ "agent-finished-notification": { Stop: [{ type: "command", command: "agent-notify" }] } }));
    installAntigravityHooks(home, "/repo");
    const config = readJson(hooksPath);
    expect(config["agent-finished-notification"]).toEqual({ Stop: [{ type: "command", command: "agent-notify" }] });
    expect(Object.keys(config[ANTIGRAVITY_NAMESPACE] as object)).toContain("Stop");
  });

  test("is idempotent across repeated installs", () => {
    const home = tempHome();
    installAntigravityHooks(home, "/repo");
    const first = readJson(join(home, "hooks.json"));
    installAntigravityHooks(home, "/repo");
    expect(readJson(join(home, "hooks.json"))).toEqual(first);
  });
});

describe("malformed configs", () => {
  test("refuses to overwrite a file it cannot parse", () => {
    const home = tempHome();
    const hooksPath = join(home, "hooks.json");
    writeFileSync(hooksPath, "{ not json");
    expect(() => installCodexHooks(home, "/repo")).toThrow(/not valid JSON/);
    expect(readFileSync(hooksPath, "utf8")).toBe("{ not json");
  });

  test("rejects a non-object config", () => {
    const home = tempHome();
    writeFileSync(join(home, "settings.json"), "[]");
    expect(() => installClaudeHooks(home, "/repo")).toThrow(/not a JSON object/);
  });

  test("treats a missing or empty file as empty", () => {
    const home = tempHome();
    expect(readJsonFile(join(home, "nope.json"), "test")).toEqual({});
    writeFileSync(join(home, "empty.json"), "  \n");
    expect(readJsonFile(join(home, "empty.json"), "test")).toEqual({});
  });
});

describe("parseHarness", () => {
  test("accepts the three hook-capable harnesses", () => {
    expect(["claude", "codex", "antigravity"].map(parseHarness)).toEqual(["claude", "codex", "antigravity"]);
  });

  test("rejects anything else", () => {
    expect(() => parseHarness("opencode")).toThrow(/Unknown harness/);
    expect(() => parseHarness(undefined)).toThrow(/Unknown harness/);
  });
});

describe("packaged plugin hooks", () => {
  const packaged = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "hooks", "codex-hooks.json"), "utf8"),
  ) as { hooks: Record<string, HookGroup[]> };

  test("matches the events the copied adapters install", () => {
    expect(Object.keys(packaged.hooks).sort()).toEqual(EVENTS);
  });

  test("uses shell strings with no async handlers", () => {
    for (const { event, action } of LIFECYCLE) {
      const hook = packaged.hooks[event]?.[0]?.hooks[0];
      expect(hook?.command).toContain(`--${action}`);
      expect(hook?.command).toContain("${CLAUDE_PLUGIN_ROOT}");
      expect(hook).not.toHaveProperty("async");
      expect(hook).not.toHaveProperty("args");
      expect(typeof hook?.timeout).toBe("number");
    }
  });

  // The manifest deliberately does not declare `hooks`: with the installer
  // writing them into ~/.codex/hooks.json, declaring them here too would fire
  // every lifecycle action twice for anyone who has both.
  test("is not also declared by the Codex plugin manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", ".codex-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest.hooks).toBeUndefined();
  });
});
