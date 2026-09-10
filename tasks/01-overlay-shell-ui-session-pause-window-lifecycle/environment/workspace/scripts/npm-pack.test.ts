import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("npm pack layout", () => {
  test(
    "tarball includes overlay web bundle and excludes native build tree",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "gamepigeon-pack-list-"));
      try {
        const pack = spawnSync("npm", ["pack", "--pack-destination", dir], {
          encoding: "utf8",
          cwd: join(import.meta.dir, ".."),
        });
        expect(pack.status).toBe(0);
        const tgz = pack.stdout.trim().split("\n").pop()!;
        const list = spawnSync("tar", ["-tzf", join(dir, tgz)], { encoding: "utf8" });
        expect(list.status).toBe(0);
        const paths = list.stdout.split("\n").filter(Boolean);
        expect(paths.some((p) => p.includes("package/overlay/dist/"))).toBe(true);
        // Adapters invoke the shipped Node bootstrapper, which then runs Bun.
        expect(paths.some((p) => p.endsWith("package/scripts/overlay.ts"))).toBe(true);
        expect(paths.some((p) => p.endsWith("package/scripts/run-with-bun.cjs"))).toBe(true);
        expect(paths.some((p) => p.endsWith("package/scripts/gamepigeon.cjs"))).toBe(true);
        expect(paths.some((p) => p.endsWith("package/dist/index.js"))).toBe(true);
        expect(paths.some((p) => p.endsWith("package/overlay-release.json"))).toBe(true);
        expect(paths.some((p) => p.endsWith("package/scripts/export-bc.ts"))).toBe(true);
        expect(paths.some((p) => p.endsWith("package/packages/trace-export/src/index.ts"))).toBe(
          true,
        );
        expect(paths.some((p) => p.endsWith("package/packages/trace-export/src/bc-export.ts"))).toBe(
          true,
        );
        expect(paths.some((p) => p.includes("/tauri/"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20000,
  );

  test(
    "packed install exposes gamepigeon bin",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "gamepigeon-pack-"));
      try {
        const pack = spawnSync("npm", ["pack", "--pack-destination", dir], {
          encoding: "utf8",
          cwd: join(import.meta.dir, ".."),
        });
        expect(pack.status).toBe(0);
        const tgz = pack.stdout.trim().split("\n").pop()!;
        const tgzPath = join(dir, tgz);
        const extract = spawnSync("tar", ["-xzf", tgzPath, "-C", dir], { encoding: "utf8" });
        expect(extract.status).toBe(0);
        const pkg = JSON.parse(readFileSync(join(dir, "package", "package.json"), "utf8"));
        expect(pkg.bin.gamepigeon).toBe("./scripts/gamepigeon.cjs");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20000,
  );
});
