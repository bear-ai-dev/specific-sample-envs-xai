/**
 * Bumps the project version everywhere it is declared, so cutting a release is
 * one command. This only updates the version and commits it — CI does nothing
 * until you explicitly push a matching `overlay-v<version>` tag, which is
 * what actually publishes the release and repoints the update manifest:
 *
 *   bun run version:bump            # 0.2.1 -> 0.2.2
 *   bun run version:bump minor      # 0.2.1 -> 0.3.0
 *   bun run version:bump 1.0.0      # explicit
 *   bun run version:bump --no-commit
 *   git push origin main
 *   git tag overlay-v<version> && git push origin overlay-v<version>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Release = "patch" | "minor" | "major";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextVersion(current: string, bump: Release | string): string {
  if (SEMVER.test(bump)) return bump;
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`Current version is not semver: ${current}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Expected patch|minor|major or an explicit x.y.z version, got: ${bump}`);
}

/** Every file carrying the version. */
export const VERSION_FILES = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
] as const;

const VERSION_FIELD = /("version"\s*:\s*")\d+\.\d+\.\d+(")/g;

/**
 * Rewrites the version in place rather than round-tripping through JSON.parse,
 * which would reflow every hand-formatted array in these files and bury the one
 * line that actually changed. `marketplace.json` nests its version inside a
 * plugin entry, so this replaces every occurrence — none of these files carry a
 * `version` field that should stay put.
 */
export function applyVersion(file: string, source: string, version: string): string {
  const updated = source.replace(VERSION_FIELD, `$1${version}$2`);
  if (updated === source && !source.includes(`"${version}"`)) {
    throw new Error(`No version field found in ${file}`);
  }
  return updated;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const commit = !args.includes("--no-commit");
  const bump = args.find((arg) => !arg.startsWith("--")) ?? "patch";

  const pkgPath = join(ROOT_DIR, "package.json");
  const current = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
  const version = nextVersion(current, bump);

  for (const file of VERSION_FILES) {
    const path = join(ROOT_DIR, file);
    writeFileSync(path, applyVersion(file, readFileSync(path, "utf8"), version));
  }
  console.log(`${current} -> ${version}`);

  if (commit) {
    const git = Bun.spawnSync(
      ["git", "commit", "-m", `Bump version to ${version}`, "--", ...VERSION_FILES],
      { cwd: ROOT_DIR, stdout: "inherit", stderr: "inherit" },
    );
    if (git.exitCode !== 0) process.exitCode = 1;
    else {
      console.log(
        `Committed. Push to main, then run:\n` +
          `  git tag overlay-v${version} && git push origin overlay-v${version}\n` +
          `to publish the release.`,
      );
    }
  }
}
