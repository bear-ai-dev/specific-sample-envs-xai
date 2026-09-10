#!/usr/bin/env bun
/**
 * Serve a browser preview of the Tui overlay at production frame sizes.
 * Rebuilds the web bundle, then hosts overlay/dist + overlay/preview.html.
 *
 *   bun run preview:overlay
 *   bun run preview:overlay -- --game=restaurant-arena
 *   bun run preview:overlay -- --scene=restaurant-arena
 *   → http://127.0.0.1:4173/?game=restaurant-arena
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "overlay", "dist");
const PREVIEW_HTML = join(ROOT, "overlay", "preview.html");
const HOST = process.env.GAMEPIGEON_PREVIEW_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.GAMEPIGEON_PREVIEW_PORT ?? 4173);
const LOCAL_PREVIEW = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
const NIM_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NIM_DEFAULT_MODEL = "openai/gpt-oss-20b";
const MODEL_WINDOW_MS = 60_000;
const DEFAULT_MODEL_MAX_STARTS = 20;

function workerModelConfig() {
  const nimKey = process.env.NVIDIA_API_KEY?.trim();
  const url = process.env.GAMEPIGEON_MODEL_URL?.trim() || (nimKey ? NIM_CHAT_URL : "");
  const key = process.env.GAMEPIGEON_MODEL_API_KEY?.trim() || nimKey || "";
  const name = process.env.GAMEPIGEON_MODEL_NAME?.trim() || (nimKey ? NIM_DEFAULT_MODEL : "");
  if (!url || !key || !name) return undefined;
  return {
    url,
    key,
    provider: process.env.GAMEPIGEON_MODEL_PROVIDER?.trim() || (nimKey ? "nim" : "openai-compatible"),
    name,
    version: process.env.GAMEPIGEON_MODEL_VERSION?.trim() || undefined,
  };
}

const workerRequests = new Map<string, AbortController>();
const workerStarts: number[] = [];
let workerBlockedUntil = 0;

function workerMaxStarts(): number {
  const value = Number(process.env.GAMEPIGEON_MODEL_MAX_STARTS_PER_WINDOW);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MODEL_MAX_STARTS;
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(resolveWait, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Model request canceled."));
    }, { once: true });
  });
}

async function admitWorkerRequest(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const now = Date.now();
    while (workerStarts[0] !== undefined && now - workerStarts[0] >= MODEL_WINDOW_MS) workerStarts.shift();
    const waitUntil = Math.max(workerBlockedUntil, workerStarts.length < workerMaxStarts() ? 0 : workerStarts[0]! + MODEL_WINDOW_MS);
    if (waitUntil <= now) {
      workerStarts.push(now);
      return;
    }
    await waitFor(waitUntil - now, signal);
  }
  throw new Error("Model request canceled.");
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, 120_000) : MODEL_WINDOW_MS;
}

async function completeWorkerModel(request: Request): Promise<Response> {
  const config = workerModelConfig();
  if (!config) return new Response("Live model transport is not configured.", { status: 503 });
  const body = await request.json().catch(() => undefined) as { requestId?: unknown; request?: { systemPrompt?: unknown; turnPrompt?: unknown } } | undefined;
  const requestId = typeof body?.requestId === "string" ? body.requestId : "";
  const systemPrompt = body?.request?.systemPrompt;
  const turnPrompt = body?.request?.turnPrompt;
  if (!requestId || requestId.length > 128 || !/^[A-Za-z0-9-]+$/.test(requestId) || typeof systemPrompt !== "string" || typeof turnPrompt !== "string") {
    return new Response("Model request is invalid.", { status: 400 });
  }
  if (systemPrompt.length + turnPrompt.length > 200_000) return new Response("The worker prompt is too large.", { status: 400 });
  const controller = new AbortController();
  workerRequests.set(requestId, controller);
  try {
    const queueStarted = performance.now();
    await admitWorkerRequest(controller.signal);
    const queueMs = Math.round(performance.now() - queueStarted);
    const providerStarted = performance.now();
    const response = await fetch(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.name, temperature: 0, max_tokens: 256, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: turnPrompt }] }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    const providerMs = Math.round(performance.now() - providerStarted);
    if (response.status === 429) {
      workerBlockedUntil = Date.now() + retryAfterMs(response);
      return new Response(`Model account is rate limited; waiting ${Math.ceil((workerBlockedUntil - Date.now()) / 1_000)}s before the next request.`, { status: 429 });
    }
    if (!response.ok) return new Response(`Model provider returned HTTP ${response.status}.`, { status: 502 });
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
    };
    const completion = payload.choices?.[0]?.message?.content;
    if (typeof completion !== "string" || !completion.trim()) return new Response("The model response did not contain a completion.", { status: 502 });
    // Every usage field is best-effort: a provider that omits it leaves the
    // field absent here rather than reporting a guessed zero.
    return Response.json({
      text: completion,
      queueMs,
      providerMs,
      inputTokens: typeof payload.usage?.prompt_tokens === "number" ? payload.usage.prompt_tokens : undefined,
      outputTokens: typeof payload.usage?.completion_tokens === "number" ? payload.usage.completion_tokens : undefined,
      cachedInputTokens: typeof payload.usage?.prompt_tokens_details?.cached_tokens === "number" ? payload.usage.prompt_tokens_details.cached_tokens : undefined,
      finishReason: typeof payload.choices?.[0]?.finish_reason === "string" ? payload.choices[0].finish_reason : undefined,
    });
  } catch (error) {
    const timedOut =
      (error instanceof DOMException && error.name === "TimeoutError") ||
      (error instanceof Error && /timeout/i.test(error.message));
    const message = controller.signal.aborted
      ? "Model request canceled."
      : timedOut
        ? "Model provider timed out."
        : "Model provider request failed.";
    return new Response(message, { status: 502 });
  } finally {
    workerRequests.delete(requestId);
  }
}

function parseArgs(argv: string[]): { game?: string; scene?: string; variation?: string; scores?: string; open: boolean; help: boolean } {
  let game: string | undefined;
  let scene: string | undefined;
  let variation: string | undefined;
  let scores: string | undefined;
  let open = true;
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--no-open") open = false;
    else if (arg === "--open") open = true;
    else if (arg.startsWith("--game=")) game = arg.slice("--game=".length) || undefined;
    else if (arg.startsWith("--scene=")) scene = arg.slice("--scene=".length) || undefined;
    else if (arg.startsWith("--variation=")) variation = arg.slice("--variation=".length) || undefined;
    else if (arg.startsWith("--scores=")) scores = arg.slice("--scores=".length) || undefined;
  }
  return { game, scene, variation, scores, open, help };
}

function printHelp(): void {
  console.log(`Usage: bun run preview:overlay [-- --game=<id>] [-- --variation=<id>] [-- --scores=demo] [-- --no-open]

Rebuilds the overlay web bundle and serves a browser preview at the real
Tauri frame sizes (520×740 compact / 720×780 expanded).

Options (after --):
  --game=<id>         Deep-link into a game (e.g. restaurant-arena)
  --scene=<id>        Preview a standalone scene (restaurant-arena)
  --variation=<id>    Optional variation id (default: classic)
  --scores=demo       Populate preview-only sample leaderboard runs
  --open / --no-open  Open the default browser (default: open)
  -h, --help          Show this help

Env:
  GAMEPIGEON_PREVIEW_HOST  bind host (default 127.0.0.1)
  GAMEPIGEON_PREVIEW_PORT  preferred port (default 4173; falls back if busy)
`);
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(opener, args, { stdio: "ignore", detached: true }).unref();
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const buildCode = await run(process.execPath, [join(ROOT, "scripts", "build-overlay-web.ts")]);
if (buildCode !== 0) process.exit(buildCode);

if (!existsSync(join(DIST, "index.html"))) {
  console.error(`Missing ${join(DIST, "index.html")} — expected overlay web assets.`);
  process.exit(1);
}
if (!existsSync(PREVIEW_HTML)) {
  console.error(`Missing ${PREVIEW_HTML}`);
  process.exit(1);
}

const previewBytes = await Bun.file(PREVIEW_HTML).bytes();

function distFile(pathname: string): string | null {
  const cleaned = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(DIST, cleaned.replace(/^[/\\]+/, ""));
  const rel = relative(DIST, filePath);
  if (!rel || rel.startsWith("..") || rel.includes("..")) return null;
  return filePath;
}

const fetchHandler = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/worker-model/") && !LOCAL_PREVIEW) {
      return new Response("Live worker preview requires a loopback host.", { status: 403 });
    }
    if (url.pathname === "/api/worker-model/config") {
      const config = workerModelConfig();
      return config
        ? Response.json({ provider: config.provider, name: config.name, version: config.version })
        : new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/worker-model/complete") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return completeWorkerModel(request);
    }
    if (url.pathname === "/api/worker-model/cancel") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const body = await request.json().catch(() => undefined) as { requestId?: unknown } | undefined;
      if (typeof body?.requestId === "string") workerRequests.get(body.requestId)?.abort();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/" || url.pathname === "/preview.html") {
      return new Response(previewBytes, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const filePath = distFile(url.pathname);
    if (!filePath) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(file, {
      headers: { "Cache-Control": "no-store" },
    });
  },
};

function startServer(port: number) {
  return Bun.serve({
    hostname: HOST,
    port,
    ...fetchHandler,
  });
}

let server: ReturnType<typeof Bun.serve>;
try {
  server = startServer(DEFAULT_PORT);
} catch (error) {
  const code = (error as { code?: string }).code;
  if (code !== "EADDRINUSE") throw error;
  console.warn(`Port ${DEFAULT_PORT} is busy — trying the next free port…`);
  server = startServer(0);
}

const query = new URLSearchParams();
if (args.game) query.set("game", args.game);
if (args.scene) query.set("scene", args.scene);
if (args.variation) query.set("variation", args.variation);
if (args.scores) query.set("scores", args.scores);
const suffix = query.toString() ? `/?${query}` : "/";
const base = `http://${server.hostname}:${server.port}`;
const url = `${base}${suffix}`;

console.log(`Tui browser preview → ${url}`);
if (!args.game) console.log(`Deep-link example     → ${base}/?game=restaurant-arena`);
console.log("Ctrl+C to stop.");

if (args.open) openBrowser(url);
