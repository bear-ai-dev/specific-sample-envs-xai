import { getMigrations } from "better-auth/db/migration";
import { createAuth, trustedOrigins, type AuthEnv } from "./auth";

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

