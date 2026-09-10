import { describe, expect, test } from "bun:test";
import { runPluginUpgrade } from "./run-plugin-update.js";

describe("runPluginUpgrade", () => {
  test("reports marketplace failures without throwing", async () => {
    const originalSpawn = Bun.spawn;
    Bun.spawn = ((command: string[]) => ({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(""));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("network error"));
          controller.close();
        },
      }),
      exited: Promise.resolve(1),
    })) as typeof Bun.spawn;

    try {
      const result = await runPluginUpgrade();
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
