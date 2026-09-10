import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverlayAction } from "./overlay.js";
import {
  parseHookEvent,
  planHook,
  readSessionState,
  resolveHarnessPid,
  runHook,
  watchdogOwnsOverlay,
  writeSessionState,
  type AntigravitySessionState,
  type HookSideEffects,
} from "./antigravity-hook.js";

/**
 * What `agy` actually registers: the five events in its own hooks documentation,
 * plus SessionStart, which it fires but does not document. Notably absent, and
 * silently dropped when declared: UserPromptSubmit and SessionEnd.
 */
const ANTIGRAVITY_EVENTS = new Set([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PreInvocation",
  "PostInvocation",
  "Stop",
]);

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), "gamepigeon-agy-")), "antigravity-session.json");
}

function recorder(nudge: string | null = null) {
  const calls = {
    overlay: [] as OverlayAction[][],
    updateChecks: 0,
    watchdogs: [] as number[],
  };
  const effects: HookSideEffects = {
    applyOverlayActions: (actions) => calls.overlay.push(actions),
    checkForUpdate: () => {
      calls.updateChecks += 1;
    },
    startWatchdog: (pid) => {
      calls.watchdogs.push(pid);
      // A pid that is actually alive, so runHook's "reuse the running watchdog"
      // branch is the one under test rather than a respawn.
      return process.pid;
    },
    readNudge: () => nudge,
  };
  return { calls, effects };
}

describe("antigravity hooks.json", () => {
  test("declares only events Antigravity actually fires", () => {
    const hooks = JSON.parse(readFileSync(new URL("../hooks.json", import.meta.url), "utf8"));
    const events = Object.keys(hooks["tui-gamepigeon"]).filter((key) => key !== "enabled");
    expect(events.every((event) => ANTIGRAVITY_EVENTS.has(event))).toBe(true);
    expect(events).toEqual(["SessionStart", "PreInvocation", "Stop"]);
    expect(hooks["tui-gamepigeon"].SessionStart[0].command).toBe(
      "node ./scripts/run-with-bun.cjs ./scripts/antigravity-hook.ts --session-start",
    );
    expect(hooks["tui-gamepigeon"].PreInvocation[0].command).toBe(
      "node ./scripts/run-with-bun.cjs ./scripts/antigravity-hook.ts --pre-invocation",
    );
    expect(hooks["tui-gamepigeon"].Stop[0].command).toBe(
      "node ./scripts/run-with-bun.cjs ./scripts/antigravity-hook.ts --stop",
    );
  });
});

describe("antigravity hook events", () => {
  test("accepts the lifecycle events and rejects anything else", () => {
    expect(parseHookEvent(["--session-start"])).toBe("session-start");
    expect(parseHookEvent(["--pre-invocation"])).toBe("pre-invocation");
    expect(parseHookEvent(["--stop"])).toBe("stop");
    expect(() => parseHookEvent([])).toThrow("Unknown Antigravity hook event");
    expect(() => parseHookEvent(["--user-prompt-submit"])).toThrow("Unknown Antigravity hook event");
  });

  test("SessionStart hands the new-session decision to the next PreInvocation", () => {
    const path = statePath();
    const { calls, effects } = recorder();
    const input = { conversationId: "conv-1", harnessPid: 100, statePath: path };
    runHook({ event: "pre-invocation", ...input }, effects);
    runHook({ event: "stop", ...input }, effects);

    // Same pid, same conversation: without SessionStart this would only resume.
    expect(JSON.parse(runHook({ event: "session-start", ...input }, effects))).toEqual({});
    // Flagged, not deleted: the state keeps naming the process that owns the
    // overlay so a watchdog from the previous session does not close it.
    expect(readSessionState(path)).toMatchObject({ harnessPid: 100, pendingReset: true });
    runHook({ event: "pre-invocation", ...input }, effects);
    expect(calls.overlay).toEqual([["reset", "show"], ["pause"], ["reset", "show"]]);
  });
});

describe("turn reconstruction", () => {
  const session = { conversationId: "conv-1", harnessPid: 100 };

  test("a first invocation resets, shows, checks for updates and arms the watchdog", () => {
    const plan = planHook({ event: "pre-invocation", ...session, previous: null });
    expect(plan.overlayActions).toEqual(["reset", "show"]);
    expect(plan.checkForUpdate).toBe(true);
    expect(plan.startWatchdog).toBe(true);
    expect(plan.state.phase).toBe("running");
  });

  test("mid-turn invocations do nothing", () => {
    const previous: AntigravitySessionState = {
      ...session,
      phase: "running",
      watchdogPid: 4242,
      pendingReset: false,
    };
    const plan = planHook({ event: "pre-invocation", ...session, previous });
    expect(plan.overlayActions).toEqual([]);
    expect(plan.checkForUpdate).toBe(false);
    expect(plan.nudge).toBe(false);
    expect(plan.state.watchdogPid).toBe(4242);
  });

  test("Stop pauses once, and the next prompt resumes", () => {
    const running: AntigravitySessionState = { ...session, phase: "running", watchdogPid: 4242, pendingReset: false };
    const stopped = planHook({ event: "stop", ...session, previous: running });
    expect(stopped.overlayActions).toEqual(["pause"]);
    expect(stopped.state.phase).toBe("stopped");

    // Antigravity can fire Stop more than once for one turn; pause is not idempotent
    // on the overlay side (it re-focuses the window), so the second one is dropped.
    const again = planHook({ event: "stop", ...session, previous: stopped.state });
    expect(again.overlayActions).toEqual([]);

    const resumed = planHook({ event: "pre-invocation", ...session, previous: stopped.state });
    expect(resumed.overlayActions).toEqual(["show"]);
    expect(resumed.checkForUpdate).toBe(false);
    expect(resumed.state.phase).toBe("running");
  });

  test("a new conversation or a new agy process counts as a new session", () => {
    const previous: AntigravitySessionState = { ...session, phase: "running", watchdogPid: 4242, pendingReset: false };
    const newConversation = planHook({
      event: "pre-invocation",
      conversationId: "conv-2",
      harnessPid: 100,
      previous,
    });
    expect(newConversation.overlayActions).toEqual(["reset", "show"]);

    // `agy -c` resumes the same conversation under a new process.
    const resumedSession = planHook({
      event: "pre-invocation",
      conversationId: "conv-1",
      harnessPid: 200,
      previous,
    });
    expect(resumedSession.overlayActions).toEqual(["reset", "show"]);
    expect(resumedSession.startWatchdog).toBe(true);
  });

  test("a payload without a conversation id is not a changed one", () => {
    const previous: AntigravitySessionState = {
      ...session,
      phase: "running",
      watchdogPid: 4242,
      pendingReset: false,
    };
    const plan = planHook({
      event: "pre-invocation",
      conversationId: null,
      harnessPid: 100,
      previous,
    });
    // Restarting a live turn here would reset the overlay mid-response.
    expect(plan.overlayActions).toEqual([]);
    expect(plan.checkForUpdate).toBe(false);
    expect(plan.state.conversationId).toBe("conv-1");
  });

  test("a harness pid that only resolves later joins the session it belongs to", () => {
    const previous: AntigravitySessionState = {
      conversationId: "conv-1",
      harnessPid: null,
      phase: "running",
      watchdogPid: null,
      pendingReset: false,
    };
    const plan = planHook({
      event: "pre-invocation",
      conversationId: "conv-1",
      harnessPid: 100,
      previous,
    });
    expect(plan.overlayActions).toEqual([]);
    // First chance this session has had to arm one, so it still takes it.
    expect(plan.startWatchdog).toBe(true);
    expect(plan.state.harnessPid).toBe(100);
  });

  test("an unidentifiable harness still drives the overlay, minus the watchdog", () => {
    const plan = planHook({
      event: "pre-invocation",
      conversationId: null,
      harnessPid: null,
      previous: null,
    });
    expect(plan.overlayActions).toEqual(["reset", "show"]);
    expect(plan.startWatchdog).toBe(false);
  });
});

describe("hook output", () => {
  test("always answers with a single JSON object", () => {
    const path = statePath();
    const { effects } = recorder();
    const first = runHook(
      { event: "pre-invocation", conversationId: "conv-1", harnessPid: 100, statePath: path },
      effects,
    );
    expect(JSON.parse(first)).toEqual({});
    const stop = runHook(
      { event: "stop", conversationId: "conv-1", harnessPid: 100, statePath: path },
      effects,
    );
    expect(JSON.parse(stop)).toEqual({});
  });

  test("delivers the update nudge as an injected ephemeral message", () => {
    const path = statePath();
    const { effects } = recorder("An update is available (0.3.0). Run: install --antigravity");
    const output = JSON.parse(
      runHook(
        { event: "pre-invocation", conversationId: "conv-1", harnessPid: 100, statePath: path },
        effects,
      ),
    );
    expect(output).toEqual({
      injectSteps: [
        { ephemeralMessage: "An update is available (0.3.0). Run: install --antigravity" },
      ],
    });
  });

  test("nudges on turn boundaries only, never on every model call", () => {
    const path = statePath();
    const { effects } = recorder("An update is available (0.3.0).");
    runHook(
      { event: "pre-invocation", conversationId: "conv-1", harnessPid: 100, statePath: path },
      effects,
    );
    const midTurn = runHook(
      { event: "pre-invocation", conversationId: "conv-1", harnessPid: 100, statePath: path },
      effects,
    );
    expect(JSON.parse(midTurn)).toEqual({});
  });

  test("persists the turn across hook processes", () => {
    const path = statePath();
    const { calls, effects } = recorder();
    const input = { conversationId: "conv-1", harnessPid: 100, statePath: path };
    runHook({ event: "pre-invocation", ...input }, effects);
    runHook({ event: "pre-invocation", ...input }, effects);
    runHook({ event: "stop", ...input }, effects);
    runHook({ event: "pre-invocation", ...input }, effects);

    expect(calls.overlay).toEqual([["reset", "show"], ["pause"], ["show"]]);
    expect(calls.updateChecks).toBe(1);
    expect(calls.watchdogs).toEqual([100]);
    expect(readSessionState(path)?.phase).toBe("running");
  });

  test("does not start a second watchdog for a live one", () => {
    const path = statePath();
    writeSessionState(path, {
      harnessPid: 100,
      conversationId: "conv-1",
      phase: "stopped",
      watchdogPid: process.pid,
      pendingReset: false,
    });
    const { calls, effects } = recorder();
    runHook(
      { event: "pre-invocation", conversationId: "conv-2", harnessPid: 100, statePath: path },
      effects,
    );
    expect(calls.watchdogs).toEqual([]);
    expect(readSessionState(path)?.watchdogPid).toBe(process.pid);
  });

  test("survives a corrupt state file", () => {
    const path = statePath();
    writeFileSync(path, "{ not json");
    const { calls, effects } = recorder();
    const output = runHook(
      { event: "pre-invocation", conversationId: "conv-1", harnessPid: 100, statePath: path },
      effects,
    );
    expect(JSON.parse(output)).toEqual({});
    expect(calls.overlay).toEqual([["reset", "show"]]);
  });
});

describe("session-end watchdog ownership", () => {
  const owner = 100;

  test("quits for the session it was armed for", () => {
    expect(
      watchdogOwnsOverlay(
        { harnessPid: owner, conversationId: "conv-1", phase: "stopped", watchdogPid: 1, pendingReset: false },
        owner,
      ),
    ).toBe(true);
  });

  test("quits when no session has claimed the overlay", () => {
    expect(watchdogOwnsOverlay(null, owner)).toBe(true);
    expect(
      watchdogOwnsOverlay(
        { harnessPid: null, conversationId: null, phase: "stopped", watchdogPid: null, pendingReset: false },
        owner,
      ),
    ).toBe(true);
  });

  test("stands down once another agy owns the overlay", () => {
    expect(
      watchdogOwnsOverlay(
        { harnessPid: 200, conversationId: "conv-2", phase: "running", watchdogPid: 2, pendingReset: false },
        owner,
      ),
    ).toBe(false);
    // The window the previous version missed: a new session has fired
    // SessionStart but not yet reached its first invocation.
    expect(
      watchdogOwnsOverlay(
        { harnessPid: 200, conversationId: null, phase: "stopped", watchdogPid: null, pendingReset: true },
        owner,
      ),
    ).toBe(false);
  });
});

describe("harness discovery", () => {
  test("walks past the shell Antigravity runs hooks through", () => {
    const tree: Record<number, { parentPid: number; command: string }> = {
      10: { parentPid: 11, command: "sh" },
      11: { parentPid: 12, command: "agy" },
      12: { parentPid: 1, command: "zsh" },
    };
    expect(resolveHarnessPid(10, (pid) => tree[pid] ?? null)).toBe(11);
  });

  test("gives up rather than claiming an unrelated ancestor", () => {
    const tree: Record<number, { parentPid: number; command: string }> = {
      10: { parentPid: 11, command: "sh" },
      11: { parentPid: 1, command: "zsh" },
      1: { parentPid: 0, command: "launchd" },
    };
    expect(resolveHarnessPid(10, (pid) => tree[pid] ?? null)).toBeNull();
  });
});
