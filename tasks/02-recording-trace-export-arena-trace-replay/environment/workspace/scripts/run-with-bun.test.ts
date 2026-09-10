import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execPath } from "node:process";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("runs through an existing BUN_INSTALL binary without installing", () => {
  const root = mkdtempSync(join(tmpdir(), "gamepigeon-bun-"));
  const bin = join(root, "bin");
  const log = join(root, "args");
  const fakeBun = join(bin, "bun");
  mkdirSync(bin);
  writeFileSync(fakeBun, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.3.0; else printf '%s\\n' "$@" > ${JSON.stringify(log)}; fi
`);
  chmodSync(fakeBun, 0o755);

  const result = spawnSync(execPath, [join(import.meta.dir, "run-with-bun.cjs"), "overlay.ts", "--show", "--harness", "codex"], {
    env: { ...process.env, BUN_INSTALL: root, HOME: root, PATH: bin },
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(readFileSync(log, "utf8")).toBe("overlay.ts\n--show\n");
  expect(result.stderr).toBe("");
});
