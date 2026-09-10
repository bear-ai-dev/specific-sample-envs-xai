#!/usr/bin/env node
const { closeSync, existsSync, mkdirSync, openSync, unlinkSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { homedir } = require("node:os");
const { delimiter, join } = require("node:path");

const MIN_BUN = [1, 3];

function candidates() {
  const name = process.platform === "win32" ? "bun.exe" : "bun";
  const paths = [];
  if (process.env.BUN_INSTALL) paths.push(join(process.env.BUN_INSTALL, "bin", name));
  paths.push(join(homedir(), ".bun", "bin", name));
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (directory) paths.push(join(directory, name));
  }
  return paths;
}

function validBun(path) {
  if (!existsSync(path)) return false;
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const match = String(result.stdout).trim().match(/^(\d+)\.(\d+)/);
  return Boolean(match && (Number(match[1]) > MIN_BUN[0] || Number(match[1]) === MIN_BUN[0] && Number(match[2]) >= MIN_BUN[1]));
}

function findBun() {
  return candidates().find(validBun) || null;
}

function installBun() {
  console.error("Bun >= 1.3 was not found. Installing Bun…");
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm bun.sh/install.ps1 | iex"], { stdio: "inherit" })
    : spawnSync("sh", ["-c", "curl -fsSL https://bun.sh/install | bash"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Bun installation failed. Install Bun >= 1.3 from https://bun.sh and try again.");
}

function withInstallLock(action) {
  const directory = process.env.BUN_INSTALL || join(homedir(), ".bun");
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, ".tui-gamepigeon-install.lock");
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try { return action(); } finally { closeSync(fd); unlinkSync(lock); }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // ponytail: one global install lock; per-user locks are enough for this bootstrap.
      const start = Date.now();
      while (Date.now() - start < 100);
      const bun = findBun();
      if (bun) return bun;
    }
  }
}

function resolveBun() {
  const existing = findBun();
  if (existing) return existing;
  return withInstallLock(() => {
    const installed = findBun();
    if (installed) return installed;
    installBun();
    const bun = findBun();
    if (!bun) throw new Error("Bun installation completed but no Bun >= 1.3 binary was found.");
    return bun;
  });
}

function runWithBun(args) {
  const harnessIndex = args.indexOf("--harness");
  if (harnessIndex !== -1) {
    process.env.GAMEPIGEON_HARNESS = args[harnessIndex + 1];
    args = args.slice(0, harnessIndex).concat(args.slice(harnessIndex + 2));
  }
  const result = spawnSync(resolveBun(), args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (require.main === module) runWithBun(process.argv.slice(2));
module.exports = { candidates, findBun, resolveBun, runWithBun };
