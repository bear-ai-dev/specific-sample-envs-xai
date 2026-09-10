/**
 * Public, unauthenticated release distribution for the overlay binary.
 *
 * This is deliberately separate from the auth Worker: a fresh npm install has
 * no session yet, so gating downloads behind Cloudflare Access (or any login)
 * would recreate the private-GitHub-repo problem this replaces. Every route
 * here is read-only and only ever serves objects already published by CI.
 *
 *   GET /manifest.json     -> latest release manifest (version, tag, assets + sha256)
 *   GET /:tag/:asset       -> a specific binary, streamed straight from R2
 */
export interface Env {
  RELEASES: R2Bucket;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
};

// Matches the tags/assets CI actually publishes (e.g. "overlay-v0.2.8",
// "gamepigeon-overlay-ubuntu-x64"). Anything else 404s before touching R2,
// so this can't be walked into an arbitrary-key read.
const TAG_PATTERN = /^overlay-v\d+\.\d+\.\d+$/;
const ASSET_PATTERN = /^gamepigeon-overlay-[a-z0-9]+-[a-z0-9]+(\.exe)?$/;

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: CORS_HEADERS });
}

async function serveManifest(env: Env): Promise<Response> {
  const object = await env.RELEASES.get("manifest.json");
  if (!object) return notFound();
  return new Response(object.body, {
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json",
      // Short cache: this is the thing a fresh install checks first, so a
      // just-published release should show up quickly.
      "cache-control": "public, max-age=60",
      etag: object.httpEtag,
    },
  });
}

async function serveAsset(env: Env, tag: string, asset: string, method: string): Promise<Response> {
  if (!TAG_PATTERN.test(tag)) return notFound();

  // A per-tag manifest copy, so a caller pinned to an older tag (e.g. a
  // rollback, or the update-nudge check) can verify checksums without
  // depending on whatever the root manifest.json currently points at.
  if (asset === "manifest.json") {
    const object = method === "HEAD" ? await env.RELEASES.head(`${tag}/manifest.json`) : await env.RELEASES.get(`${tag}/manifest.json`);
    if (!object) return notFound();
    const headers = new Headers(CORS_HEADERS);
    headers.set("content-type", "application/json");
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    if (method === "HEAD" || !("body" in object)) return new Response(null, { headers });
    return new Response((object as R2ObjectBody).body, { headers });
  }

  if (!ASSET_PATTERN.test(asset)) return notFound();

  const key = `${tag}/${asset}`;
  const object = method === "HEAD" ? await env.RELEASES.head(key) : await env.RELEASES.get(key);
  if (!object) return notFound();

  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "application/octet-stream");
  headers.set("content-length", String(object.size));
  headers.set("etag", object.httpEtag);
  // Versioned, content-addressed by tag+asset: once published, a given
  // tag/asset pair never changes, so this can cache forever.
  headers.set("cache-control", "public, max-age=31536000, immutable");

  if (method === "HEAD" || !("body" in object)) return new Response(null, { headers });
  return new Response((object as R2ObjectBody).body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { method } = request;
    if (method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");

    if (path === "" || path === "manifest.json") {
      return method === "HEAD" ? new Response(null, { headers: CORS_HEADERS }) : serveManifest(env);
    }

    const parts = path.split("/");
    if (parts.length === 2) return serveAsset(env, parts[0], parts[1], method);

    return notFound();
  },
};
