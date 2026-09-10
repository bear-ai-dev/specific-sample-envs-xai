import { getMigrations } from "better-auth/db/migration";
import { createAuth, trustedOrigins, type AuthEnv } from "./auth";
import { handoffErrorPage, handoffSuccessPage, pageResponse } from "./handoff-page";

function sessionTokenFromCookie(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    const name = rawName?.trim();
    if (name === "better-auth.session_token" || name?.endsWith(".session_token")) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

function invalidTargetPage(): Response {
  return pageResponse(
    handoffErrorPage({
      title: "Sign-in can't be handed back",
      lead: "This sign-in link points somewhere Tui can't accept a session.",
      steps: [
        "Start sign-in from the Tui overlay, or run <code>gamepigeon auth login</code>.",
        "Tui only accepts a handoff to your own machine (<code>127.0.0.1</code>), so links copied between devices won't work.",
      ],
    }),
    400,
  );
}

function localhostCallback(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    ? url
    : null;
}

function authCors(request: Request, response: Response, env: AuthEnv): Response {
  const origin = request.headers.get("origin");
  if (!origin || !trustedOrigins(env).includes(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-expose-headers", "set-auth-token");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/auth/") && request.method === "OPTIONS") {
      const origin = request.headers.get("origin");
      if (!origin || !trustedOrigins(env).includes(origin)) return new Response(null, { status: 403 });
      return authCors(request, new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      }), env);
    }

    if (url.pathname === "/migrate" && request.method === "POST") {
      if (
        !env.MIGRATION_SECRET
        || request.headers.get("authorization") !== `Bearer ${env.MIGRATION_SECRET}`
      ) {
        return Response.json(
          { error: "Unauthorized" },
          { status: 401, headers: { "www-authenticate": "Bearer" } },
        );
      }
      const auth = createAuth(env);
      const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
      if (toBeCreated.length === 0 && toBeAdded.length === 0) {
        return Response.json({ message: "No migrations needed" });
      }
      await runMigrations();
      return Response.json({
        message: "Migrations completed",
        created: toBeCreated.map((table) => table.table),
        added: toBeAdded.map((table) => table.table),
      });
    }

    if (url.pathname === "/cli/handoff" && request.method === "GET") {
      const next = url.searchParams.get("next") ?? "http://127.0.0.1:3210/auth/callback";
      const nextUrl = localhostCallback(next);
      if (!nextUrl) {
        return invalidTargetPage();
      }

      const auth = createAuth(env);
      const session = await auth.api.getSession({ headers: request.headers });
      const token = sessionTokenFromCookie(request);
      if (!session?.user || !token) {
        return pageResponse(
          handoffErrorPage({
            title: "Sign-in didn't finish",
            lead: "This browser doesn't have a signed-in session, so there's nothing to hand back to Tui.",
            steps: [
              "Start again from Tui, or run <code>gamepigeon auth oauth google</code> (or <code>github</code>).",
              "If you cancelled at the provider's consent screen, approve it this time.",
              "Third-party cookie blocking can drop the session mid-flow — try a normal (non-private) window.",
            ],
          }),
          401,
        );
      }

      // `next` already carries the overlay's `state` nonce; searchParams keeps it
      // and appends `token` with a proper `&`, which is what both listeners expect.
      nextUrl.searchParams.set("token", token);
      return pageResponse(handoffSuccessPage(nextUrl.toString()));
    }

    if (url.pathname === "/cli/oauth" && request.method === "GET") {
      const provider = url.searchParams.get("provider");
      if (provider !== "google" && provider !== "github") {
        return pageResponse(
          handoffErrorPage({
            title: "That sign-in provider isn't supported",
            lead: "Tui signs you in with Google or GitHub.",
            steps: ["Run <code>gamepigeon auth oauth google</code> or <code>gamepigeon auth oauth github</code>."],
          }),
          400,
        );
      }
      const configured = provider === "github"
        ? env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        : env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET;
      if (!configured) {
        const name = provider === "github" ? "GitHub" : "Google";
        return pageResponse(
          handoffErrorPage({
            title: `${name} sign-in isn't available`,
            lead: `${name} OAuth is not configured on this Tui server.`,
            steps: [
              "Sign in with email and password instead, or try the other provider.",
              "Run <code>gamepigeon auth login</code> to use email and password from the terminal.",
            ],
          }),
          503,
        );
      }
      const next = url.searchParams.get("next") ?? "http://127.0.0.1:3210/auth/callback";
      const nextUrl = localhostCallback(next);
      if (!nextUrl) {
        return invalidTargetPage();
      }

      const handoff = new URL("/cli/handoff", env.BETTER_AUTH_URL);
      handoff.searchParams.set("next", nextUrl.toString());
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      headers.set("origin", new URL(env.BETTER_AUTH_URL).origin);
      const response = await createAuth(env).handler(new Request(
        new URL("/api/auth/sign-in/social", env.BETTER_AUTH_URL),
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            provider,
            callbackURL: handoff.toString(),
            disableRedirect: true,
          }),
        },
      ));
      const payload = await response.json() as { url?: string };
      if (!response.ok || !payload.url) {
        const name = provider === "github" ? "GitHub" : "Google";
        return pageResponse(
          handoffErrorPage({
            title: "Sign-in couldn't start",
            lead: `Tui couldn't reach ${name} to begin sign-in.`,
            steps: [
              "Try again in a moment — this is usually temporary.",
              "Still failing? Run <code>gamepigeon auth login</code> to sign in with email and password.",
            ],
          }),
          response.status,
        );
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-type");
      responseHeaders.set("location", payload.url);
      return new Response(null, { status: 302, headers: responseHeaders });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        service: "tui-gamepigeon-auth",
        ok: true,
        authBasePath: "/api/auth",
      });
    }

    return authCors(request, await createAuth(env).handler(request), env);
  },
} satisfies ExportedHandler<AuthEnv>;
