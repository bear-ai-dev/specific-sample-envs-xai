import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { grade, parseAction, runSpike, type CompanionAction } from "../src/capture/capture-tui-001-spike.js";

type Provider = "openai" | "anthropic" | "gemini" | "nim";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function textResponse(provider: Provider, model: string, prompt: string): Promise<string> {
  if (provider === "openai") {
    const key = requiredEnv("OPENAI_API_KEY");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: prompt, temperature: 0 }),
    });
    const body = await response.json() as { output_text?: string };
    if (!response.ok || !body.output_text) throw new Error(`openai returned HTTP ${response.status}`);
    return body.output_text;
  }

  if (provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": requiredEnv("ANTHROPIC_API_KEY"),
      },
      body: JSON.stringify({ model, max_tokens: 32, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    const body = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = body.content?.find((part) => part.type === "text")?.text;
    if (!response.ok || !text) throw new Error(`anthropic returned HTTP ${response.status}`);
    return text;
  }

  if (provider === "nim") {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredEnv("NVIDIA_API_KEY")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content;
    if (!response.ok || !text) throw new Error(`nim returned HTTP ${response.status}`);
    return text;
  }

  const key = requiredEnv("GEMINI_API_KEY");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
  });
  const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!response.ok || !text) throw new Error(`gemini returned HTTP ${response.status}`);
  return text;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

const provider = required("--provider") as Provider;
if (provider !== "openai" && provider !== "anthropic" && provider !== "gemini" && provider !== "nim") {
  throw new Error("--provider must be openai, anthropic, gemini, or nim");
}

const model = required("--model");
const trials = Number.parseInt(argument("--trials") ?? "20", 10);
const output = required("--output");
const minIntervalMs = Number.parseInt(argument("--min-interval-ms") ?? "1500", 10);
if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) throw new Error("--min-interval-ms must be a non-negative integer");
requiredEnv(provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "gemini" ? "GEMINI_API_KEY" : "NVIDIA_API_KEY");
let lastStartedAt = 0;
const results = await runSpike(async (prompt): Promise<CompanionAction> => {
  const waitMs = Math.max(0, lastStartedAt + minIntervalMs - Date.now());
  if (waitMs) await Bun.sleep(waitMs);
  lastStartedAt = Date.now();
  return parseAction(await textResponse(provider, model, prompt));
}, trials);

mkdirSync(dirname(output), { recursive: true });
appendFileSync(output, `${results.map((result) => JSON.stringify({ provider, model, ...result })).join("\n")}\n`);
console.log(JSON.stringify({ provider, model, trials, minIntervalMs, grade: grade(results) }, null, 2));
