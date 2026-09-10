import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

test("provides an inert auth secret", () => {
  expect(env.BETTER_AUTH_SECRET).toBe("test-only-not-a-production-secret");
});
