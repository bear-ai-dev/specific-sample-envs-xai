import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASES_BASE_URL, repoSlug, type ReleaseManifest } from "./overlay.js";

export type PluginUpdateAction = "check" | "nudge" | "clear";

export type UpdateHarness = "claude" | "antigravity" | "codex" | "opencode" | "hermes" | "openclaw";

/** The documented one-liner that reinstalls a copied adapter at the latest version. */
export function adapterInstallCommand(harness: UpdateHarness): string {
  return `npx -y bun x @tui-games/tui@latest install --${harness}`;
}

const UPDATE_COMMANDS: Record<UpdateHarness, string> = {
  claude: "Run this command: /tui-gamepigeon:arcade-update",
  antigravity: `Run: ${adapterInstallCommand("antigravity")}`,
  codex: `Run: ${adapterInstallCommand("codex")}`,
  opencode: `Run: ${adapterInstallCommand("opencode")}`,
  hermes: `Run: ${adapterInstallCommand("hermes")}`,
  openclaw: `Run: ${adapterInstallCommand("openclaw")}`,
};

export interface UpdateAvailableFlag {
  fromVersion: string;
  toVersion: string;
  fromLabel: string;
  toLabel: string;
  detectedAt: string;
}

export interface InstalledPluginRecord {
  gitCommitSha?: string;
  version?: string;
  installPath?: string;
  scope?: string;
}

export interface MarketplaceSource {
  source: string;
  path?: string;
  repo?: string;
}

export interface PluginUpdatePaths {
  homeDir: string;
  claudeConfigDir: string;
  flagPath: string;
  statusLinePath: string;
  installedPluginsPath: string;
  knownMarketplacesPath: string;
}

export type InstallMethod =
  | "claude-marketplace"
  | "copied-adapter"
  | "npm-global"
  | "dev"
  | "unknown";

/**
 * How this install can be upgraded, written to ~/.gamepigeon/install-context.json
 * on every launch so the overlay's Update button knows what to run. The overlay
 * runs `updateCommand` verbatim; when it is null the button is replaced with
 * `manualCommand` for the user to run themselves.
 */
export interface InstallContext {
  harness: UpdateHarness | "unknown";
  launcherRoot: string;
  updateMethod: InstallMethod;
  updateCommand: string[] | null;
  manualCommand: string;
}

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_KEY = "tui-gamepigeon@tui-gamepigeon";
const MARKETPLACE_NAME = "tui-gamepigeon";
export const installContextPath = (home = gamepigeonHome()): string => join(home, "install-context.json");
type FetchLike = typeof fetch;

/** Muted terminal palette aligned with overlay tokens (--muted, --ink, --accent). */
const STATUS = {
  reset: "\x1b[0m",
  muted: "\x1b[90m",
  ink: "\x1b[37m",
  accent: "\x1b[33m",
} as const;

export function parsePluginUpdateAction(args: string[]): PluginUpdateAction {
  const value = args[0] ?? "--check";
  if (value === "--check") return "check";
  if (value === "--nudge") return "nudge";
  if (value === "--clear") return "clear";
  throw new Error(`Unknown plugin-update action: ${value}`);
}

export function parseUpdateHarness(args: string[]): UpdateHarness {
  const index = args.indexOf("--harness");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value === "claude") return "claude";
  if (
    value === "antigravity" ||
    value === "codex" ||
    value === "opencode" ||
    value === "hermes" ||
    value === "openclaw"
  ) return value;
  throw new Error(`Unknown plugin-update harness: ${value}`);
}

export function gamepigeonHome(home = homedir()): string {
  return process.env.GAMEPIGEON_HOME ?? join(home, ".gamepigeon");
}

/** `--harness` is validated at the CLI; a stray env value must not crash a launch. */
function harnessFromEnv(env: NodeJS.ProcessEnv): UpdateHarness | "unknown" {
  if (!env.GAMEPIGEON_HARNESS) return "unknown";
  try {
    return parseUpdateHarness(["--harness", env.GAMEPIGEON_HARNESS]);
  } catch {
    return "unknown";
  }
}

const NPX_CACHE_MARKERS = ["/.bun/install/cache/", "/_npx/", "/.npm/_npx/"];

/**
 * `bun x` does not run out of the global cache the markers above describe: it
 * materialises the package in a per-spec temp directory —
 * `$TMPDIR/bunx-<uid>-<package>/<spec>/node_modules/...` on unix, the same shape
 * under Temp on Windows. Matching only the global cache meant every install done
 * the documented way (`npx -y bun x @tui-games/tui@latest install`) fell through
 * to "unknown", the one method with no `updateCommand` — so those installs could
 * never self-update, and the installer bakes that temp path into the launcher, so
 * nothing else ever re-resolved `@latest` either.
 */
const BUNX_TEMP_DIR = /\/bunx-[^/]*\//;

function normalizePath(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

/**
 * `npx -y bun x @tui-games/tui@latest install --<harness>` runs out of a bunx/npx
 * cache directory and copies adapters that point back at it — so a launcher root
 * inside that cache is always a copied-adapter install, whatever the harness.
 */
function isNpxCheckout(root: string): boolean {
  const path = normalizePath(root);
  return NPX_CACHE_MARKERS.some((marker) => path.includes(marker)) || BUNX_TEMP_DIR.test(path);
}

/**
 * Where `install-adapters.sh` parks a copy of an ephemeral npx/bunx checkout so
 * the hooks it writes keep resolving. The `runtime/node_modules/@tui-games/tui`
 * shape is deliberate: node resolves the package's own dependencies by walking
 * up to `runtime/node_modules/`, exactly as it did in the bunx tree.
 */
export function stableRuntimeRoot(home = gamepigeonHome()): string {
  return join(home, "runtime", "node_modules", "@tui-games", "tui");
}

/**
 * The relocated copy is still a copied adapter — it is upgraded by re-running
 * the installer, not by npm. It needs naming explicitly because relocating
 * strips every marker that identified the original: it is no longer under a
 * bunx/npx path and it has no `.git`, so it would otherwise fall through to
 * "unknown", the one method with no `updateCommand` — trading one cause of
 * "never updates" for another.
 */
function isStableRuntimeCheckout(root: string): boolean {
  return canonicalPath(root) === canonicalPath(stableRuntimeRoot());
}

/**
 * Resolves symlinks before comparing. `ROOT_DIR` comes from `import.meta.url`,
 * which the runtime reports fully resolved, while `stableRuntimeRoot()` is
 * built from `$GAMEPIGEON_HOME`/`homedir()` as written. On macOS those differ
 * for anything under `/var` (a symlink to `/private/var`), and they differ for
 * any user whose home is symlinked — a plain string compare silently reports
 * "not the stable root", drops the install to "unknown", and takes
 * `updateCommand` with it.
 */
function canonicalPath(path: string): string {
  try {
    return normalizePath(realpathSync(path));
  } catch {
    // The path need not exist yet; compare what we were given.
    return normalizePath(path);
  }
}

/**
 * A *global* npm install only: `<prefix>/lib/node_modules/...` on unix,
 * `<prefix>/npm/node_modules/...` on Windows. A package inside a project's own
 * node_modules is left as "unknown" — `npm i -g` would not update it, and the
 * project's package manager owns that copy.
 */
function isGlobalPackageInstall(root: string): boolean {
  const path = normalizePath(root);
  return ["/lib/node_modules/@tui-games/tui", "/npm/node_modules/@tui-games/tui"].some((suffix) =>
    path.endsWith(suffix),
  );
}

function resolveInstallMethod(
  root: string,
  harness: UpdateHarness | "unknown",
  claudeInstallPath: string | undefined,
): InstallMethod {
  if (claudeInstallPath && resolve(claudeInstallPath) === resolve(root)) return "claude-marketplace";
  if (isStableRuntimeCheckout(root)) return "copied-adapter";
  if (isNpxCheckout(root)) return "copied-adapter";
  if (existsSync(join(root, ".git"))) return "dev";
  if (isGlobalPackageInstall(root)) return "npm-global";
  if (harness !== "unknown" && harness !== "claude") return "copied-adapter";
  return "unknown";
}

/**
 * The argv the overlay can run itself, plus the command to show when it cannot.
 * `bun` leads the runnable forms because the launcher guarantees a Bun >= 1.3 on
 * disk (scripts/run-with-bun.cjs installs one), while `npx` may not be on the
 * PATH the overlay process inherited.
 */
function resolveUpdatePlan(
  method: InstallMethod,
  harness: UpdateHarness | "unknown",
  root: string,
): Pick<InstallContext, "updateCommand" | "manualCommand"> {
  if (method === "claude-marketplace") {
    return {
      updateCommand: ["bun", join(root, "scripts", "run-plugin-update.ts")],
      manualCommand: "/tui-gamepigeon:arcade-update",
    };
  }
  if (method === "copied-adapter") {
    // An adapter install with no harness marker is the Claude skill install:
    // every other adapter's launcher command exports GAMEPIGEON_HARNESS.
    const adapterHarness = harness === "unknown" ? "claude" : harness;
    return {
      updateCommand: ["bun", "x", "@tui-games/tui@latest", "install", `--${adapterHarness}`],
      manualCommand: adapterInstallCommand(adapterHarness),
    };
  }
  if (method === "npm-global") {
    return {
      updateCommand: ["npm", "i", "-g", "@tui-games/tui@latest"],
      manualCommand: "npm i -g @tui-games/tui@latest",
    };
  }
  // A dev checkout has uncommitted work and a branch of its own; pulling it from
  // under the user is not the overlay's call. Unknown installs get the generic
  // installer, which rewrites whichever adapter is present.
  return {
    updateCommand: null,
    manualCommand: method === "dev" ? `git -C ${root} pull --ff-only` : "npx -y bun x @tui-games/tui@latest install",
  };
}

export function detectInstallContext(root: string, env: NodeJS.ProcessEnv = process.env): InstallContext {
  const harness = harnessFromEnv(env);
  const claudeInstallPath = readInstalledPlugin(resolvePluginUpdatePaths({
    homeDir: env.HOME,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR,
  }).installedPluginsPath)?.installPath;
  const updateMethod = resolveInstallMethod(root, harness, claudeInstallPath);
  return {
    harness,
    launcherRoot: root,
    updateMethod,
    ...resolveUpdatePlan(updateMethod, harness, root),
  };
}

export function writeInstallContext(context: InstallContext, path = installContextPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
}

export function resolvePluginUpdatePaths(options: {
  homeDir?: string;
  claudeConfigDir?: string;
} = {}): PluginUpdatePaths {
  const homeDir = options.homeDir ?? homedir();
  const claudeConfigDir = options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homeDir, ".claude");
  // Explicit homeDir (tests) always nests under that tree; production uses GAMEPIGEON_HOME or ~/.gamepigeon.
  const home = options.homeDir !== undefined ? join(homeDir, ".gamepigeon") : gamepigeonHome(homeDir);
  return {
    homeDir,
    claudeConfigDir,
    flagPath: join(home, "update-available.json"),
    statusLinePath: join(home, "status-line.ts"),
    installedPluginsPath: join(claudeConfigDir, "plugins", "installed_plugins.json"),
    knownMarketplacesPath: join(claudeConfigDir, "plugins", "known_marketplaces.json"),
  };
}

export function readUpdateFlag(flagPath: string): UpdateAvailableFlag | null {
  try {
    const parsed = JSON.parse(readFileSync(flagPath, "utf8"));
    if (
      typeof parsed.fromVersion === "string" &&
      typeof parsed.toVersion === "string" &&
      typeof parsed.fromLabel === "string" &&
      typeof parsed.toLabel === "string" &&
      typeof parsed.detectedAt === "string"
    ) {
      return parsed as UpdateAvailableFlag;
    }
  } catch {
    // Missing or malformed flag means no update nudge.
  }
  return null;
}

export function writeUpdateFlag(flagPath: string, flag: UpdateAvailableFlag): void {
  mkdirSync(dirname(flagPath), { recursive: true });
  writeFileSync(flagPath, `${JSON.stringify(flag, null, 2)}\n`, { mode: 0o600 });
}

export function clearUpdateFlag(flagPath: string): void {
  try {
    rmSync(flagPath, { force: true });
  } catch {
    // Best-effort cleanup.
  }
}

export function readPackageVersion(root = ROOT_DIR): string {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    // Fall through.
  }
  return "unknown";
}

export function readInstalledPlugin(
  installedPluginsPath: string,
  pluginKey = PLUGIN_KEY,
): InstalledPluginRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(installedPluginsPath, "utf8"));
    const entries = parsed?.plugins?.[pluginKey];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const record = entries[0];
    if (!record || typeof record !== "object") return null;
    return record as InstalledPluginRecord;
  } catch {
    return null;
  }
}

export function isDirectoryMarketplace(
  knownMarketplacesPath: string,
  marketplaceName = MARKETPLACE_NAME,
): boolean {
  try {
    const parsed = JSON.parse(readFileSync(knownMarketplacesPath, "utf8"));
    const source = parsed?.[marketplaceName]?.source as MarketplaceSource | undefined;
    return source?.source === "directory";
  } catch {
    return false;
  }
}

export function shouldSkipUpdateCheck(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GAMEPIGEON_SKIP_UPDATE_CHECK === "1";
}

export type GhManifestRunner = (slug: string) => Promise<ReleaseManifest | null>;

async function fetchRemoteReleaseManifestViaGh(slug: string): Promise<ReleaseManifest | null> {
  try {
    const proc = Bun.spawn(["gh", "api", `repos/${slug}/contents/overlay-release.json`, "--jq", ".content"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const encoded = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || !encoded) return null;
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Partial<ReleaseManifest>;
    if (typeof parsed.tag === "string" && typeof parsed.version === "string") {
      return { tag: parsed.tag, version: parsed.version };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the latest *published* release from the public release CDN. Its
 * `manifest.json` is written by the same `overlay.yml` release job that
 * commits `overlay-release.json` and uploads the binaries, so it only ever
 * names a version that is actually downloadable — unlike `package.json`'s
 * version, which lands on main as soon as the version-bump commit is pushed,
 * well before CI has built or released anything. Comparing against the version
 * bump would nudge users to update before a release even exists to download.
 *
 * This reads the CDN rather than `overlay-release.json` on GitHub because the
 * source repo is private: `raw.githubusercontent.com` 404s for everyone
 * without repo access, which silently disabled the update nudge for every end
 * user. `gh` remains as a fallback for developers working in the private repo.
 */
export async function fetchRemoteReleaseManifest(
  slug: string,
  request: FetchLike = fetch,
  runGh: GhManifestRunner = fetchRemoteReleaseManifestViaGh,
): Promise<ReleaseManifest | null> {
  try {
    const response = await request(`${RELEASES_BASE_URL}/manifest.json`, {
      headers: { "User-Agent": "tui-gamepigeon-plugin-update" },
    });
    if (response.ok) {
      const parsed = (await response.json()) as Partial<ReleaseManifest>;
      if (typeof parsed.tag === "string" && typeof parsed.version === "string") {
        return { tag: parsed.tag, version: parsed.version };
      }
    }
  } catch {
    // Fall through to gh, which authenticates against the private repo.
  }
  return runGh(slug);
}

/**
 * Compares dotted numeric versions (e.g. "0.2.3" vs "0.2.10"). Returns
 * positive if `a` > `b`, negative if `a` < `b`, 0 if equal or unparsable.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((n) => Number.parseInt(n, 10));
  const partsB = b.split(".").map((n) => Number.parseInt(n, 10));
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (Number.isNaN(numA) || Number.isNaN(numB)) return 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

/** Dotted numeric versions are the only shape `compareVersions` can rank. */
function isComparableVersion(value: string): boolean {
  return /^\d+(\.\d+)*$/.test(value);
}

/**
 * Best-effort "what version is actually installed right now?" for the running
 * harness, without touching the network. Claude Code has a marketplace install
 * record; every other harness only has the checkout's package.json. Returns
 * null when no comparable version can be resolved, so callers can distinguish
 * "definitely current" from "cannot tell".
 */
export function resolveInstalledVersion(
  paths: PluginUpdatePaths,
  harness: UpdateHarness = "claude",
  root = ROOT_DIR,
): string | null {
  if (harness === "claude") {
    const recorded = readInstalledPlugin(paths.installedPluginsPath)?.version;
    if (typeof recorded === "string" && isComparableVersion(recorded)) return recorded;
  }
  return resolvePackagedVersion(root);
}

/** package.json's version at the installed checkout, or null if unrankable. */
export function resolvePackagedVersion(root = ROOT_DIR): string | null {
  const packaged = readPackageVersion(root);
  return isComparableVersion(packaged) ? packaged : null;
}

/**
 * A flag written by an earlier session goes stale the moment the user upgrades:
 * the upgrade path clears it, but a manual install, a reinstall, or a crash
 * between the two leaves it behind. Re-check it against the installed version
 * before injecting nudge context. When the installed version is unknowable we
 * trust the flag rather than swallowing a real update.
 */
export function isUpdateFlagStillValid(
  flag: UpdateAvailableFlag,
  installedVersion: string | null,
): boolean {
  if (installedVersion === null) return true;
  return compareVersions(flag.toVersion, installedVersion) > 0;
}

export function formatUpdateVersions(flag: UpdateAvailableFlag): { from: string; to: string } {
  return {
    from: flag.fromLabel || flag.fromVersion,
    to: flag.toLabel || flag.toVersion,
  };
}

/** Subdued status-line text for an available plugin update (ASCII-safe for terminals). */
export function formatUpdateStatusLine(fromVersion: string, toVersion: string): string {
  const { reset, muted, ink, accent } = STATUS;
  return (
    `${muted}Tui${reset} ` +
    `${ink}${fromVersion}${reset}` +
    `${muted} → ${reset}` +
    `${accent}${toVersion}${reset} ` +
    `${muted}update available${reset}`
  );
}

export function statusLineScriptSource(flagPath: string): string {
  return `#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const FLAG_PATH = ${JSON.stringify(flagPath)};
const A = ${JSON.stringify(STATUS)};

try {
  const flag = JSON.parse(readFileSync(FLAG_PATH, "utf8"));
  const from = flag?.fromLabel || flag?.fromVersion;
  const to = flag?.toLabel || flag?.toVersion;
  if (typeof from === "string" && typeof to === "string") {
    process.stdout.write(
      A.muted + "Tui" + A.reset + " " +
      A.ink + from + A.reset +
      A.muted + " → " + A.reset +
      A.accent + to + A.reset + " " +
      A.muted + "update available" + A.reset
    );
    process.exit(0);
  }
} catch {
  // No update flag.
}
process.stdout.write("");
`;
}

export function writeStatusLineShim(statusLinePath: string, flagPath: string): void {
  mkdirSync(dirname(statusLinePath), { recursive: true });
  writeFileSync(statusLinePath, statusLineScriptSource(flagPath), { mode: 0o755 });
}

/** The nudge sentence itself. Each harness wraps it in its own hook envelope. */
export function nudgeContext(
  flag: UpdateAvailableFlag,
  harness: UpdateHarness = "claude",
  updateMethod?: InstallMethod,
): string {
  const { to } = formatUpdateVersions(flag);
  // `/tui-gamepigeon:arcade-update` is a *marketplace* plugin command. A Claude
  // copied adapter (the `npx -y bun x … install --claude` copy) has no such
  // command, so naming it there sends the user to something that does not
  // exist. Until this nudge shipped for copied adapters it was unreachable
  // wrong text; now it is the first thing those users would be told.
  const command = harness === "claude" && updateMethod === "copied-adapter"
    ? `Run: ${adapterInstallCommand("claude")}`
    : UPDATE_COMMANDS[harness];
  return `An update is available (${to}). ${command}`;
}

export function nudgeHookOutput(
  flag: UpdateAvailableFlag,
  harness: UpdateHarness = "claude",
  updateMethod?: InstallMethod,
): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: nudgeContext(flag, harness, updateMethod),
    },
  });
}

export async function runPluginUpdateCheck(options: {
  paths?: PluginUpdatePaths;
  root?: string;
  request?: FetchLike;
  runGhManifest?: GhManifestRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}): Promise<UpdateAvailableFlag | null> {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolvePluginUpdatePaths();
  const root = options.root ?? ROOT_DIR;
  const now = options.now ?? (() => new Date().toISOString());

  writeStatusLineShim(paths.statusLinePath, paths.flagPath);

  if (shouldSkipUpdateCheck(env)) return null;
  if (isDirectoryMarketplace(paths.knownMarketplacesPath)) return null;

  const installed = readInstalledPlugin(paths.installedPluginsPath);
  // No marketplace record means this Claude install is not a marketplace install
  // at all — it is the skill/bunx copy, whose only version of record is its own
  // package.json. Returning null here (as this used to) left those installs with
  // no update check whatsoever, so no flag was ever written and the overlay's
  // updater had nothing to act on.
  if (!installed?.gitCommitSha) return runAdapterUpdateCheck({ ...options, paths, root });

  const slug = repoSlug(root);
  // Compare against the published release manifest, not main's HEAD sha or
  // package.json — those move the instant a version-bump commit lands on
  // main, long before CI has finished building and releasing that version.
  const remoteManifest = await fetchRemoteReleaseManifest(
    slug,
    options.request ?? fetch,
    options.runGhManifest ?? fetchRemoteReleaseManifestViaGh,
  );
  if (!remoteManifest) return null;

  // An unrankable installed version (missing/garbled record and package.json)
  // means "cannot tell" — leave any existing flag alone rather than clearing
  // it or nudging on a comparison that would silently read as equal.
  const installedVersion = resolveInstalledVersion(paths, "claude", root);
  if (installedVersion === null) return null;
  const remoteVersion = remoteManifest.version;

  // Only nudge when the published release is strictly newer. The plugin
  // marketplace's own auto-update can pull main HEAD (including an
  // unreleased version bump) ahead of the last published release, so
  // equality isn't enough here — a plain "!==" would fire a nudge pointing
  // users backward to an older release while a build is still in flight.
  if (compareVersions(remoteVersion, installedVersion) <= 0) {
    clearUpdateFlag(paths.flagPath);
    return null;
  }

  const flag: UpdateAvailableFlag = {
    fromVersion: installedVersion,
    toVersion: remoteVersion,
    fromLabel: installedVersion,
    toLabel: remoteVersion,
    detectedAt: now(),
  };
  writeUpdateFlag(paths.flagPath, flag);
  return flag;
}

/**
 * Lighter sibling of runPluginUpdateCheck for harnesses with no package-manager-style
 * install record (all non-Claude adapters) to gate against. "Installed version" is simply
 * package.json at ROOT_DIR — wherever the npx installer placed this checkout.
 */
export async function runAdapterUpdateCheck(options: {
  paths?: PluginUpdatePaths;
  root?: string;
  request?: FetchLike;
  runGhManifest?: GhManifestRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}): Promise<UpdateAvailableFlag | null> {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolvePluginUpdatePaths();
  const root = options.root ?? ROOT_DIR;
  const now = options.now ?? (() => new Date().toISOString());

  writeStatusLineShim(paths.statusLinePath, paths.flagPath);

  if (shouldSkipUpdateCheck(env)) return null;

  const slug = repoSlug(root);
  const remoteManifest = await fetchRemoteReleaseManifest(
    slug,
    options.request ?? fetch,
    options.runGhManifest ?? fetchRemoteReleaseManifestViaGh,
  );
  if (!remoteManifest) return null;

  const installedVersion = resolvePackagedVersion(root);
  if (installedVersion === null) return null;
  const remoteVersion = remoteManifest.version;

  if (compareVersions(remoteVersion, installedVersion) <= 0) {
    clearUpdateFlag(paths.flagPath);
    return null;
  }

  const flag: UpdateAvailableFlag = {
    fromVersion: installedVersion,
    toVersion: remoteVersion,
    fromLabel: installedVersion,
    toLabel: remoteVersion,
    detectedAt: now(),
  };
  writeUpdateFlag(paths.flagPath, flag);
  return flag;
}

/**
 * The flag to nudge with, or null when there is nothing to say. Runs on every
 * prompt, so this gate stays local: no network, just the install record /
 * package.json the check already trusts.
 */
export function readNudgeableUpdateFlag(
  paths: PluginUpdatePaths = resolvePluginUpdatePaths(),
  harness: UpdateHarness = "claude",
  root = ROOT_DIR,
): UpdateAvailableFlag | null {
  const flag = readUpdateFlag(paths.flagPath);
  if (!flag) return null;
  if (!isUpdateFlagStillValid(flag, resolveInstalledVersion(paths, harness, root))) {
    clearUpdateFlag(paths.flagPath);
    return null;
  }
  return flag;
}

export function runPluginUpdateNudge(
  paths: PluginUpdatePaths = resolvePluginUpdatePaths(),
  harness: UpdateHarness = "claude",
  root = ROOT_DIR,
): string | null {
  const flag = readNudgeableUpdateFlag(paths, harness, root);
  if (!flag) return null;
  // Resolved here rather than baked into UPDATE_COMMANDS: the same harness is
  // reached by a marketplace install and by a copied adapter, and only the
  // former has the slash command.
  return nudgeHookOutput(flag, harness, detectInstallContext(root).updateMethod);
}

export function runPluginUpdateClear(paths: PluginUpdatePaths = resolvePluginUpdatePaths()): void {
  clearUpdateFlag(paths.flagPath);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const action = parsePluginUpdateAction(args);
  const harness = parseUpdateHarness(args);
  const paths = resolvePluginUpdatePaths();

  if (action === "clear") {
    runPluginUpdateClear(paths);
    return;
  }

  if (action === "nudge") {
    const output = runPluginUpdateNudge(paths, harness);
    if (output) process.stdout.write(`${output}\n`);
    return;
  }

  if (harness === "claude") {
    await runPluginUpdateCheck({ paths });
  } else {
    await runAdapterUpdateCheck({ paths });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
