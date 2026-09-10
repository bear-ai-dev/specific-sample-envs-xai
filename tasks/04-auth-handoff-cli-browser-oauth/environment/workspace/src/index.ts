#!/usr/bin/env bun
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthAnalyticsEvent } from "./analytics/events.js";
import { analytics } from "./analytics/posthog.js";
import { runAuthCommand, type AuthSuccess } from "./auth.js";
import { findGame, isPlayable, REGISTRY } from "./games/registry.js";
import { launchOverlay as showOverlay } from "../scripts/overlay.js";
import { detectInstallContext, writeInstallContext } from "../scripts/plugin-update.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function captureAuthSuccess(result: AuthSuccess): void {
  if (result.userId) analytics.setDistinctId(result.userId);
  analytics.capture(createAuthAnalyticsEvent(result));
}

function printUsage(): void {
  const ids = REGISTRY.filter(isPlayable).map((entry) => entry.id).join(", ");
  console.log("usage: gamepigeon [game]");
  console.log("       gamepigeon auth [signup|login|status|logout]");
  console.log("       gamepigeon install [--codex|--claude|--opencode|--hermes|--openclaw|--antigravity|--all]");
  console.log("       gamepigeon export [--input <file-or-directory>]... [--output <directory>] [--include-noops]");
  console.log("");
  console.log("With no argument, opens the arcade overlay menu.");
  console.log(`Available games: ${ids}`);
}

async function installAdapters(target?: string): Promise<void> {
  const proc = Bun.spawn(["bash", join(ROOT, "scripts/install-adapters.sh"), target ?? "--all"], {
    cwd: ROOT,
    env: { ...process.env, GAMEPIGEON_WORKSPACE_DIR: process.cwd() },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
  // The adapters now point at *this* checkout. Record it immediately so an
  // in-overlay update (which runs this command from a fresh npx checkout) can
  // reopen the new launcher instead of the one it just replaced.
  const harness = target?.startsWith("--") ? target.slice(2) : undefined;
  writeInstallContext(detectInstallContext(ROOT, {
    ...process.env,
    ...(harness && harness !== "all" ? { GAMEPIGEON_HARNESS: harness } : {}),
  }));
}

async function launchOverlay(gameId?: string): Promise<void> {
  await showOverlay("show", ROOT, { gameId });
}

async function exportBc(args: string[]): Promise<void> {
  // Relative --input/--output paths belong to whoever ran the command, not to the
  // install directory: a globally installed package root is often unwritable, and a
  // dataset written there would be lost on the next upgrade.
  const proc = Bun.spawn([process.execPath, join(ROOT, "scripts/export-bc.ts"), ...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}

async function main(): Promise<void> {
  let arg = process.argv[2];
  if (arg === "--game") arg = process.argv[3] ?? "";
  if (arg === "--help" || arg === "-h") {
    printUsage();
    return;
  }
  if (arg === "auth") {
    try {
      const result = await runAuthCommand(process.argv[3]);
      if (result) captureAuthSuccess(result);
    } finally {
      await analytics.shutdown();
    }
    return;
  }
  if (arg === "install") {
    await installAdapters(process.argv[3]);
    return;
  }
  if (arg === "export") {
    await exportBc(process.argv.slice(3));
    return;
  }

  let gameId: string | undefined;
  if (arg !== undefined) {
    const entry = findGame(arg);
    if (!entry || !isPlayable(entry)) {
      const ids = REGISTRY.filter(isPlayable).map((entry) => entry.id).join(", ");
      console.error(`Unknown or unavailable game "${arg}". Available games: ${ids}`);
      process.exit(1);
    }
    gameId = entry.id;
  }

  await launchOverlay(gameId);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
