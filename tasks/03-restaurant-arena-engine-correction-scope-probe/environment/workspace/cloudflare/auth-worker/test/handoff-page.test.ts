import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { arcadePage, handoffSuccessPage } from "../src/handoff-page";

const CALLBACK = "http://127.0.0.1:54321/auth/callback?state=nonce123";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../src/auth");
});

/** Loads the Worker with a signed-in browser session for the handoff route. */
const workerWithSession = async (token: string) => {
  vi.doMock("../src/auth", () => ({
    createAuth: () => ({
      api: { getSession: async () => ({ user: { id: "usr_handoff" } }) },
    }),
    trustedOrigins: () => [],
  }));
  const { default: worker } = await import("../src/index");
  return (next: string) =>
    worker.fetch(
      new Request(`${env.BETTER_AUTH_URL}/cli/handoff?next=${encodeURIComponent(next)}`, {
        headers: { cookie: `better-auth.session_token=${token}` },
      }),
      env,
    );
};

describe("OAuth handoff pages", () => {
  it("renders a self-contained page with no network dependencies", () => {
    const page = arcadePage({ tone: "warn", title: "Nope", lead: "Something went wrong." });

    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("Tui");
    expect(page).toContain("<h1>Nope</h1>");
    // Inline CSS and SVG only — no fonts, stylesheets, or images to fetch.
    expect(page).not.toContain("<link");
    expect(page).not.toContain("<img");
    expect(page).not.toContain("http://");
  });

  it("escapes titles so a page can never carry markup from a request", () => {
    const page = arcadePage({
      tone: "warn",
      title: "<script>alert(1)</script>",
      lead: "Something went wrong.",
    });

    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
  });

  it("confirms success, then hands the session back without a click", () => {
    const next = `${CALLBACK}&token=session-abc`;
    const page = handoffSuccessPage(next);

    expect(page).toContain("Signed in");
    expect(page).toContain("close this tab");
    // Meta refresh for scripting-disabled browsers, location.replace to keep the
    // token-bearing URL out of history, and a link when both are blocked.
    expect(page).toContain(`content="0;url=${next.replace(/&/g, "&amp;")}"`);
    expect(page).toContain(`location.replace("${next}")`);
    expect(page).toContain(`href="${next.replace(/&/g, "&amp;")}"`);
    expect(page).toContain("Continue to Tui");
  });

  it("cannot be used to break out of the redirect script", () => {
    const page = handoffSuccessPage("http://127.0.0.1:3210/auth/callback?token=</script><b>x");

    expect(page).not.toContain("</script><b>");
    expect(page).toContain("\\u003c/script>");
  });

  it("preserves the overlay's state nonce when appending the token", async () => {
    const fetchHandoff = await workerWithSession("session-abc");
    const response = await fetchHandoff(CALLBACK);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // The token rides in the URL, so the page must not be cached or leak a referrer.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain(
      'location.replace("http://127.0.0.1:54321/auth/callback?state=nonce123&token=session-abc")',
    );
  });

  it("refuses to hand a session to a non-localhost target", async () => {
    const fetchHandoff = await workerWithSession("session-abc");
    const response = await fetchHandoff("https://evil.example/steal");

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
    expect(body).toContain("Sign-in didn&#39;t finish");
    expect(body).toContain("gamepigeon auth oauth google");
  });
});
