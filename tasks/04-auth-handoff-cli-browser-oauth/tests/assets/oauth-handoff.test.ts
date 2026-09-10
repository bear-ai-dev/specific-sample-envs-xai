import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

// Loading the real `../src/auth` module (via `vi.importActual` below) to
// preserve any extra exports a solver adds costs more than vitest's 5s
// default on a cold run; give every test in this file room for that.
vi.setConfig({ testTimeout: 20000 });

const CALLBACK = "http://127.0.0.1:54321/auth/callback?state=nonce123";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/auth");
});

/**
 * Loads the Worker with a signed-in browser session for the handoff route.
 *
 * This only overrides `createAuth`/`trustedOrigins` (the two entry points the
 * handoff route needs stubbed to fake a signed-in session). Any other export
 * `../src/auth` happens to have — including ones an implementation adds on
 * top of the baseline `AuthEnv`/`trustedOrigins`/`createAuth` — passes through
 * from the real module untouched, so where a solver chooses to put a helper
 * function is not something this mock should be able to break.
 */
const workerWithSession = async (token: string) => {
  vi.doMock("../src/auth", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("../src/auth");
    return {
      ...actual,
      createAuth: () => ({
        api: { getSession: async () => ({ user: { id: "usr_handoff" } }) },
      }),
      trustedOrigins: () => [],
    };
  });
  const { default: worker } = await import("../src/index");
  return (next: string) =>
    worker.fetch(
      new Request(`${env.BETTER_AUTH_URL}/cli/handoff?next=${encodeURIComponent(next)}`, {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      env,
    );
};

describe("CLI/browser OAuth handoff", () => {
  it("preserves the overlay's state nonce when appending the token", async () => {
    const fetchHandoff = await workerWithSession("session-abc");
    const response = await fetchHandoff(CALLBACK);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // The token rides in the URL, so the page must not be cached or leak a referrer.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.text();
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(body).not.toContain("<link");
    expect(body).not.toContain("<img");
    expect(body).toContain("http://127.0.0.1:54321/auth/callback?state=nonce123&token=session-abc");
  });

  it("cannot be used to break out of its own redirect script", async () => {
    const fetchHandoff = await workerWithSession('</script><b>x');
    const response = await fetchHandoff(CALLBACK);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("</script><b>");
  });

  it("refuses to hand a session to a non-localhost target", async () => {
    const fetchHandoff = await workerWithSession("session-abc");
    const response = await fetchHandoff("https://evil.example/steal");

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("session-abc");
  });

  it("refuses a next target that isn't plain http, even on localhost", async () => {
    const fetchHandoff = await workerWithSession("session-abc");
    const response = await fetchHandoff("https://127.0.0.1:54321/auth/callback");

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("session-abc");
  });

  it("explains an unauthenticated handoff instead of hanging the listener", async () => {
    const response = await import("../src/index").then(({ default: worker }) =>
      worker.fetch(
        new Request(`${env.BETTER_AUTH_URL}/cli/handoff?next=${encodeURIComponent(CALLBACK)}`),
        env,
      ),
    );

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body.toLowerCase()).toContain("oauth");
  });

  it("rejects a provider other than google or github on /cli/oauth", async () => {
    const { default: worker } = await import("../src/index");
    const response = await worker.fetch(
      new Request(`${env.BETTER_AUTH_URL}/cli/oauth?provider=microsoft&next=${encodeURIComponent(CALLBACK)}`),
      env,
    );

    expect(response.status).toBe(400);
  });

  it("reports 503 when the requested provider has no configured credentials", async () => {
    const { default: worker } = await import("../src/index");
    const response = await worker.fetch(
      new Request(`${env.BETTER_AUTH_URL}/cli/oauth?provider=github&next=${encodeURIComponent(CALLBACK)}`),
      env,
    );

    expect(response.status).toBe(503);
  });

  it("refuses a non-localhost next target on /cli/oauth before starting sign-in", async () => {
    const { default: worker } = await import("../src/index");
    const configuredEnv = { ...env, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };
    const response = await worker.fetch(
      new Request(
        `${configuredEnv.BETTER_AUTH_URL}/cli/oauth?provider=github&next=${encodeURIComponent("https://evil.example/steal")}`,
      ),
      configuredEnv,
    );

    expect(response.status).toBe(400);
  });

  it("still serves the generic auth handler and /migrate untouched", async () => {
    const { default: worker } = await import("../src/index");
    const unauthorized = await worker.fetch(
      new Request(`${env.BETTER_AUTH_URL}/migrate`, { method: "POST" }),
      env,
    );
    expect(unauthorized.status).toBe(401);

    const root = await worker.fetch(new Request(`${env.BETTER_AUTH_URL}/`), env);
    expect(root.status).toBe(200);
    expect(await root.json()).toMatchObject({ service: "tui-gamepigeon-auth", ok: true });
  });
});

