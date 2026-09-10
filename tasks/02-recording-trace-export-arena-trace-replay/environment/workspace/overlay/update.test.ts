import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyUpdatePlan, type UpdateLoadingElements, type UpdatePlan } from "./update.js";

function stubElements(): UpdateLoadingElements {
  const element = () => ({ hidden: false, textContent: "", dataset: {} as Record<string, string> });
  return {
    loading: element(),
    version: element(),
    note: element(),
    manual: element(),
    command: element(),
    copy: element(),
  } as unknown as UpdateLoadingElements;
}

const plan = (overrides: Partial<UpdatePlan> = {}): UpdatePlan => ({
  canSelfUpdate: true,
  manualCommand: "npx -y bun x @tui-games/tui@latest install",
  method: "copied-adapter",
  harness: "antigravity",
  ...overrides,
});

describe("update loading screen", () => {
  test("stays silent for an install that can upgrade itself", () => {
    const elements = stubElements();
    applyUpdatePlan(elements, plan());
    expect(elements.manual!.hidden).toBe(true);
    expect(elements.loading.dataset.method).toBe("copied-adapter");
  });

  test("shows a copyable command when the install cannot self-update", () => {
    // The dead "Update" button of #176: a dev checkout has no upgrade the
    // overlay can run, so it must show the command rather than an error.
    const elements = stubElements();
    applyUpdatePlan(elements, plan({
      canSelfUpdate: false,
      method: "dev",
      manualCommand: "git -C /tmp/checkout pull --ff-only",
    }));
    expect(elements.manual!.hidden).toBe(false);
    expect(elements.command!.textContent).toBe("git -C /tmp/checkout pull --ff-only");
    expect(elements.copy!.textContent).toBe("Copy");
  });

  test("surfaces the command after an automatic update fails", () => {
    const elements = stubElements();
    applyUpdatePlan(elements, plan(), { alsoShowCommand: true });
    expect(elements.manual!.hidden).toBe(false);
    expect(elements.command!.textContent).toBe("npx -y bun x @tui-games/tui@latest install");
  });

  test("ships the markup the loading screen drives", () => {
    const markup = readFileSync(join(import.meta.dir, "dist", "index.html"), "utf8");
    for (const id of ["update-loading", "update-manual", "update-command", "update-copy-command"]) {
      expect(markup).toContain(`id="${id}"`);
    }
    // Both controls live in a flex row, so `hidden` alone would not hide them.
    expect(markup).toContain(".update-manual[hidden] { display: none !important; }");
  });
});
