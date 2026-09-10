import { resolvePluginUpdatePaths, runPluginUpdateClear } from "./plugin-update.js";

const MARKETPLACE = "tui-gamepigeon";
const PLUGIN = "tui-gamepigeon@tui-gamepigeon";
const REPO_URL = "https://github.com/Trolleroof/tui-gamepigeon.git";

export interface PluginUpgradeResult {
  ok: boolean;
  message: string;
}

async function runStep(command: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  const output = `${stdout}${stderr}`.trim();
  return { ok: code === 0, output };
}

export async function runPluginUpgrade(): Promise<PluginUpgradeResult> {
  let marketplace = await runStep(["claude", "plugin", "marketplace", "update", MARKETPLACE]);
  if (!marketplace.ok) {
    marketplace = await runStep(["claude", "plugin", "marketplace", "add", REPO_URL]);
    if (marketplace.ok) {
      await runStep(["claude", "plugin", "marketplace", "remove", MARKETPLACE]);
    } else {
      return {
        ok: false,
        message: marketplace.output || "Could not refresh the Tui marketplace. Check your network and try again.",
      };
    }
  }

  let plugin = await runStep(["claude", "plugin", "update", PLUGIN]);
  if (!plugin.ok) {
    plugin = await runStep(["claude", "plugin", "install", PLUGIN, "--scope", "user"]);
  }
  if (!plugin.ok) {
    return {
      ok: false,
      message: plugin.output || "Plugin update failed. Please try again or report an issue on GitHub.",
    };
  }

  runPluginUpdateClear(resolvePluginUpdatePaths());
  return {
    ok: true,
    message: "Tui updated. Run /reload-plugins or restart Claude Code to apply the new plugin.",
  };
}

if (import.meta.main) {
  const result = await runPluginUpgrade();
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exitCode = 1;
  }
}
