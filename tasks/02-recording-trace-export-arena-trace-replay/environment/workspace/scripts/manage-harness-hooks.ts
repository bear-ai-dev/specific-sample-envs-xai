/**
 * Installs the Arcade overlay lifecycle hooks into a harness's *user-global*
 * config, so one `install --<harness>` gives the same behaviour everywhere:
 * the overlay shows while the agent works, pauses and raises the "agent
 * finished" prompt when a turn ends, and closes when the session does.
 *
 * Before this, each harness needed a different number of steps:
 *   - Claude       copied only a skill; the lifecycle lived in the marketplace
 *                  plugin, so the npm install path had no hooks at all.
 *   - Codex        copied only a skill; nothing carried hooks.
 *   - Antigravity  materialized a *workspace* plugin, so it had to be re-run in
 *                  every project directory.
 *
 * Three harnesses, two config shapes:
 *   - Claude       ~/.claude/settings.json -> `hooks` (matcher groups)
 *   - Codex        ~/.codex/hooks.json     -> `hooks` (matcher groups)
 *   - Antigravity  ~/.agents/hooks.json    -> `<namespace>` (flat handler arrays)
 *
 * Every target is a file other tools also write to, so each merge preserves
 * foreign entries and replaces only our own. Re-running never appends
 * duplicates, including after the checkout moves to a new path.
 *
 * Codex's constraints shape the handler format for all three, since one format
 * keeps them in sync: Codex skips `async: true` handlers outright ("async hooks
 * are not supported yet") and has no `args` array — `command` is a shell
 * string. Claude and Antigravity both accept that same form.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HarnessId = "claude" | "codex" | "antigravity";

export interface HookHandler {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export interface HooksFile {
  [key: string]: unknown;
}

interface LifecycleHook {
  event: string;
  action: string;
  statusMessage: string;
  timeout: number;
}

/** The namespace key Antigravity groups a plugin's hooks under. */
export const ANTIGRAVITY_NAMESPACE = "tui-gamepigeon";

/**
 * Mirrors hooks/codex-hooks.json and hooks/hooks.json. All three harnesses get
 * the same four events so behaviour cannot drift between them.
 */
export const LIFECYCLE: LifecycleHook[] = [
  { event: "SessionStart", action: "reset", statusMessage: "Resetting the Tui overlay...", timeout: 15 },
  { event: "UserPromptSubmit", action: "show", statusMessage: "Opening the Tui overlay...", timeout: 15 },
  { event: "Stop", action: "pause", statusMessage: "Pausing the Tui overlay...", timeout: 10 },
  // Codex clamps SessionEnd handlers to 3s; asking for more only logs a warning.
  { event: "SessionEnd", action: "quit", statusMessage: "Closing the Tui overlay...", timeout: 3 },
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function arcadeHookCommand(rootDir: string, action: string, harness: HarnessId): string {
  const launcher = shellQuote(join(rootDir, "scripts", "run-with-bun.cjs"));
  const overlay = shellQuote(join(rootDir, "scripts", "overlay.ts"));
  return `node ${launcher} ${overlay} --${action} --harness ${harness}`;
}

export function updateNudgeCommand(rootDir: string, harness: HarnessId): string {
  const launcher = shellQuote(join(rootDir, "scripts", "run-with-bun.cjs"));
  const update = shellQuote(join(rootDir, "scripts", "plugin-update.ts"));
  return `node ${launcher} ${update} --nudge --harness ${harness}`;
}

/**
 * Markers for an Arcade hook from *any* generation of this installer, not just
 * the current one. Matching only the current command shape would leave older
 * hooks in place and stack a new one beside them on every upgrade — and those
 * strays point at checkouts that are often long gone, so they fail on every
 * prompt forever. `start-arcade.sh` is the pre-overlay.ts launcher.
 */
const ARCADE_MARKERS = ["overlay.ts", "start-arcade.sh", "plugin-update.ts", "GAMEPIGEON_"];

/**
 * Ours if it drives any Arcade launcher, whatever checkout wrote it. Matching
 * on the current root alone would leak a duplicate every time the repo moves.
 */
export function isArcadeCommand(command: unknown): boolean {
  return typeof command === "string" && ARCADE_MARKERS.some((marker) => command.includes(marker));
}

export function isArcadeGroup(group: HookGroup): boolean {
  const hooks = group?.hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) return false;
  return hooks.every((hook) => isArcadeCommand(hook?.command));
}

function handler(rootDir: string, entry: LifecycleHook, harness: HarnessId): HookHandler {
  return {
    type: "command",
    command: arcadeHookCommand(rootDir, entry.action, harness),
    timeout: entry.timeout,
    statusMessage: entry.statusMessage,
  };
}

/**
 * The visible half of the update story, and the backup for when the overlay's
 * silent self-update does not run: the overlay only auto-updates while it is
 * open, so a user who never opens Tui would otherwise get no signal at all.
 * This reads the flag `--check` already wrote — no network, just a file — and
 * prints Claude's `hookSpecificOutput` envelope so the agent can say so in
 * chat. It stays Claude-only because `nudgeHookOutput` speaks that envelope
 * and Codex does not read it; Codex still gets the `Update available:` line
 * that `--enable` and `--reset` print. No `statusMessage`: this runs on every
 * prompt and has nothing worth flashing.
 */
function updateNudgeHandler(rootDir: string, harness: HarnessId): HookHandler {
  return { type: "command", command: updateNudgeCommand(rootDir, harness), timeout: 10 };
}

/** Handlers for one event, in the order the harness should run them. */
function eventHandlers(rootDir: string, entry: LifecycleHook, harness: HarnessId): HookHandler[] {
  const lifecycle = handler(rootDir, entry, harness);
  if (harness !== "claude" || entry.event !== "UserPromptSubmit") return [lifecycle];
  // Nudge first, so the notice lands in the same turn the overlay opens.
  return [updateNudgeHandler(rootDir, harness), lifecycle];
}

/** Claude and Codex both nest handlers inside matcher groups. */
export function mergeGroupedHooks(
  existing: Record<string, HookGroup[]> | undefined,
  rootDir: string,
  harness: HarnessId,
): Record<string, HookGroup[]> {
  const events: Record<string, HookGroup[]> = { ...(existing ?? {}) };
  for (const entry of LIFECYCLE) {
    const foreign = (events[entry.event] ?? []).filter((group) => !isArcadeGroup(group));
    events[entry.event] = [...foreign, { hooks: eventHandlers(rootDir, entry, harness) }];
  }
  return events;
}

/**
 * Antigravity keys each plugin's hooks by namespace, with no matcher groups —
 * and its event set is not Claude's. It has no `UserPromptSubmit` and no
 * `SessionEnd`, and it drops unknown event keys without a word, so writing the
 * shared LIFECYCLE table here produced two handlers that silently never ran.
 *
 * `scripts/antigravity-hook.ts` is the bridge that maps the overlay lifecycle
 * onto the events Antigravity does fire, and it also carries the update
 * check/nudge. Routing through it keeps the global install identical to the
 * workspace plugin in scripts/materialize-agents-plugin.sh — the two must agree.
 */
export function antigravityHooks(rootDir: string): Record<string, unknown> {
  const bridge = shellQuote(join(rootDir, "scripts", "antigravity-hook.ts"));
  const launcher = shellQuote(join(rootDir, "scripts", "run-with-bun.cjs"));
  const command = (flag: string) => ({ type: "command" as const, command: `node ${launcher} ${bridge} --${flag}` });
  return {
    enabled: true,
    SessionStart: [command("session-start")],
    // Stands in for UserPromptSubmit, which Antigravity does not have.
    PreInvocation: [command("pre-invocation")],
    Stop: [command("stop")],
  };
}

export function readJsonFile(path: string, label: string): HooksFile {
  if (!existsSync(path)) return {};
  const contents = readFileSync(path, "utf8");
  if (!contents.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // Reported rather than overwritten: these files hold other tools' settings,
    // and clobbering them to install a game overlay is never the right trade.
    throw new Error(`Existing ${label} config is not valid JSON: ${path}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Existing ${label} config is not a JSON object: ${path}`);
  }
  return parsed as HooksFile;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * True when the marketplace plugin is installed and enabled. That plugin ships
 * its own lifecycle hooks in hooks/hooks.json, so adding ours to settings.json
 * as well would run every overlay action twice per event — the plugin's async
 * copy and the installer's synchronous one.
 */
export function claudePluginEnabled(settings: HooksFile): boolean {
  const enabled = settings.enabledPlugins;
  if (!enabled || typeof enabled !== "object") return false;
  return Object.entries(enabled as Record<string, unknown>).some(
    ([name, on]) => on === true && name.startsWith("tui-gamepigeon@"),
  );
}

export function installClaudeHooks(
  claudeConfigDir: string,
  rootDir: string,
): { path: string; skipped: boolean } {
  const settingsPath = join(claudeConfigDir, "settings.json");
  const settings = readJsonFile(settingsPath, "Claude settings");
  const events = (settings.hooks ?? {}) as Record<string, HookGroup[]>;

  if (claudePluginEnabled(settings)) {
    // Drop any hooks a previous install added, so switching to the plugin does
    // not leave a duplicate behind, and let the plugin own the lifecycle.
    let changed = false;
    for (const [event, groups] of Object.entries(events)) {
      const foreign = groups.filter((group) => !isArcadeGroup(group));
      if (foreign.length !== groups.length) changed = true;
      if (foreign.length) events[event] = foreign;
      else delete events[event];
    }
    if (changed) {
      settings.hooks = events;
      writeJsonFile(settingsPath, settings);
    }
    return { path: settingsPath, skipped: true };
  }

  settings.hooks = mergeGroupedHooks(events, rootDir, "claude");
  writeJsonFile(settingsPath, settings);
  return { path: settingsPath, skipped: false };
}

export function installCodexHooks(codexHome: string, rootDir: string): string {
  const hooksPath = join(codexHome, "hooks.json");
  const config = readJsonFile(hooksPath, "Codex hooks");
  config.hooks = mergeGroupedHooks(
    config.hooks as Record<string, HookGroup[]> | undefined,
    rootDir,
    "codex",
  );
  writeJsonFile(hooksPath, config);
  return hooksPath;
}

export function installAntigravityHooks(agentsHome: string, rootDir: string): string {
  const hooksPath = join(agentsHome, "hooks.json");
  const config = readJsonFile(hooksPath, "Antigravity hooks");
  config[ANTIGRAVITY_NAMESPACE] = antigravityHooks(rootDir);
  writeJsonFile(hooksPath, config);
  return hooksPath;
}

const INSTALLERS: Record<HarnessId, (home: string, rootDir: string) => { path: string; skipped: boolean }> = {
  claude: installClaudeHooks,
  codex: (home, root) => ({ path: installCodexHooks(home, root), skipped: false }),
  antigravity: (home, root) => ({ path: installAntigravityHooks(home, root), skipped: false }),
};

const DEFAULT_HOMES: Record<HarnessId, () => string> = {
  claude: () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  codex: () => process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  antigravity: () => process.env.AGENTS_HOME ?? join(homedir(), ".agents"),
};

export function parseHarness(value: string | undefined): HarnessId {
  if (value === "claude" || value === "codex" || value === "antigravity") return value;
  throw new Error(`Unknown harness: ${value ?? "(missing)"}. Expected claude, codex, or antigravity.`);
}

if (import.meta.main) {
  try {
    const harness = parseHarness(process.argv[2]);
    const rootDir = process.argv[3] ?? join(dirname(new URL(import.meta.url).pathname), "..");
    const home = process.argv[4] ?? DEFAULT_HOMES[harness]();
    const { path, skipped } = INSTALLERS[harness](home, rootDir);
    if (skipped) {
      console.log(`The tui-gamepigeon plugin already provides lifecycle hooks; left ${path} alone.`);
    } else {
      console.log(`Installed Tui lifecycle hooks at ${path}`);
    }
    if (harness === "codex") {
      console.log(
        "Codex asks you to review new hooks on the next launch — approve them so the overlay follows the session.",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
