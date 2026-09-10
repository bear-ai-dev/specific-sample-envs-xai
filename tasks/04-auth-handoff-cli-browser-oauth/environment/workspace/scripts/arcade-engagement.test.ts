import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armEngagementNudge,
  deliverEngagementNudge,
  engagementNudgeHookOutput,
  hasNudgedThisSession,
  isOverlayUp,
  parseEngagementAction,
  resetEngagementSession,
} from "./arcade-engagement.js";

/** Paths in a scratch directory so tests never touch the real session flags. */
function tempFlags() {
  const dir = mkdtempSync(join(tmpdir(), "gamepigeon-engagement-"));
  return {
    nudgedPath: join(dir, "nudged"),
    pendingPath: join(dir, "pending"),
    leasePath: join(dir, "alive"),
    shutdownPath: join(dir, "off"),
  };
}

function touch(path: string): void {
  writeFileSync(path, "");
}

describe("parseEngagementAction", () => {
  test("maps flags to actions and defaults to deliver", () => {
    expect(parseEngagementAction(["--reset"])).toBe("reset");
    expect(parseEngagementAction(["--arm"])).toBe("arm");
    expect(parseEngagementAction(["--deliver"])).toBe("deliver");
    expect(parseEngagementAction([])).toBe("deliver");
  });

  test("rejects an unknown action", () => {
    expect(() => parseEngagementAction(["--bogus"])).toThrow();
  });
});

describe("isOverlayUp", () => {
  test("is false when the overlay has never launched", () => {
    const { leasePath, shutdownPath } = tempFlags();
    expect(isOverlayUp(leasePath, shutdownPath)).toBe(false);
  });

  test("is true while the overlay holds its lease", () => {
    const { leasePath, shutdownPath } = tempFlags();
    touch(leasePath);
    expect(isOverlayUp(leasePath, shutdownPath)).toBe(true);
  });

  test("is false once the user shuts the overlay down from its own UI", () => {
    const { leasePath, shutdownPath } = tempFlags();
    touch(leasePath);
    touch(shutdownPath);
    expect(isOverlayUp(leasePath, shutdownPath)).toBe(false);
  });
});

// Stop must stay silent: its additionalContext renders to the user verbatim as
// "Stop hook feedback: ...", which is the whole reason for the two-stage split.
describe("armEngagementNudge", () => {
  test("arms a pending nudge when the overlay is closed", () => {
    const flags = tempFlags();
    armEngagementNudge(flags);
    expect(existsSync(flags.pendingPath)).toBe(true);
  });

  // The reported bug: the nudge fired ~1.5s after a real game.started, telling
  // the user to go open an arcade that was already on screen.
  test("arms nothing while the overlay is already up", () => {
    const flags = tempFlags();
    touch(flags.leasePath);

    armEngagementNudge(flags);
    expect(existsSync(flags.pendingPath)).toBe(false);
    // The turn must not burn the session's one nudge on a suppressed turn.
    expect(hasNudgedThisSession(flags.nudgedPath)).toBe(false);
  });

  test("still arms on a later turn once the overlay is closed", () => {
    const flags = tempFlags();
    touch(flags.leasePath);
    armEngagementNudge(flags);
    expect(existsSync(flags.pendingPath)).toBe(false);

    resetEngagementSession({ nudgedPath: flags.leasePath, pendingPath: flags.leasePath });
    armEngagementNudge(flags);
    expect(existsSync(flags.pendingPath)).toBe(true);
  });

  test("does not re-arm once the session already nudged", () => {
    const flags = tempFlags();
    touch(flags.nudgedPath);
    armEngagementNudge(flags);
    expect(existsSync(flags.pendingPath)).toBe(false);
  });
});

describe("deliverEngagementNudge", () => {
  test("stays silent when no Stop hook armed a nudge", () => {
    const flags = tempFlags();
    expect(deliverEngagementNudge(flags)).toBeNull();
  });

  test("delivers an armed nudge exactly once per session", () => {
    const flags = tempFlags();
    armEngagementNudge(flags);

    expect(deliverEngagementNudge(flags)).not.toBeNull();
    expect(hasNudgedThisSession(flags.nudgedPath)).toBe(true);
    // Pending is consumed, and a second prompt in the same session says nothing.
    expect(existsSync(flags.pendingPath)).toBe(false);
    expect(deliverEngagementNudge(flags)).toBeNull();

    // Even if a later Stop tried to re-arm, the session is spent.
    armEngagementNudge(flags);
    expect(deliverEngagementNudge(flags)).toBeNull();
  });

  test("targets UserPromptSubmit, the hook event that is not rendered to the user", () => {
    const parsed = JSON.parse(engagementNudgeHookOutput());
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
  });

  // The agent echoes this copy almost verbatim, so a stray "Arcade" here reaches
  // the user as the product name. The product is Tui.
  test("calls the product Tui and never Arcade", () => {
    const { additionalContext } = JSON.parse(engagementNudgeHookOutput()).hookSpecificOutput;
    expect(additionalContext).toContain("Tui");
    // Not even in a "don't say Arcade" instruction — the agent echoes this copy,
    // so the wrong name must not appear in it at all.
    expect(additionalContext).not.toMatch(/Arcade/i);
  });
});

describe("resetEngagementSession", () => {
  test("clears both flags so a new session can nudge again", () => {
    const flags = tempFlags();
    armEngagementNudge(flags);
    deliverEngagementNudge(flags);
    expect(hasNudgedThisSession(flags.nudgedPath)).toBe(true);

    resetEngagementSession(flags);
    expect(existsSync(flags.nudgedPath)).toBe(false);
    expect(existsSync(flags.pendingPath)).toBe(false);
  });

  test("is a no-op when there is nothing to clear", () => {
    expect(() => resetEngagementSession(tempFlags())).not.toThrow();
  });
});

// The overlay flag paths are duplicated to keep this hook off overlay.ts's
// analytics/auth import chain, so pin them to the source of truth.
describe("overlay flag paths", () => {
  test("match the constants overlay.ts writes", () => {
    const source = readFileSync(new URL("./overlay.ts", import.meta.url), "utf8");
    const engagement = readFileSync(new URL("./arcade-engagement.ts", import.meta.url), "utf8");
    for (const flag of [".gamepigeon-overlay.alive", ".gamepigeon-overlay.off"]) {
      expect(source).toContain(flag);
      expect(engagement).toContain(flag);
    }
  });
});
