import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");

/** Worktrees and fresh clones often have no node_modules; overlay bundle needs @tauri-apps/api. */
function ensureNodeModules(): void {
  const tauriApi = join(root, "node_modules/@tauri-apps/api/package.json");
  if (existsSync(tauriApi)) return;
  console.error("node_modules missing — running bun install…");
  const install = spawnSync("bun", ["install"], { cwd: root, stdio: "inherit" });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

ensureNodeModules();

const pkg = JSON.parse(await Bun.file("package.json").text()) as { version?: string };

const result = await Bun.build({
  entrypoints: ["overlay/app.ts", "overlay/restaurant-arena-preview.ts"],
  outdir: "overlay/dist",
  target: "browser",
  minify: true,
  define: {
    __POSTHOG_CAPTURE_KEY__: JSON.stringify(process.env.POSTHOG_CAPTURE_KEY ?? ""),
    __APP_VERSION__: JSON.stringify(pkg.version ?? "0.0.0"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
