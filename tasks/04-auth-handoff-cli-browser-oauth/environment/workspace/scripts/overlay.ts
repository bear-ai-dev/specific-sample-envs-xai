import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analytics } from "../src/analytics/posthog.js";
import type { AnalyticsCloudEvent } from "../src/analytics/events.js";
import { refreshSessionIfPresent } from "../src/auth.js";
import { readSettings } from "../src/settings.js";
import {
  clearUpdateFlag,
  formatUpdateVersions,
  isUpdateFlagStillValid,
  readUpdateFlag,
  resolvePackagedVersion,
  resolvePluginUpdatePaths,
  detectInstallContext,
  writeInstallContext,
  type InstallContext,
} from "./plugin-update.js";

export type OverlayAction = "show" | "enable" | "pause" | "hide" | "reset" | "quit";

export function shouldRunAction(action: OverlayAction, settings = readSettings()): boolean {
  return (action !== "show" || settings.autoOpenOnPrompt) &&
    (action !== "pause" || settings.autoPauseOnStop) &&
    (action !== "reset" || settings.resetOnNewSession);
}

export interface LaunchOptions {
  gameId?: string;
  variationId?: string;
}

export interface ReleaseManifest {
  tag: string;
  version: string;
}

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPO = "Trolleroof/tui-gamepigeon";
// Public, unauthenticated release CDN (Cloudflare Worker + R2). A fresh
// `npm install` has no GitHub credentials and the source repo is private, so
// GitHub Releases can't serve the binary — see cloudflare/releases-worker.
// Also the update-check source in plugin-update.ts, for the same reason.
export const RELEASES_BASE_URL = process.env.GAMEPIGEON_RELEASES_BASE_URL ?? "https://releases.runretroarcade.com";

// When the user hits "Shutdown" in the overlay, the window writes this flag and
// quits. While the flag exists we suppress `show`/`pause` so the overlay stops
// popping open for the rest of the session; the SessionStart `--reset` clears it.
const SHUTDOWN_FLAG = join(tmpdir(), ".gamepigeon-overlay.off");
const OVERLAY_LEASE_FILE = join(tmpdir(), ".gamepigeon-overlay.alive");
const PAUSED_FLAG = join(tmpdir(), ".gamepigeon-overlay.paused");
const ANALYTICS_QUEUE = join(homedir(), ".tui-gamepigeon", "analytics-events.jsonl");

async function flushAnalyticsQueue(): Promise<void> {
  if (!readSettings().productAnalytics || !process.env.POSTHOG_API_KEY || !existsSync(ANALYTICS_QUEUE)) return;
  try {
    const events = readFileSync(ANALYTICS_QUEUE, "utf8").trim().split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AnalyticsCloudEvent);
    for (const event of events) analytics.capture(event);
    // Bounded: this runs on the shutdown path, where a hung upload would stall
    // the session's exit. A dropped flush just stays queued for the next run.
    const flushed = await Promise.race([
      analytics.shutdown().then(() => true),
      Bun.sleep(2000).then(() => false),
    ]);
    if (flushed) rmSync(ANALYTICS_QUEUE, { force: true });
  } catch {
    // Keep the queue for the next launcher run.
  }
}

export function isShutDown(): boolean {
  return existsSync(SHUTDOWN_FLAG);
}

function clearShutdown(): void {
  try {
    rmSync(SHUTDOWN_FLAG, { force: true });
  } catch {
    // Best-effort: a leftover flag only means the overlay stays hidden.
  }
}

export function setOverlayLease(active: boolean, path = OVERLAY_LEASE_FILE): void {
  if (active) writeFileSync(path, "", { mode: 0o600 });
  else rmSync(path, { force: true });
}

export function parseAction(args: string[]): OverlayAction {
  const value = args[0] ?? "--show";
  if (value === "--show") return "show";
  if (value === "--enable") return "enable";
  if (value === "--pause") return "pause";
  if (value === "--hide") return "hide";
  if (value === "--reset") return "reset";
  if (value === "--quit" || value === "--stop") return "quit";
  throw new Error(`Unknown overlay action: ${value}`);
}

export function overlayExecutableName(): string {
  return process.platform === "win32" ? "gamepigeon-overlay.exe" : "gamepigeon-overlay";
}

export function linuxReleaseDistro(osRelease?: string): "ubuntu" | "fedora" | "linux" {
  try {
    const release = osRelease ?? readFileSync("/etc/os-release", "utf8");
    const id = /^ID=(.*)$/m.exec(release)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (id === "ubuntu" || id === "fedora") return id;
  } catch {}
  return "linux";
}

export function overlayReleaseAsset(): string {
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? linuxReleaseDistro()
          : process.platform;
  const extension = process.platform === "win32" ? ".exe" : "";
  return `gamepigeon-overlay-${platform}-${process.arch}${extension}`;
}

export function managedBinDir(): string {
  return process.env.GAMEPIGEON_OVERLAY_HOME ?? join(homedir(), ".gamepigeon", "bin");
}

export function managedBinaryPath(version: string): string {
  return join(managedBinDir(), version, overlayExecutableName());
}

export function readReleaseManifest(root = ROOT_DIR): ReleaseManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "overlay-release.json"), "utf8"));
    if (typeof parsed.tag === "string" && typeof parsed.version === "string") {
      return { tag: parsed.tag, version: parsed.version };
    }
  } catch {
    // No packaged release manifest; fall back to local builds.
  }
  return null;
}

export function repoSlug(root = ROOT_DIR): string {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    const match = /github\.com\/([^/]+\/[^/.]+)/.exec(parsed.repository ?? "");
    if (match?.[1]) return match[1];
  } catch {
    // Use the default repository below.
  }
  return DEFAULT_REPO;
}

export function overlayBinaryCandidates(root = ROOT_DIR, manifest = readReleaseManifest(root)): string[] {
  const executable = overlayExecutableName();
  const platform = process.platform === "darwin" ? "macos" : process.platform;
  // Last resort, for packaged copies only: the version named by `current`. A
  // plugin whose manifest trails the managed dir (another checkout downloaded a
  // newer overlay and pruned this one's version) would otherwise resolve nothing.
  // Local builds still win, so a dev checkout is unaffected.
  const current = manifest ? readCurrentVersion() : null;
  return [
    process.env.GAMEPIGEON_OVERLAY_BIN,
    manifest ? managedBinaryPath(manifest.version) : undefined,
    join(root, "bin", `${platform}-${process.arch}`, executable),
    join(root, "tauri", "target", "release", executable),
    join(root, "tauri", "target", "debug", executable),
    current && current !== manifest?.version ? managedBinaryPath(current) : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function isLaunchable(candidate: string): boolean {
  try {
    accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveOverlayBinary(root = ROOT_DIR, manifest = readReleaseManifest(root)): string {
  for (const candidate of overlayBinaryCandidates(root, manifest)) {
    if (isLaunchable(candidate)) return candidate;
  }
  throw new Error(
    "Tui overlay binary was not found. Run `bun run build:overlay` or install a packaged release.",
  );
}

interface RemoteReleaseManifest {
  version: string;
  tag: string;
  assets: Record<string, { sha256: string; size: number }>;
}

async function downloadReleaseBinary(manifest: ReleaseManifest): Promise<void> {
  const destination = managedBinaryPath(manifest.version);
  const staging = `${destination}.download`;
  mkdirSync(dirname(destination), { recursive: true });

  const asset = overlayReleaseAsset();
  const base = `${RELEASES_BASE_URL}/${manifest.tag}`;

  const manifestResponse = await fetch(`${base}/manifest.json`);
  if (!manifestResponse.ok) {
    throw new Error(`Overlay manifest fetch failed (${manifestResponse.status}) for ${manifest.tag}`);
  }
  const remoteManifest = (await manifestResponse.json()) as RemoteReleaseManifest;
  const expected = remoteManifest.assets?.[asset];
  if (!expected) {
    throw new Error(`No release asset named ${asset} in ${manifest.tag}/manifest.json`);
  }

  const response = await fetch(`${base}/${asset}`);
  if (!response.ok) {
    throw new Error(`Overlay download failed (${response.status}) for ${manifest.tag}/${asset}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expected.sha256) {
    throw new Error(`Overlay download checksum mismatch for ${manifest.tag}/${asset}`);
  }

  writeFileSync(staging, bytes);
  if (process.platform !== "win32") chmodSync(staging, 0o755);
  renameSync(staging, destination);
}

function pruneManagedBinaries(keepVersion: string): void {
  try {
    for (const entry of readdirSync(managedBinDir())) {
      if (entry !== keepVersion && entry !== "current") {
        rmSync(join(managedBinDir(), entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Nothing to prune.
  }
}

function readCurrentVersion(): string | null {
  try {
    return readFileSync(join(managedBinDir(), "current"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Detached so a Ctrl+C that ends the session cannot take the quit down with it:
// the signal reaches the whole foreground process group, and this child must
// outlive that.
//
// `wait` is for the upgrade path, where the old instance has to be gone before
// the new binary launches. The SessionEnd hook must not wait: every millisecond
// it stays alive is a millisecond in which the exiting session can abort it and
// print a "Hook cancelled" failure at the user. The detached child finishes the
// quit on its own either way.
function quitOverlay(binary: string, wait = true): Promise<unknown> {
  const child = Bun.spawn([binary, "--quit"], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  if (!wait) return Promise.resolve();
  return Promise.race([child.exited, Bun.sleep(2000)]);
}

/**
 * Downloads the packaged overlay binary named by overlay-release.json when the
 * managed copy is missing or stale, quitting a running older instance so the
 * next launch runs the fresh build. Failures fall back to whatever binary is
 * already resolvable so an offline session keeps working.
 */
export async function ensureOverlayBinary(root = ROOT_DIR): Promise<void> {
  const manifest = readReleaseManifest(root);
  if (!manifest) return;

  const destination = managedBinaryPath(manifest.version);
  if (!isLaunchable(destination)) {
    try {
      await downloadReleaseBinary(manifest);
    } catch {
      return;
    }
  }

  const previous = readCurrentVersion();
  if (previous && previous !== manifest.version) {
    const stale = managedBinaryPath(previous);
    if (isLaunchable(stale)) await quitOverlay(stale);
  }
  writeFileSync(join(managedBinDir(), "current"), manifest.version);
  pruneManagedBinaries(manifest.version);
}

export function applyOverlayLease(action: OverlayAction, leasePath = OVERLAY_LEASE_FILE): void {
  if (action === "quit") setOverlayLease(false, leasePath);
  else if (action === "show" || action === "enable") setOverlayLease(true, leasePath);
}

function overlaySpawnArgs(action: OverlayAction, options: LaunchOptions = {}): string[] {
  const args = [`--${action}`];
  if (options.gameId) args.push("--game", options.gameId);
  if (options.variationId) args.push("--variation", options.variationId);
  return args;
}

const ADAPTER_UPDATE_HARNESSES = new Set<string>([
  "codex",
  "opencode",
  "hermes",
  "openclaw",
  "antigravity",
]);

/**
 * Which harness to run the update check as, or null when this launch owns no
 * check. Every adapter exports `GAMEPIGEON_HARNESS`, so its absence used to end
 * the check outright — correct for a Claude *marketplace* install, which the
 * plugin hook covers, but wrong for a Claude *skill* install (the `npx -y bun x
 * … install` copy). That one has no harness marker, no marketplace hook, and a
 * launcher pinned to the temp directory it was installed from, so skipping it
 * here left it with no way to ever learn a new release existed.
 */
export function adapterCheckHarness(context: InstallContext): string | null {
  const harness = process.env.GAMEPIGEON_HARNESS;
  // "claude" has to fall through to the install-method test rather than being
  // looked up in the set. `run-with-bun.cjs` turns the lifecycle hooks'
  // `--harness claude` into GAMEPIGEON_HARNESS=claude, so this branch *is* the
  // Claude hook path — and the set deliberately excludes "claude" because a
  // Claude *marketplace* install must not check here. Matching on the set alone
  // returned null for both, which silently disabled the check on every Claude
  // hook and left `--enable` (the skill command, which carries no `--harness`)
  // as the only path that ever ran one.
  if (harness && harness !== "claude") return ADAPTER_UPDATE_HARNESSES.has(harness) ? harness : null;
  return context.updateMethod === "copied-adapter" ? "claude" : null;
}

/**
 * Copied adapters have no shared package-manager update hook, so the Tui
 * command's `--enable` call and the SessionStart `--reset` hook detect and
 * nudge. Only a Claude *marketplace* install opts out, since hooks/hooks.json
 * already runs the check for it.
 *
 * `reset` matters as much as `enable` here: `enable` only ever fires when the
 * user explicitly invokes the Tui skill, so an install driven purely by the
 * lifecycle hooks never ran a check at all — no flag was written, and the
 * overlay's `checkAndAutoUpdate` had nothing to act on, so a copied adapter
 * could sit on a stale version forever. `reset` is once per session, already
 * off the steady-state fast path, and the check itself is a detached spawn, so
 * it costs the launch nothing.
 *
 * `show` and `pause` stay out: they fire on every prompt and every turn end,
 * and on Codex they run synchronously in front of the user.
 */
export function ownsUpdateCheck(action: OverlayAction): boolean {
  return action === "enable" || action === "reset";
}

function notifyAdapterUpdateIfDue(action: OverlayAction, root: string, context: InstallContext): void {
  if (!ownsUpdateCheck(action) || process.env.GAMEPIGEON_OVERLAY_DRY_RUN === "1") return;
  const checkHarness = adapterCheckHarness(context);
  if (!checkHarness) return;

  const paths = resolvePluginUpdatePaths();
  const flag = readUpdateFlag(paths.flagPath);
  if (flag) {
    if (isUpdateFlagStillValid(flag, resolvePackagedVersion(root))) {
      const { from, to } = formatUpdateVersions(flag);
      console.log(`Update available: ${from} -> ${to}`);
    } else {
      // The checkout already caught up; drop the flag so the status line and
      // the next launch stop advertising a release the user is on.
      clearUpdateFlag(paths.flagPath);
    }
  }

  // `bun` is resolved from PATH, and run-with-bun.cjs launches its absolute bun
  // without putting that directory on PATH — so on a harness with a minimal hook
  // environment this throws ENOENT. Now that the check also runs on `--reset`,
  // an unguarded throw would abort the whole session-start launch before the
  // lease and shutdown flag are handled, taking the overlay down for the session
  // over a background update check that is best-effort by design.
  try {
    const child = Bun.spawn(
      ["bun", join(root, "scripts", "plugin-update.ts"), "--check", "--harness", checkHarness],
      { cwd: root, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    child.unref();
  } catch {
    // No reachable Bun means no check this session; the launch continues.
  }
}

/**
 * True when a launch has nothing slow left to do. `show` and `pause` fire on
 * every prompt and every turn end — and on Codex they run synchronously, in
 * front of the user — so they are the one path where startup cost is felt
 * repeatedly. Once the overlay is already up, the binary is resolved, the
 * session was refreshed at launch, and the analytics queue is durable until the
 * next `reset`/`enable`, so all of that prep is pure latency.
 *
 * `enable` deliberately stays on the slow path: it is the explicit, occasional
 * `$arcade` invocation, and it owns the update nudge.
 */
export function isSteadyStateLaunch(
  action: OverlayAction,
  leasePath = OVERLAY_LEASE_FILE,
  shutdownPath = SHUTDOWN_FLAG,
): boolean {
  if (action !== "show" && action !== "pause") return false;
  return existsSync(leasePath) && !existsSync(shutdownPath);
}

export async function launchOverlay(
  action: OverlayAction,
  root = ROOT_DIR,
  options: LaunchOptions = {},
): Promise<void> {
  if (!shouldRunAction(action)) return;
  const installContext = detectInstallContext(root);
  writeInstallContext(installContext);
  notifyAdapterUpdateIfDue(action, root, installContext);
  const steadyState = isSteadyStateLaunch(action);
  if (action !== "quit" && !steadyState) await flushAnalyticsQueue();
  if (
    (action === "show" || action === "enable") &&
    !steadyState &&
    process.env.GAMEPIGEON_OVERLAY_DRY_RUN !== "1"
  ) {
    // Refresh an existing session only — never open a browser here. This runs
    // on every UserPromptSubmit hook, so triggering interactive sign-in from
    // it would pop a new login tab on every prompt while signed out. The
    // overlay's own gate screen owns interactive sign-in (explicit click/Enter).
    await refreshSessionIfPresent();
  }
  // A new session re-enables the overlay; every other action honors the shutdown flag.
  applyOverlayLease(action);
  if (action === "quit") {
    try {
      rmSync(PAUSED_FLAG, { force: true });
    } catch {}
  }
  if (action === "reset" || action === "enable") clearShutdown();
  else if ((action === "show" || action === "pause") && isShutDown()) return;

  if (action === "pause") {
    if (!existsSync(OVERLAY_LEASE_FILE) || existsSync(PAUSED_FLAG)) return;
    try {
      writeFileSync(PAUSED_FLAG, "", { mode: 0o600 });
    } catch {}
  } else if (action === "show" || action === "enable") {
    try {
      rmSync(PAUSED_FLAG, { force: true });
    } catch {}
  }

  // An explicit binary is a development override: never replace it with a download.
  // Shutdown never downloads either — it only widens the window for the session's
  // Ctrl+C to kill this hook mid-flight.
  if (
    action !== "quit" &&
    !steadyState &&
    process.env.GAMEPIGEON_OVERLAY_DRY_RUN !== "1" &&
    !process.env.GAMEPIGEON_OVERLAY_BIN
  ) {
    await ensureOverlayBinary(root);
  }
  // No resolvable binary means there is nothing running to shut down, so quit
  // succeeds by doing nothing rather than failing the SessionEnd hook at the user.
  let binary: string;
  try {
    binary = resolveOverlayBinary(root);
  } catch (error) {
    if (action === "quit") return;
    throw error;
  }
  const spawnArgs = overlaySpawnArgs(action, options);
  if (process.env.GAMEPIGEON_OVERLAY_DRY_RUN === "1") {
    console.log(JSON.stringify([binary, ...spawnArgs]));
    return;
  }
  if (action === "quit") {
    await quitOverlay(binary, false);
    return;
  }
  const child = Bun.spawn([binary, ...spawnArgs], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      GAMEPIGEON_OVERLAY_LEASE: OVERLAY_LEASE_FILE,
      ...(options.gameId ? { GAMEPIGEON_GAME: options.gameId } : {}),
      ...(options.variationId ? { GAMEPIGEON_VARIATION: options.variationId } : {}),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const action = parseAction(args);
    // Ctrl+C signals the whole foreground group, so the SessionEnd hook takes the
    // same SIGINT that ended the session and dies before it can tear the overlay
    // down. Hold the signals off; the work here is short and always terminates.
    if (action === "quit") {
      process.on("SIGINT", () => {});
      process.on("SIGTERM", () => {});
      process.on("SIGHUP", () => {});
    }
    const gameFlag = args.indexOf("--game");
    const variationFlag = args.indexOf("--variation");
    const gameId = gameFlag >= 0 ? args[gameFlag + 1] : undefined;
    const variationId = variationFlag >= 0 ? args[variationFlag + 1] : undefined;
    await launchOverlay(action, ROOT_DIR, { gameId, variationId });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
