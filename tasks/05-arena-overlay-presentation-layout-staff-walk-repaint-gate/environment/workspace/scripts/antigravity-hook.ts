/**
 * Antigravity (`agy`) lifecycle bridge.
 *
 * Antigravity does not implement Claude Code's hook events. It fires
 * `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`,
 * `PostInvocation` and `Stop` — there is no `UserPromptSubmit` and no
 * `SessionEnd` — and an unknown key in `hooks.json` is dropped silently, which
 * is why the plugin's handlers for those two never ran and the overlay never
 * opened on a prompt, resumed, or shut down there.
 *
 * This script maps the overlay lifecycle onto the events Antigravity actually
 * has:
 *
 *   - `PreInvocation` stands in for `UserPromptSubmit`. It fires before every
 *     model call, so the turn boundary is reconstructed from a small session
 *     state file: the first invocation of a new session resets and shows, the
 *     first invocation after a `Stop` resumes, and mid-turn invocations are a
 *     no-op.
 *   - `Stop` pauses, exactly as it does on Claude.
 *   - `SessionStart` only flags that state file. It is absent from `agy`'s own
 *     hooks documentation, so the new-session decision stays in `PreInvocation`
 *     where it can be made without it.
 *   - Nothing fires at session end, so a detached watchdog waits for the `agy`
 *     process to exit and quits the overlay then.
 *
 * Two contract details drive the shape of the code. Hook stdout is parsed as
 * JSON, so this script owns stdout and every overlay call is spawned detached
 * with its output discarded. And hooks run synchronously inside the agent loop
 * (30s default timeout, no `async` flag like Claude has), so the hook itself
 * only touches local files and returns.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OverlayAction } from "./overlay.js";
import {
  gamepigeonHome,
  nudgeContext,
  readNudgeableUpdateFlag,
  resolvePluginUpdatePaths,
} from "./plugin-update.js";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = "antigravity";
/** How long the watchdog sleeps between liveness checks on the `agy` process. */
const WATCHDOG_INTERVAL_SECONDS = 2;

export type AntigravityHookEvent = "session-start" | "pre-invocation" | "stop";

/** Common fields Antigravity sends on stdin (protojson, camelCase). */
export interface AntigravityHookPayload {
  conversationId?: string;
}

export interface AntigravitySessionState {
  harnessPid: number | null;
  conversationId: string | null;
  phase: "running" | "stopped";
  watchdogPid: number | null;
  /**
   * `SessionStart` fired: the next `PreInvocation` starts a session whatever
   * the ids say. An explicit flag rather than a cleared file, so the state
   * always names the process that owns the overlay — a watchdog left over from
   * the previous session reads it to decide whether the quit is still its call.
   */
  pendingReset: boolean;
}

export interface AntigravityHookPlan {
  /** Overlay actions to run, in order, in one detached child. */
  overlayActions: OverlayAction[];
  /** Kick off the background release check (once per session, like SessionStart). */
  checkForUpdate: boolean;
  /** Start the session-end watchdog for `harnessPid`. */
  startWatchdog: boolean;
  /** Inject the update nudge into this invocation. */
  nudge: boolean;
  state: AntigravitySessionState;
}

export function parseHookEvent(args: string[]): AntigravityHookEvent {
  const value = args[0];
  if (value === "--session-start") return "session-start";
  if (value === "--pre-invocation") return "pre-invocation";
  if (value === "--stop") return "stop";
  throw new Error(`Unknown Antigravity hook event: ${value ?? "(none)"}`);
}

export function sessionStatePath(): string {
  return process.env.GAMEPIGEON_ANTIGRAVITY_STATE ?? join(gamepigeonHome(), "antigravity-session.json");
}

export function readSessionState(path: string): AntigravitySessionState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      harnessPid: typeof parsed.harnessPid === "number" ? parsed.harnessPid : null,
      conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : null,
      phase: parsed.phase === "stopped" ? "stopped" : "running",
      watchdogPid: typeof parsed.watchdogPid === "number" ? parsed.watchdogPid : null,
      pendingReset: parsed.pendingReset === true,
    };
  } catch {
    // No readable state means "treat the next invocation as a fresh session".
    return null;
  }
}

export function writeSessionState(path: string, state: AntigravitySessionState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A lost write costs one redundant reset next turn, never a failed hook.
  }
}

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The `agy` process behind this hook. Hooks run through `sh -c`, so the harness
 * is a grandparent rather than the parent; walk up until a command name looks
 * like the CLI. Returns null when it cannot be identified (Windows, or a shell
 * chain deeper than the walk), which only costs the session-end watchdog.
 */
export function resolveHarnessPid(
  startPid = process.ppid,
  inspect = inspectProcess,
): number | null {
  let pid = startPid;
  for (let depth = 0; depth < 6 && pid > 1; depth += 1) {
    const info = inspect(pid);
    if (!info) return null;
    if (/(^|\/)(agy|antigravity)/i.test(info.command)) return pid;
    pid = info.parentPid;
  }
  return null;
}

function inspectProcess(pid: number): { parentPid: number; command: string } | null {
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return null;
  const match = /^\s*(\d+)\s+(.*)$/.exec(result.stdout.trim());
  if (!match) return null;
  return { parentPid: Number(match[1]), command: match[2].trim() };
}

/**
 * Reconstructs the turn boundary Antigravity does not report.
 *
 * A session is "new" when the harness process or the conversation changed —
 * a fresh `agy`, an `agy -c` resume, or a new conversation inside one session.
 * Antigravity's own `SessionStart` is a shortcut to the same conclusion, not a
 * prerequisite for it.
 */
export function planHook(input: {
  event: Exclude<AntigravityHookEvent, "session-start">;
  conversationId: string | null;
  harnessPid: number | null;
  previous: AntigravitySessionState | null;
}): AntigravityHookPlan {
  const { event, conversationId, harnessPid, previous } = input;
  const carriedWatchdog = previous?.watchdogPid ?? null;
  // A field the payload omitted, or a pid the ancestor walk could not resolve,
  // is missing information — never evidence that the session changed. Carrying
  // the known value forward keeps one such gap from restarting a live turn.
  const knownPid = harnessPid ?? previous?.harnessPid ?? null;
  const knownConversation = conversationId ?? previous?.conversationId ?? null;

  if (event === "stop") {
    const alreadyStopped = previous?.phase === "stopped";
    return {
      overlayActions: alreadyStopped ? [] : ["pause"],
      checkForUpdate: false,
      startWatchdog: false,
      nudge: false,
      state: {
        harnessPid: knownPid,
        conversationId: knownConversation,
        phase: "stopped",
        watchdogPid: carriedWatchdog,
        pendingReset: previous?.pendingReset ?? false,
      },
    };
  }

  const changed = (before: unknown, now: unknown) =>
    before !== null && now !== null && before !== now;
  const sameSession =
    previous !== null &&
    !previous.pendingReset &&
    !changed(previous.harnessPid, harnessPid) &&
    !changed(previous.conversationId, conversationId);
  const newSession = !sameSession;
  const resuming = sameSession && previous.phase === "stopped";

  return {
    // Reset before show: reset clears the shutdown flag and snaps a stale
    // overlay back to the menu, and show is what opens the window.
    overlayActions: newSession ? ["reset", "show"] : resuming ? ["show"] : [],
    checkForUpdate: newSession,
    // Not just on a new session: an ancestor walk that only succeeds on a later
    // invocation is the first chance this session has to arm one. `runHook`
    // drops the redundant ones by reusing a watchdog that is still alive.
    startWatchdog: knownPid !== null,
    nudge: newSession || resuming,
    state: {
      harnessPid: knownPid,
      conversationId: knownConversation,
      phase: "running",
      watchdogPid: newSession ? null : carriedWatchdog,
      pendingReset: false,
    },
  };
}

export interface HookSideEffects {
  /** Runs overlay actions, in order, outside the agent loop. */
  applyOverlayActions: (actions: OverlayAction[]) => void;
  checkForUpdate: () => void;
  /** Returns the watchdog pid, or null when one could not be started. */
  startWatchdog: (harnessPid: number) => number | null;
  readNudge: () => string | null;
}

/** The JSON object Antigravity reads back from the hook, as a string. */
export function runHook(
  input: {
    event: AntigravityHookEvent;
    conversationId: string | null;
    harnessPid: number | null;
    statePath: string;
  },
  effects: HookSideEffects,
): string {
  const previous = readSessionState(input.statePath);

  if (input.event === "session-start") {
    // Flagging the session is all this has to do: the next PreInvocation finds
    // `pendingReset` and runs the full new-session path. Keeping the decision
    // there means the lifecycle never depends on SessionStart firing, which
    // matters because it is undocumented, unlike PreInvocation and Stop.
    //
    // The state is rewritten rather than deleted so it keeps naming the process
    // that owns the overlay from this moment on. A watchdog still counting down
    // on the previous session reads that owner before it quits anything.
    const sameHarness = previous !== null && previous.harnessPid === input.harnessPid;
    writeSessionState(input.statePath, {
      harnessPid: input.harnessPid,
      conversationId: null,
      phase: "stopped",
      // A watchdog belonging to a different process watches the wrong pid; drop
      // it and let the next invocation arm one for this session.
      watchdogPid: sameHarness ? previous.watchdogPid : null,
      pendingReset: true,
    });
    return "{}";
  }

  const plan = planHook({ ...input, event: input.event, previous });

  if (plan.overlayActions.length > 0) effects.applyOverlayActions(plan.overlayActions);
  if (plan.checkForUpdate) effects.checkForUpdate();
  const owner = plan.state.harnessPid;
  if (plan.startWatchdog && owner !== null) {
    if (isProcessAlive(previous?.watchdogPid) && previous?.harnessPid === owner) {
      plan.state.watchdogPid = previous.watchdogPid;
    } else {
      plan.state.watchdogPid = effects.startWatchdog(owner);
    }
  }
  writeSessionState(input.statePath, plan.state);

  const nudge = plan.nudge ? effects.readNudge() : null;
  // PreInvocation's `injectSteps` is Antigravity's equivalent of the
  // `additionalContext` Claude takes from UserPromptSubmit stdout.
  return nudge ? JSON.stringify({ injectSteps: [{ ephemeralMessage: nudge }] }) : "{}";
}

function bunPath(): string {
  return process.execPath && process.execPath.includes("bun") ? process.execPath : "bun";
}

function scriptPath(): string {
  return fileURLToPath(import.meta.url);
}

function spawnDetached(command: string[]): number | null {
  try {
    const child = Bun.spawn(command, {
      cwd: ROOT_DIR,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, GAMEPIGEON_HARNESS: HARNESS },
    });
    child.unref();
    return child.pid;
  } catch {
    // A hook that cannot spawn still has to return valid JSON to the agent.
    return null;
  }
}

const defaultEffects: HookSideEffects = {
  applyOverlayActions(actions) {
    spawnDetached([bunPath(), scriptPath(), "--apply", actions.join(",")]);
  },
  checkForUpdate() {
    spawnDetached([
      bunPath(),
      join(ROOT_DIR, "scripts", "plugin-update.ts"),
      "--check",
      "--harness",
      HARNESS,
    ]);
  },
  startWatchdog(harnessPid) {
    if (process.platform === "win32") return null;
    // A shell loop rather than another runtime: this outlives the whole session,
    // so it has to stay near-free. `$1`-style arguments keep paths unquoted.
    return spawnDetached([
      "sh",
      "-c",
      `while kill -0 "$1" 2>/dev/null; do sleep ${WATCHDOG_INTERVAL_SECONDS}; done; exec "$2" "$3" --apply quit --owner "$1"`,
      "sh",
      String(harnessPid),
      bunPath(),
      scriptPath(),
    ]);
  },
  readNudge() {
    try {
      const flag = readNudgeableUpdateFlag(resolvePluginUpdatePaths(), HARNESS, ROOT_DIR);
      return flag ? nudgeContext(flag, HARNESS) : null;
    } catch {
      return null;
    }
  },
};

/**
 * Bounded because the hook blocks the agent loop. The timer is unref'd: a
 * pending `Bun.sleep` would keep the process alive for its full duration even
 * after stdin resolved, which turns a 20ms hook into a 2s one.
 */
function withTimeout<T>(work: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), milliseconds);
    timer.unref?.();
    const settle = (value: T) => {
      clearTimeout(timer);
      resolve(value);
    };
    work.then(settle, () => settle(fallback));
  });
}

async function readPayload(): Promise<AntigravityHookPayload> {
  if (process.stdin.isTTY) return {};
  try {
    const text = await withTimeout(Bun.stdin.text(), 2000, "");
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as AntigravityHookPayload) : {};
  } catch {
    // An unreadable payload just means an unidentified conversation.
    return {};
  }
}

/**
 * The watchdog fires long after it was started, so it re-checks who owns the
 * overlay before tearing anything down: leaking an overlay is a smaller failure
 * than closing one a live session is using. State that names another process —
 * including the `SessionStart` of a session that has not reached its first
 * invocation yet — means the quit is no longer this watchdog's call.
 */
export function watchdogOwnsOverlay(
  state: AntigravitySessionState | null,
  owner: number,
): boolean {
  if (state === null) return true;
  return state.harnessPid === null || state.harnessPid === owner;
}

/**
 * Overlay actions are applied by detached children, one per hook event, so two
 * of them can be in flight at once — and `show` is the slow one (session
 * refresh, possibly a binary download). Without a lock a `pause` spawned by a
 * fast `Stop` can land before the `show` it is supposed to follow, which leaves
 * the game running while the agent is idle. The lock is advisory: if it cannot
 * be taken the actions still run, just unordered, which is no worse than not
 * having one.
 */
async function withApplyLock(work: () => Promise<void>): Promise<void> {
  const path = join(gamepigeonHome(), "antigravity-apply.lock");
  const deadline = Date.now() + 5000;
  let handle: number | null = null;

  while (handle === null && Date.now() < deadline) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      handle = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
      let stale = false;
      try {
        stale = Date.now() - statSync(path).mtimeMs > 30_000;
      } catch {
        // The holder released it between the failed open and this stat.
      }
      if (stale) rmSync(path, { force: true });
      else Bun.sleepSync(50);
    }
  }

  try {
    await work();
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {}
      rmSync(path, { force: true });
    }
  }
}

/** `--apply <action>[,<action>]`: the detached arm that actually drives the overlay. */
async function applyActions(args: string[]): Promise<void> {
  // The last `Stop` of a session is followed within milliseconds by `agy`
  // tearing down, and a Ctrl+C reaches the whole foreground process group. This
  // arm is detached, short, and always terminates, so it holds the signals off
  // and finishes — the same reasoning as the overlay's own quit path.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
  const { launchOverlay } = await import("./overlay.js");
  const actions = (args[1] ?? "").split(",").filter(Boolean) as OverlayAction[];
  const ownerFlag = args.indexOf("--owner");
  const owner = ownerFlag >= 0 ? Number(args[ownerFlag + 1]) : null;

  await withApplyLock(async () => {
    if (owner !== null && Number.isFinite(owner)) {
      // Re-read under the lock: a session that started while this watchdog was
      // queued behind a `show` has already recorded itself as the owner.
      if (!watchdogOwnsOverlay(readSessionState(sessionStatePath()), owner)) return;
      try {
        rmSync(sessionStatePath(), { force: true });
      } catch {
        // The next session's state write overwrites it anyway.
      }
    }

    for (const action of actions) {
      try {
        await launchOverlay(action, ROOT_DIR);
      } catch {
        // Best-effort: a missing binary or a failed download must not stop the
        // remaining actions, and nothing is listening to this process anyway.
      }
    }
  });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "--apply") {
    await applyActions(args);
    return;
  }

  const event = parseHookEvent(args);
  const payload = await readPayload();
  const statePath = sessionStatePath();
  const previous = readSessionState(statePath);
  const conversationId = payload.conversationId ?? null;
  // The ancestor walk shells out, so skip it on the hot path: an unchanged,
  // still-running harness is the common case for mid-turn invocations. A
  // payload without a conversation id is not a changed one — re-walking there
  // would resolve the same pid at the cost of a handful of `ps` calls.
  const unchangedConversation =
    conversationId === null || previous?.conversationId === conversationId;
  const harnessPid =
    previous && unchangedConversation && isProcessAlive(previous.harnessPid)
      ? previous.harnessPid
      : resolveHarnessPid();

  process.stdout.write(
    runHook({ event, conversationId, harnessPid, statePath }, defaultEffects),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Antigravity surfaces a hook that exits non-zero as an error at the user,
    // and a hook that prints prose as a parse failure. Fail quiet and valid.
    console.error(error instanceof Error ? error.message : String(error));
    process.stdout.write("{}");
  }
}
