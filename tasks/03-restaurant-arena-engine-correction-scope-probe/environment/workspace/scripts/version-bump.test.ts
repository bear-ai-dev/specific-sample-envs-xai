import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION_FILES, applyVersion, nextVersion } from "./version-bump.ts";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("nextVersion", () => {
  test("bumps each component", () => {
    expect(nextVersion("0.2.1", "patch")).toBe("0.2.2");
    expect(nextVersion("0.2.1", "minor")).toBe("0.3.0");
    expect(nextVersion("0.2.1", "major")).toBe("1.0.0");
  });

  test("resets lower components", () => {
    expect(nextVersion("1.9.9", "major")).toBe("2.0.0");
    expect(nextVersion("1.9.9", "minor")).toBe("1.10.0");
  });

  test("accepts an explicit version", () => {
    expect(nextVersion("0.2.1", "1.4.0")).toBe("1.4.0");
  });

  test("rejects garbage rather than silently patching", () => {
    expect(() => nextVersion("0.2.1", "latest")).toThrow();
  });
});

describe("applyVersion", () => {
  test("sets the top-level version", () => {
    const out = applyVersion("package.json", '{"name":"x","version":"0.1.0"}', "0.2.0");
    expect(JSON.parse(out).version).toBe("0.2.0");
    expect(JSON.parse(out).name).toBe("x");
  });

  test("reaches into marketplace plugin entries", () => {
    const out = applyVersion(
      ".claude-plugin/marketplace.json",
      '{"plugins":[{"name":"x","version":"0.1.0"}]}',
      "0.2.0",
    );
    expect(JSON.parse(out).plugins[0].version).toBe("0.2.0");
  });

  test("preserves surrounding formatting", () => {
    const source = '{\n  "keywords": ["a", "b"],\n  "version": "0.1.0"\n}\n';
    expect(applyVersion("package.json", source, "0.2.0")).toBe(
      '{\n  "keywords": ["a", "b"],\n  "version": "0.2.0"\n}\n',
    );
  });

  test("throws when there is no version to bump", () => {
    expect(() => applyVersion("package.json", '{"name":"x"}', "0.2.0")).toThrow();
  });
});

describe("VERSION_FILES", () => {
  // A version file that drifts out of this list stops being bumped, which is how
  // .codex-plugin/plugin.json fell a release behind.
  test("every listed file exists and carries a version", () => {
    for (const file of VERSION_FILES) {
      const json = JSON.parse(readFileSync(join(ROOT_DIR, file), "utf8"));
      const version = file.endsWith("marketplace.json") ? json.plugins?.[0]?.version : json.version;
      expect(version, `${file} has no version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("all version files agree", () => {
    const versions = VERSION_FILES.map((file) => {
      const json = JSON.parse(readFileSync(join(ROOT_DIR, file), "utf8"));
      return file.endsWith("marketplace.json") ? json.plugins[0].version : json.version;
    });
    expect(new Set(versions).size, `versions drifted: ${versions.join(", ")}`).toBe(1);
  });
});
