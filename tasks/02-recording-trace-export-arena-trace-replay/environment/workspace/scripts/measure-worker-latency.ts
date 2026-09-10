#!/usr/bin/env bun
/**
 * Run the real worker orchestrator against the configured model endpoint for
 * a few rounds and report, per worker turn: queue time (time spent waiting
 * before the provider call started), provider response time, elapsed time
 * into the decision round, and whatever usage the provider reported
 * (input/output/cached tokens, finish reason). Worker ordering, prompts, and
 * model choice are exactly what the live app uses -- this drives the same
 * RestaurantGame + WorkerOrchestrator, just with a script-local transport.
 *
 *   GAMEPIGEON_MODEL_URL=... GAMEPIGEON_MODEL_API_KEY=... GAMEPIGEON_MODEL_NAME=... \
 *     bun run scripts/measure-worker-latency.ts [--rounds=3] [--out=report.jsonl]
 *
 * Prints one JSON object per worker turn (JSONL). Missing provider metrics
 * (a provider that omits `usage`, or a non-chat response shape) are left
 * absent from that line rather than reported as zero.
 */

import { RestaurantGame } from "../src/games/restaurant-arena/restaurant-game.js";
import { WorkerOrchestrator, type WorkerTurn } from "../src/games/restaurant-arena/worker-orchestrator.js";
import { WorkerModelClient, type ModelCompletionResult, type ModelRequest } from "../src/games/restaurant-arena/worker-client.js";
import type { TraceV3ToolResult } from "../src/games/restaurant-arena/trace.js";

interface ModelConfig {
  url: string;
  key: string;
  name: string;
}

function modelConfig(): ModelConfig | undefined {
  const url = process.env.GAMEPIGEON_MODEL_URL?.trim();
  const key = process.env.GAMEPIGEON_MODEL_API_KEY?.trim();
  const name = process.env.GAMEPIGEON_MODEL_NAME?.trim();
  if (!url || !key || !name) return undefined;
  return { url, key, name };
}

function parseIntFlag(argv: string[], flag: string, fallback: number): number {
  const arg = argv.find((a) => a.startsWith(`${flag}=`));
  const value = arg ? Number(arg.slice(flag.length + 1)) : fallback;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseStringFlag(argv: string[], flag: string): string | undefined {
  const arg = argv.find((a) => a.startsWith(`${flag}=`));
  return arg ? arg.slice(flag.length + 1) : undefined;
}

/** No local admission queue in this script, so every call starts immediately. */
async function complete(config: ModelConfig, request: ModelRequest, signal: AbortSignal): Promise<ModelCompletionResult> {
  const providerStarted = performance.now();
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.name,
      temperature: 0,
      max_tokens: 256,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.turnPrompt },
      ],
    }),
    signal,
  });
  const providerMs = Math.round(performance.now() - providerStarted);
  if (!response.ok) throw new Error(`Model provider returned HTTP ${response.status}.`);
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("The model response did not contain a completion.");
  return {
    text,
    metrics: {
      queueMs: 0,
      providerMs,
      inputTokens: typeof body.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : undefined,
      outputTokens: typeof body.usage?.completion_tokens === "number" ? body.usage.completion_tokens : undefined,
      cachedInputTokens: typeof body.usage?.prompt_tokens_details?.cached_tokens === "number" ? body.usage.prompt_tokens_details.cached_tokens : undefined,
      finishReason: typeof body.choices?.[0]?.finish_reason === "string" ? body.choices[0].finish_reason : undefined,
    },
  };
}

interface ReportLine {
  role?: string;
  queueMs?: number;
  providerMs?: number;
  roundMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  finishReason?: string;
  accepted: boolean;
}

function reportLine(role: string, toolResult: TraceV3ToolResult | null | undefined, accepted: boolean): ReportLine {
  return {
    role,
    queueMs: toolResult?.queueMs,
    providerMs: toolResult?.providerMs,
    roundMs: toolResult?.roundMs,
    inputTokens: toolResult?.inputTokens,
    outputTokens: toolResult?.outputTokens,
    cachedInputTokens: toolResult?.cachedInputTokens,
    finishReason: toolResult?.finishReason,
    accepted,
  };
}

async function main(): Promise<void> {
  const config = modelConfig();
  if (!config) {
    console.error("Set GAMEPIGEON_MODEL_URL, GAMEPIGEON_MODEL_API_KEY, and GAMEPIGEON_MODEL_NAME first.");
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const rounds = parseIntFlag(argv, "--rounds", 3);
  const outPath = parseStringFlag(argv, "--out");

  const game = new RestaurantGame();
  const client = new WorkerModelClient({
    retries: 0,
    timeoutMs: 30_000,
    complete: (request, signal) => complete(config, request, signal),
  });
  const orchestrator = new WorkerOrchestrator(game, { client });

  // One WorkerTurn per role per round -- the orchestrator's own count of
  // turns taken, not a scan of trace events. A rejected action followed by
  // its fallback (or a scope-probe inspection riding along a turn) can add
  // extra role-bearing trace events for the same turn; deriving rows from
  // turns instead keeps this report at exactly one JSONL line per turn.
  const turns: WorkerTurn[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const report = await orchestrator.runTick();
    turns.push(...report.turns);
  }

  // A turn's own action carries the requestId of whichever attempt actually
  // landed (the fallback's, when the model's first attempt was rejected), so
  // this pulls exactly the one trace event that turn produced.
  const events = game.getRecordedEvents();
  const lines = turns.map((turn) => {
    const event = turn.action ? events.find((candidate) => candidate.requestId === turn.action!.requestId) : undefined;
    const accepted = turn.status === "accepted" || turn.status === "fallback";
    return JSON.stringify(reportLine(turn.role, event?.toolResult, accepted));
  });

  for (const line of lines) console.log(line);
  if (outPath) await Bun.write(outPath, `${lines.join("\n")}\n`);
}

await main();
